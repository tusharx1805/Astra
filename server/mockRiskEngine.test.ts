import { describe, expect, it } from "vitest";
import { mockRiskEngine } from "./mockRiskEngine";

describe("mockRiskEngine", () => {
  it("returns a deterministic critical result for the ASTRA demo migration", () => {
    const input = {
      title: "Widen customer identifier",
      changeType: "SQL" as const,
      source: "ALTER TABLE customers ALTER COLUMN customer_id TYPE VARCHAR;",
    };

    const first = mockRiskEngine(input);
    const second = mockRiskEngine(input);

    expect(first).toMatchObject({ score: 87, level: "CRITICAL", simulated: true });
    expect(first.id).toBe(second.id);
    expect(first.affectedEntities).toHaveLength(4);
  });

  it("does not execute source and classifies a simple config change below critical", () => {
    const result = mockRiskEngine({
      title: "Adjust schedule",
      changeType: "CONFIG",
      source: "schedule: 0 3 * * *",
    });

    expect(result.score).toBeLessThan(80);
    expect(result.explanation[2]).toContain("not executed");
  });
});
