import { describe, expect, it } from "vitest";
import { connectionCreateSchema, connectionTargetSchema, describeConnectorError, normalizeSourceRows, normalizeSourceValue, qualifiedName, SourceShapeError, suggestDatasetName } from "./pgConnector";

const base = { host: "db.example.com", port: 5432, databaseName: "analytics", username: "astra_reader", password: "s3cret-pass", sslMode: "verify-full" as const };

describe("Phase 9 connection input rules", () => {
  it("accepts hostnames and IPs only — no URLs, paths, credentials or ports in the host", () => {
    expect(connectionTargetSchema.safeParse(base).success).toBe(true);
    expect(connectionTargetSchema.safeParse({ ...base, host: "10.0.0.5" }).success).toBe(true);
    expect(connectionTargetSchema.safeParse({ ...base, host: "2001:db8::1" }).success).toBe(true);
    for (const host of ["postgres://db.example.com", "db.example.com/x", "user@db.example.com", "db.example.com:5432", "db example.com", "-bad.example.com"]) {
      expect(connectionTargetSchema.safeParse({ ...base, host }).success, host).toBe(false);
    }
    expect(connectionTargetSchema.safeParse({ ...base, sslMode: "prefer" }).success).toBe(false);
    expect(connectionTargetSchema.safeParse({ ...base, password: "" }).success).toBe(false);
    expect(connectionCreateSchema.safeParse({ ...base, name: "CRM (replica)" }).success).toBe(true);
    expect(connectionCreateSchema.safeParse({ ...base, name: "x" }).success).toBe(false);
  });

  it("quotes identifiers only when needed and suggests safe dataset names", () => {
    expect(qualifiedName("public", "customers")).toBe("public.customers");
    expect(qualifiedName("public", 'Mixed "Case"')).toBe('public."Mixed ""Case"""');
    expect(suggestDatasetName("public", "customers")).toBe("customers");
    expect(suggestDatasetName("sales", "Paid Orders!")).toBe("sales_Paid Orders");
  });
});

describe("Phase 9 source values", () => {
  it("normalizes every source type to the string/null shape a CSV import produces", () => {
    expect(normalizeSourceValue(null)).toBeNull();
    expect(normalizeSourceValue(12)).toBe("12");
    expect(normalizeSourceValue(true)).toBe("true");
    expect(normalizeSourceValue(new Date("2025-01-02T03:04:05Z"))).toBe("2025-01-02T03:04:05.000Z");
    expect(normalizeSourceValue({ tier: 1 })).toBe('{"tier":1}');
    expect(normalizeSourceValue(Buffer.from([0xde, 0xad]))).toBe("\\xdead");
  });

  it("refuses — never truncates — sources over the Phase 1 limits", () => {
    const limits = { maxImportRows: 2, maxColumns: 2, maxCellLength: 5, maxPayloadChars: 12 } as never;
    expect(() => normalizeSourceRows(["a"], [{ a: 1 }, { a: 2 }, { a: 3 }], limits)).toThrow(/more than 2 rows/);
    expect(() => normalizeSourceRows(["a", "b", "c"], [{ a: 1 }], limits)).toThrow(/3 columns/);
    expect(() => normalizeSourceRows(["a"], [{ a: "toolong" }], limits)).toThrow(/limit is 5/);
    expect(() => normalizeSourceRows(["a", "b"], [{ a: "12345", b: "12345" }, { a: "123", b: null }], limits)).toThrow(/13 characters/);
    expect(() => normalizeSourceRows(["Name", "name"], [{ Name: 1, name: 2 }])).toThrow(SourceShapeError);
    expect(() => normalizeSourceRows(["a"], [])).toThrow(/no rows/);
    expect(normalizeSourceRows(["a", "b"], [{ a: 1, b: null }])).toEqual({ columns: ["a", "b"], rows: [{ a: "1", b: null }] });
  });
});

describe("Phase 9 error messages", () => {
  it("maps driver and network errors to stable kinds and never echoes the password", () => {
    const cases: Array<[unknown, string]> = [
      [{ code: "28P01", message: "password authentication failed for user x" }, "auth"],
      [{ code: "3D000" }, "database"],
      [{ code: "ECONNREFUSED" }, "refused"],
      [{ code: "CONNECT_TIMEOUT" }, "timeout"],
      [{ code: "ENOTFOUND" }, "dns"],
      [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "tls"],
      [{ code: "25006" }, "read_only"],
      [{ code: "57014" }, "statement_timeout"],
      [{ code: "BLOCKED_HOST", message: "private" }, "blocked_host"],
      [new Error("boom"), "unknown"],
    ];
    cases.forEach(([error, kind]) => expect(describeConnectorError(error).kind).toBe(kind));
    const leaked = describeConnectorError({ code: "XX000", message: "internal error near s3cret-pass" }, ["s3cret-pass"]);
    expect(leaked.kind).toBe("server");
    expect(leaked.message).not.toContain("s3cret-pass");
  });
});
