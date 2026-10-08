import type { Row } from "./transformations";

/**
 * Pure dataset helpers shared by the persisted dataset flow (Phase 1) and the
 * development fixture flow. No I/O happens here so the logic is unit-testable.
 */

export const DATASET_LIMITS = {
  /** Maximum CSV payload accepted by the import procedure (characters). */
  maxCsvChars: 5_000_000,
  maxRows: 20_000,
  maxColumns: 200,
  maxColumnNameLength: 160,
  maxCellLength: 4_000,
} as const;

export type ColumnDataType = "number" | "boolean" | "string";

export type ColumnProfile = {
  name: string;
  dataType: ColumnDataType;
  nullable: boolean;
  uniqueValues: number;
  nullPercent: number;
};

export type ColumnStats = ColumnProfile & {
  nullCount: number;
  distinctCount: number;
  min?: number | null;
  max?: number | null;
  average?: number | null;
  topValues?: Array<[string, number]>;
};

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

function isBlank(value: unknown) {
  return value === null || value === undefined || value === "";
}

/**
 * RFC 4180 style CSV parser: quoted fields, escaped quotes (""), embedded
 * delimiters and newlines inside quotes, CRLF/LF line endings, optional BOM.
 */
export function parseCsvRecords(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let fieldWasQuoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') { field += '"'; index += 1; }
        else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      if (field.length === 0 && !fieldWasQuoted) { inQuotes = true; fieldWasQuoted = true; continue; }
      throw new CsvParseError(`Unexpected quote on line ${records.length + 1}.`);
    }
    if (char === ",") { record.push(field); field = ""; fieldWasQuoted = false; continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = []; field = ""; fieldWasQuoted = false;
      continue;
    }
    if (fieldWasQuoted) throw new CsvParseError(`Unexpected character after closing quote on line ${records.length + 1}.`);
    field += char;
  }
  if (inQuotes) throw new CsvParseError("Unterminated quoted field at end of file.");
  if (field.length > 0 || fieldWasQuoted || record.length > 0) { record.push(field); records.push(record); }
  // Drop fully empty lines (e.g. trailing blank lines).
  return records.filter(item => !(item.length === 1 && item[0] === ""));
}

export type ParsedCsv = { columns: string[]; rows: Row[] };

/** Parse CSV text into header + rows. Empty cells become null. Enforces DATASET_LIMITS. */
export function parseCsvDataset(text: string, limits = DATASET_LIMITS): ParsedCsv {
  if (!text.trim()) throw new CsvParseError("The CSV file is empty.");
  if (text.length > limits.maxCsvChars) throw new CsvParseError(`The CSV file is larger than ${limits.maxCsvChars.toLocaleString()} characters.`);
  const records = parseCsvRecords(text);
  const header = records.shift();
  if (!header || header.every(value => !value.trim())) throw new CsvParseError("The CSV file has no header row.");
  const columns = header.map(value => value.trim());
  if (columns.length > limits.maxColumns) throw new CsvParseError(`The CSV has ${columns.length} columns; the limit is ${limits.maxColumns}.`);
  columns.forEach((name, index) => {
    if (!name) throw new CsvParseError(`Column ${index + 1} has an empty header.`);
    if (name.length > limits.maxColumnNameLength) throw new CsvParseError(`Column "${name.slice(0, 40)}…" is longer than ${limits.maxColumnNameLength} characters.`);
  });
  const seen = new Set<string>();
  columns.forEach(name => {
    const key = name.toLowerCase();
    if (seen.has(key)) throw new CsvParseError(`Duplicate column header "${name}".`);
    seen.add(key);
  });
  if (records.length === 0) throw new CsvParseError("The CSV file has a header but no data rows.");
  if (records.length > limits.maxRows) throw new CsvParseError(`The CSV has ${records.length.toLocaleString()} rows; the limit is ${limits.maxRows.toLocaleString()}.`);
  const rows = records.map((record, recordIndex) => {
    if (record.length !== columns.length) throw new CsvParseError(`Row ${recordIndex + 2} has ${record.length} values but the header has ${columns.length}.`);
    return columns.reduce<Row>((row, name, index) => {
      const raw = record[index] ?? "";
      if (raw.length > limits.maxCellLength) throw new CsvParseError(`Row ${recordIndex + 2}, column "${name}" is longer than ${limits.maxCellLength} characters.`);
      const trimmed = raw.trim();
      row[name] = trimmed === "" ? null : trimmed;
      return row;
    }, {});
  });
  return { columns, rows };
}

/** Infer column metadata. `columnOrder` keeps header order even when a column is entirely null. */
export function inferColumns(rows: Row[], columnOrder?: string[]): ColumnProfile[] {
  const names = columnOrder ?? Array.from(new Set(rows.flatMap(row => Object.keys(row))));
  return names.map(name => {
    const values = rows.map(row => row[name]);
    const nonNull = values.filter(value => !isBlank(value));
    const allNumbers = nonNull.length > 0 && nonNull.every(value => Number.isFinite(Number(value)));
    const allBooleans = nonNull.length > 0 && nonNull.every(value => ["true", "false", "0", "1", true, false].includes(value as never));
    const dataType: ColumnDataType = allNumbers ? "number" : allBooleans ? "boolean" : "string";
    const distinct = new Set(nonNull.map(value => String(value))).size;
    return { name, dataType, nullable: values.some(isBlank), uniqueValues: distinct, nullPercent: rows.length ? Math.round(((rows.length - nonNull.length) / rows.length) * 100) : 0 };
  });
}

/** Column statistics computed directly from row values. */
export function computeColumnStats(rows: Row[], columns: ColumnProfile[]): ColumnStats[] {
  return columns.map(column => {
    const values = rows.map(row => row[column.name]).filter(value => !isBlank(value));
    const nullCount = rows.length - values.length;
    const distinctCount = new Set(values.map(value => String(value))).size;
    if (column.dataType === "number") {
      const numbers = values.map(Number).filter(Number.isFinite);
      return { ...column, nullCount, distinctCount, min: numbers.length ? Math.min(...numbers) : null, max: numbers.length ? Math.max(...numbers) : null, average: numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null };
    }
    const frequencies = new Map<string, number>();
    values.forEach(value => frequencies.set(String(value), (frequencies.get(String(value)) ?? 0) + 1));
    return { ...column, nullCount, distinctCount, topValues: Array.from(frequencies.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5) };
  });
}

/**
 * Completeness = share of non-null cells, 0–100. This is the value stored in
 * datasets.qualityScore for imported datasets; it is a measured property of the
 * rows, not a model prediction.
 */
export function completenessScore(rows: Row[], columns: string[]): number {
  const cells = rows.length * columns.length;
  if (!cells) return 0;
  const filled = rows.reduce((sum, row) => sum + columns.filter(name => !isBlank(row[name])).length, 0);
  return Math.round((filled / cells) * 100);
}
