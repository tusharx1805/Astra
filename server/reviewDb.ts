import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { changes, reviews, riskAnalyses } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { fetchProfiles } from "./_core/supabaseProfiles";
import { notifyOwner } from "./_core/notification";
import { notifyReviewChanged, withinNotificationBudget } from "./astraNotifications";
import { fromStoredDecision, reviewPolicyViolation, reviewStatus, toStoredDecision, type ReviewDecision } from "../shared/review";
import type { RiskLevel } from "../shared/changeRisk";
import { audit, extractInsertId, getWorkspaceContext, type Database } from "./workspaceDb";
import { ALLOW_SELF_APPROVAL, mayRecordWorkspaceReview } from "./reviewPermissions";
import { mayReadChanges, REVIEW_AUDIT_ACTIONS } from "./workspaceContracts";

/**
 * Phase 5 — Real Reviews. Source of truth: the existing reviews table
 * (organization_id, change_id, reviewer_id, decision, comment, created_at).
 *
 * Tie to the risk context without a schema change: a decision is only accepted
 * against the change's LATEST analysis (the client says which analysis it is
 * looking at; a newer one → CONFLICT), and review + re-analysis both lock the
 * change row, so "the analysis a review was made against" is exactly the latest
 * analysis created before the review. Both rows take created_at = clock_timestamp()
 * AFTER the lock is held, so the ordering is exact even under concurrency.
 * The analysis id is also written to audit_logs.
 * The in-memory reviewStore is no longer on any production path.
 */

type Workspace = { id: number; organizationId: number };
export type ReviewView = { id: number; changeId: number; decision: ReviewDecision; comment: string | null; reviewerId: string | null; reviewer: string; createdAt: Date; reviewedAnalysisId: number | null; reviewedLevel: RiskLevel | null; reviewedScore: number | null };

async function nameResolver(accessToken: string | null, user: User, ids: Array<string | null>) {
  const profiles = await fetchProfiles(accessToken, Array.from(new Set(ids.filter((id): id is string => Boolean(id))))).catch(() => new Map());
  return (id: string | null) => (!id ? "Deleted user" : id === user.id ? "You" : profiles.get(id) ? `@${profiles.get(id)!.username}` : "Workspace member");
}

/** Reviews for a set of changes, each resolved to the analysis it was made against. Newest first. */
export async function loadReviews(db: Database, user: User, changeIds: number[], accessToken: string | null = null): Promise<ReviewView[]> {
  if (!changeIds.length) return [];
  const [rows, analyses] = await Promise.all([
    db.select().from(reviews).where(inArray(reviews.changeId, changeIds)).orderBy(desc(reviews.id)),
    db.select({ id: riskAnalyses.id, changeId: riskAnalyses.changeId, level: riskAnalyses.level, score: riskAnalyses.score, createdAt: riskAnalyses.createdAt }).from(riskAnalyses).where(inArray(riskAnalyses.changeId, changeIds)).orderBy(desc(riskAnalyses.id)),
  ]);
  const name = await nameResolver(accessToken, user, rows.map(row => row.reviewerId));
  return rows.map(row => {
    const reviewed = analyses.find(item => item.changeId === row.changeId && item.createdAt.getTime() <= row.createdAt.getTime()) ?? null;
    return { id: row.id, changeId: row.changeId, decision: fromStoredDecision(row.decision), comment: row.comment, reviewerId: row.reviewerId, reviewer: name(row.reviewerId), createdAt: row.createdAt, reviewedAnalysisId: reviewed?.id ?? null, reviewedLevel: (reviewed?.level as RiskLevel) ?? null, reviewedScore: reviewed?.score ?? null };
  });
}

/** Current review state per change id (for list views). */
export async function reviewStates(db: Database, user: User, changeIds: number[]) {
  const [all, analyses] = await Promise.all([
    loadReviews(db, user, changeIds),
    changeIds.length ? db.select({ id: riskAnalyses.id, changeId: riskAnalyses.changeId }).from(riskAnalyses).where(inArray(riskAnalyses.changeId, changeIds)).orderBy(desc(riskAnalyses.id)) : Promise.resolve([]),
  ]);
  return new Map(changeIds.map(changeId => {
    const latestAnalysis = analyses.find(item => item.changeId === changeId)?.id ?? null;
    const latestReview = all.find(item => item.changeId === changeId) ?? null;
    return [changeId, { status: reviewStatus(latestAnalysis, latestReview), latestReview, reviewCount: all.filter(item => item.changeId === changeId).length }];
  }));
}

export async function recordChangeReview(user: User, input: { workspaceId: number; changeId: number; analysisId: number; decision: ReviewDecision; comment?: string | null }, accessToken: string | null = null) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, input.workspaceId);
  // Server-side authorization, independent of what the UI shows.
  if (!mayRecordWorkspaceReview(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only the workspace owner, admins and reviewers can record review decisions." });
  const comment = input.comment?.trim() || null;

  const reviewId = await db.transaction(async tx => {
    const tdb = tx as unknown as Database;
    // Lock the change: serialises against re-analysis and concurrent reviews.
    const [change] = await tx.select({ id: changes.id, authorId: changes.authorId, title: changes.title }).from(changes)
      .where(and(eq(changes.id, input.changeId), eq(changes.workspaceId, workspace.id))).for("update");
    if (!change) throw new TRPCError({ code: "NOT_FOUND", message: "Change not found in the active workspace." });
    const [latest] = await tx.select({ id: riskAnalyses.id, level: riskAnalyses.level, score: riskAnalyses.score }).from(riskAnalyses)
      .where(eq(riskAnalyses.changeId, change.id)).orderBy(desc(riskAnalyses.id)).limit(1);
    if (!latest) throw new TRPCError({ code: "BAD_REQUEST", message: "This change has no risk analysis to review yet." });
    if (latest.id !== input.analysisId) throw new TRPCError({ code: "CONFLICT", message: `A newer analysis (#${latest.id}) exists for this change. Review the latest analysis.` });
    const violation = reviewPolicyViolation({ decision: input.decision, isAuthor: change.authorId === user.id, level: latest.level, comment, allowSelfApproval: ALLOW_SELF_APPROVAL });
    if (violation) throw new TRPCError({ code: change.authorId === user.id && input.decision === "APPROVED" ? "FORBIDDEN" : "BAD_REQUEST", message: violation });
    const id = extractInsertId(await tx.insert(reviews).values({ organizationId: workspace.organizationId, changeId: change.id, reviewerId: user.id, decision: toStoredDecision(input.decision), comment, createdAt: sql`clock_timestamp()` }).returning({ id: reviews.id }));
    await audit(tdb, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: REVIEW_AUDIT_ACTIONS.recorded, resourceType: "change", resourceId: String(change.id), metadata: { reviewId: id, decision: input.decision, analysisId: latest.id, level: latest.level, score: latest.score } });
    return id;
  });

  // Read back from the database (a mutation response alone is not proof of persistence).
  const [stored] = (await loadReviews(db, user, [input.changeId], accessToken)).filter(item => item.id === reviewId);
  if (!stored) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The review could not be read back after saving." });
  const notificationDispatched = await withinNotificationBudget(notifyReviewChanged(notifyOwner, { changeId: `change #${input.changeId}`, decision: input.decision, comment: stored.comment ?? undefined, reviewerId: user.id, reviewerName: user.name ?? "Astra reviewer", riskLevel: (stored.reviewedLevel ?? "SAFE") as never, createdAt: stored.createdAt.getTime() }));
  return { ...stored, notificationDispatched };
}

/** All review decisions in the workspace, newest first (review history page). */
export async function listWorkspaceReviews(user: User, workspaceId: number, accessToken: string | null = null) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadChanges(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read reviews in this workspace." });
  const changeRows = await db.select({ id: changes.id, title: changes.title }).from(changes).where(eq(changes.workspaceId, workspace.id)).orderBy(desc(changes.id)).limit(500);
  const titles = new Map(changeRows.map(row => [row.id, row.title]));
  return (await loadReviews(db, user, changeRows.map(row => row.id), accessToken)).slice(0, 200).map(review => ({ ...review, changeTitle: titles.get(review.changeId) ?? "" }));
}

export type { Workspace };
