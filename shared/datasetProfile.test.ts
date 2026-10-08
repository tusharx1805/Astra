import { describe, expect, it } from "vitest";
import { completenessScore, computeColumnStats, CsvParseError, inferColumns, parseCsvDataset, parseCsvRecords } from "./datasetProfile";

describe("parseCsvRecords", () => {
  it("handles quoted fields, escaped quotes, embedded commas/newlines, CRLF and BOM", () => {
    const text = "﻿id,note\r\n1,\"hello, world\"\r\n2,\"line one\nline two\"\r\n3,\"she said \"\"hi\"\"\"\r\n";
    expect(parseCsvRecords(text)).toEqual([
      ["id", "note"],
      ["1", "hello, world"],
      ["2", "line one\nline two"],
      ["3", 'she said "hi"'],
    ]);
  });

  it("rejects an unterminated quote", () => {
    expect(() => parseCsvRecords('a,b\n1,"oops')).toThrow(CsvParseError);
  });
});

describe("parseCsvDataset", () => {
  it("returns header order and turns empty cells into null", () => {
    const parsed = parseCsvDataset("customer_id,email,seats\nC-1,,12\nC-2,b@x.com,4\n\n");
    expect(parsed.columns).toEqual(["customer_id", "email", "seats"]);
    expect(parsed.rows).toEqual([{ customer_id: "C-1", email: null, seats: "12" }, { customer_id: "C-2", email: "b@x.com", seats: "4" }]);
  });

  it.each([
    ["", "empty"],
    ["a,b\n", "no data rows"],
    ["a,A\n1,2", "Duplicate column"],
    ["a,,c\n1,2,3", "empty header"],
    ["a,b\n1,2,3", "has 3 values"],
  ])("rejects invalid input %#", (text, message) => {
    expect(() => parseCsvDataset(text)).toThrow(message);
  });

  it("enforces the row limit", () => {
    const text = ["n", ...Array.from({ length: 6 }, (_, index) => String(index))].join("\n");
    expect(() => parseCsvDataset(text, { maxCsvChars: 1000, maxRows: 5, maxColumns: 5, maxColumnNameLength: 10, maxCellLength: 10 })).toThrow("limit is 5");
  });
});

describe("profiling", () => {
  const rows = [{ n: "1", flag: "true", name: "a" }, { n: "3", flag: "false", name: null }, { n: null, flag: "1", name: "a" }];

  it("infers types, nullability and null percentage in header order", () => {
    expect(inferColumns(rows, ["name", "n", "flag"])).toEqual([
      { name: "name", dataType: "string", nullable: true, uniqueValues: 1, nullPercent: 33 },
      { name: "n", dataType: "number", nullable: true, uniqueValues: 2, nullPercent: 33 },
      { name: "flag", dataType: "boolean", nullable: false, uniqueValues: 3, nullPercent: 0 },
    ]);
  });

  it("computes numeric and categorical stats from row values", () => {
    const stats = computeColumnStats(rows, inferColumns(rows, ["n", "name"]));
    expect(stats[0]).toMatchObject({ name: "n", nullCount: 1, min: 1, max: 3, average: 2 });
    expect(stats[1]).toMatchObject({ name: "name", nullCount: 1, topValues: [["a", 2]] });
  });

  it("scores completeness as the share of non-null cells", () => {
    expect(completenessScore(rows, ["n", "flag", "name"])).toBe(78);
    expect(completenessScore([], ["n"])).toBe(0);
  });
});
