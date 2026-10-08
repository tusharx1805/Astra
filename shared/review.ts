/**
 * Phase 5 — review decisions. The UI and API use the upper-case names the
 * existing review UI already used; the reviews.decision enum stores lower case.
 */
export const REVIEW_DECISIONS = ["APPROVED", "BLOCKED", "CHANGES_REQUESTED"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export type StoredDecision = "approved" | "blocked" | "changes_requested";

export const toStoredDecision = (decision: ReviewDecision): StoredDecision => decision.toLowerCase() as StoredDecision;
export const fromStoredDecision = (decision: string): ReviewDecision => decision.toUpperCase() as ReviewDecision;

/** Review state of a change, derived from its stored analyses and reviews. */
export type ReviewStatus = "NOT ANALYSED" | "PENDING REVIEW" | "RE-REVIEW NEEDED" | ReviewDecision;

export function reviewStatus(latestAnalysisId: number | null, latestReview: { decision: ReviewDecision; reviewedAnalysisId: number | null } | null): ReviewStatus {
  if (!latestAnalysisId) return "NOT ANALYSED";
  if (!latestReview) return "PENDING REVIEW";
  // A newer analysis exists than the one the latest decision was made against.
  if (latestReview.reviewedAnalysisId !== latestAnalysisId) return "RE-REVIEW NEEDED";
  return latestReview.decision;
}

export const REVIEW_COMMENT_MIN = 5;
export const REVIEW_COMMENT_MAX = 2000;

/** Levels whose approval must carry a written justification. */
export const JUSTIFY_APPROVAL_LEVELS = ["HIGH", "CRITICAL"];

/** Why a decision would be rejected by policy (null = allowed). Shared so the UI can explain before submitting. */
export function reviewPolicyViolation(input: { decision: ReviewDecision; isAuthor: boolean; level: string; comment: string | null | undefined; allowSelfApproval: boolean }): string | null {
  const comment = (input.comment ?? "").trim();
  if (input.decision === "APPROVED" && input.isAuthor && !input.allowSelfApproval) return "You submitted this change, so you cannot approve it. Another reviewer, admin or owner must approve it (you can still block it or request changes).";
  if (input.decision !== "APPROVED" && comment.length < REVIEW_COMMENT_MIN) return `Explain the ${input.decision === "BLOCKED" ? "block" : "requested changes"} in a comment (at least ${REVIEW_COMMENT_MIN} characters).`;
  if (input.decision === "APPROVED" && JUSTIFY_APPROVAL_LEVELS.includes(input.level) && comment.length < REVIEW_COMMENT_MIN) return `Approving a ${input.level} change needs a written justification (at least ${REVIEW_COMMENT_MIN} characters).`;
  return null;
}
