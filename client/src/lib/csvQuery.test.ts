import { describe, expect, it } from "vitest";
import { executeCsvPreview } from "./csvQuery";

describe("executeCsvPreview", () => {
  const csv = "email,status\na@company.com,active\nb@company.com,paused";

  it("runs the supported SELECT preview patterns and reports rows", () => {
    expect(executeCsvPreview("SELECT * FROM preview LIMIT 1", csv).rows).toHaveLength(1);
    expect(executeCsvPreview("SELECT COUNT(*) FROM preview", csv).rows[0]).toEqual({ count: "2" });
    expect(executeCsvPreview("SELECT * FROM preview WHERE status = 'active'", csv).rows).toHaveLength(1);
  });

  it("rejects write operations and unsupported query shapes", () => {
    expect(() => executeCsvPreview("DELETE FROM preview", csv)).toThrow("read-only SELECT");
    expect(() => executeCsvPreview("SELECT email FROM preview", csv)).toThrow("supports SELECT * FROM preview");
  });
});
