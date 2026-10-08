import { describe, expect, it } from "vitest";
import { fromStoredDecision, reviewPolicyViolation, reviewStatus, toStoredDecision } from "./review";
import { mayRecordReview, mayRecordWorkspaceReview } from "../server/reviewPermissions";

describe("review rules", () => {
  it("maps decisions to the reviews.decision enum and back", () => {
    expect(toStoredDecision("CHANGES_REQUESTED")).toBe("changes_requested");
    expect(fromStoredDecision("blocked")).toBe("BLOCKED");
  });
  it("workspace roles allowed to decide: owner, admin, reviewer only", () => {
    expect(["owner", "admin", "reviewer", "developer", "viewer"].map(role => mayRecordWorkspaceReview(role as never))).toEqual([true, true, true, false, false]);
    expect(mayRecordReview("developer")).toBe(false);
  });
  it("policy", () => {
    const base = { level: "SAFE", comment: "", allowSelfApproval: false };
    expect(reviewPolicyViolation({ ...base, decision: "APPROVED", isAuthor: true })).toMatch(/cannot approve/);
    expect(reviewPolicyViolation({ ...base, decision: "APPROVED", isAuthor: true, allowSelfApproval: true })).toBeNull();
    expect(reviewPolicyViolation({ ...base, decision: "BLOCKED", isAuthor: true })).toMatch(/comment/);
    expect(reviewPolicyViolation({ ...base, decision: "BLOCKED", isAuthor: true, comment: "breaks call list" })).toBeNull();
    expect(reviewPolicyViolation({ ...base, decision: "APPROVED", isAuthor: false, level: "HIGH" })).toMatch(/justification/);
    expect(reviewPolicyViolation({ ...base, decision: "APPROVED", isAuthor: false, level: "MEDIUM" })).toBeNull();
  });
  it("status", () => {
    expect(reviewStatus(null, null)).toBe("NOT ANALYSED");
    expect(reviewStatus(3, null)).toBe("PENDING REVIEW");
    expect(reviewStatus(3, { decision: "BLOCKED", reviewedAnalysisId: 2 })).toBe("RE-REVIEW NEEDED");
    expect(reviewStatus(3, { decision: "APPROVED", reviewedAnalysisId: 3 })).toBe("APPROVED");
  });
});
