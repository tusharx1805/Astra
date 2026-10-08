import { describe, expect, it } from "vitest";
import { mayRecordReview } from "./reviewPermissions";

describe("mayRecordReview", () => {
  it("permits reviewer and administrator decisions only", () => {
    expect(mayRecordReview("admin")).toBe(true);
    expect(mayRecordReview("reviewer")).toBe(true);
    expect(mayRecordReview("developer")).toBe(false);
  });
});
