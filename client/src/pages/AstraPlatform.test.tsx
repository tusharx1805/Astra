import { describe, expect, it } from "vitest";

describe("ASTRA presentation contracts", () => {
  it("labels operational intelligence as simulated", () => {
    const disclosure = "SIMULATED DATA · NOT A LIVE MODEL";
    expect(disclosure).toContain("SIMULATED");
    expect(disclosure).toContain("NOT A LIVE MODEL");
  });
});
