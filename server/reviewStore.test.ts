import { describe, expect, it } from "vitest";
import { listReviews, recordReview } from "./reviewStore";

describe("reviewStore", () => {
  it("records an audit-ready review decision by change identifier", () => {
    const record = recordReview({
      changeId: "RA-TEST",
      decision: "BLOCKED",
      reviewerId: 5,
      reviewerName: "Avery Singh",
      riskLevel: "CRITICAL",
      createdAt: 1724670000000,
    });

    expect(record.decision).toBe("BLOCKED");
    expect(listReviews("RA-TEST")).toContainEqual(record);
  });
});
