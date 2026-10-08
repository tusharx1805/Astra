import { describe, expect, it } from "vitest";
import { getAstraRouteKind } from "./astraRoutes";
import { getNextSelectedIndex } from "./searchProvider";

describe("ASTRA navigation contracts", () => {
  it("classifies every required module route family", () => {
    expect(getAstraRouteKind("/datasets/connections")).toBe("dataset");
    expect(getAstraRouteKind("/pipelines/runs")).toBe("pipeline");
    expect(getAstraRouteKind("/changes/history")).toBe("changes");
    expect(getAstraRouteKind("/risk-analysis/history")).toBe("risk");
    expect(getAstraRouteKind("/monitoring/anomalies")).toBe("monitoring");
    expect(getAstraRouteKind("/reports/exports")).toBe("reports");
  });

  it("keeps keyboard selection bounded to visible result count", () => {
    expect(getNextSelectedIndex(0, "previous", 3)).toBe(0);
    expect(getNextSelectedIndex(1, "next", 3)).toBe(2);
    expect(getNextSelectedIndex(2, "next", 3)).toBe(2);
    expect(getNextSelectedIndex(0, "next", 0)).toBe(0);
  });
});
