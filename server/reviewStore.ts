import type { RiskLevel } from "./mockRiskEngine";

export type ReviewDecision = "APPROVED" | "BLOCKED" | "CHANGES_REQUESTED";

export type ReviewRecord = {
  changeId: string;
  decision: ReviewDecision;
  comment?: string;
  reviewerId: number;
  reviewerName: string;
  riskLevel: RiskLevel;
  createdAt: number;
};

const reviewRecords = new Map<string, ReviewRecord[]>();

export function recordReview(record: ReviewRecord) {
  const current = reviewRecords.get(record.changeId) ?? [];
  reviewRecords.set(record.changeId, [...current, record]);
  return record;
}

export function listReviews(changeId: string) {
  return reviewRecords.get(changeId) ?? [];
}
