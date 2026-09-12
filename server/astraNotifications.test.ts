import { describe, expect, it, vi } from "vitest";
import { notifyAnalysisComplete, notifyReviewChanged } from "./astraNotifications";
import { mockRiskEngine } from "./mockRiskEngine";

describe("ASTRA owner notifications", () => {
  it("notifies the owner when simulated risk analysis completes", async () => {
    const notify = vi.fn().mockResolvedValue(true);
    const analysis = mockRiskEngine({ title: "Customer migration", changeType: "SQL", source: "ALTER TABLE customers ALTER COLUMN customer_id TYPE VARCHAR;" });

    await expect(notifyAnalysisComplete(notify, "Customer migration", analysis)).resolves.toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "ASTRA simulated risk analysis: CRITICAL 87/100" }));
  });

  it("returns false without throwing when an owner notification channel is unavailable", async () => {
    const notify = vi.fn().mockResolvedValue(false);
    await expect(notifyReviewChanged(notify, {
      changeId: "RA-DEMO87",
      decision: "BLOCKED",
      reviewerId: 4,
      reviewerName: "Avery Singh",
      riskLevel: "CRITICAL",
      createdAt: 1724670000000,
    })).resolves.toBe(false);
  });
});
