import { z } from "zod";
import { DATASET_LIMITS } from "./datasetProfile";
import type { Row } from "./transformations";

/**
 * Phase 9 — External PostgreSQL (read-only).
 * Pure rules shared by server and client: what a connection may look like,
 * how source values become Astra row values, and how driver errors become
 * user-facing messages that never contain credentials.
 */

export const PG_SOURCE_TYPE = "PostgreSQL";

export const SSL_MODES = ["verify-full", "require", "disable"] as const;
export type SslMode = (typeof SSL_MODES)[number];

export const SSL_MODE_LABEL: Record<SslMode, string> = {
  "verify-full": "Encrypted + certificate verified",
  require: "Encrypted, certificate not verified",
  disable: "No encryption (private network only)",
};

export const CONNECTOR_LIMITS = {
  connectTimeoutSeconds: 10,
  statementTimeoutMs: 15_000,
  /** Hard ceiling for a whole source operation, enforced by Astra (not by the remote server). */
  operationTimeoutMs: 60_000,
  /** Rows fetched per round trip while importing, so size limits trip early. */
  fetchBatchRows: 500,
  maxBrowseObjects: 1_000,
  previewRows: 20,
  /** Import is bounded by the same limits as a CSV import (Phase 1). */
  maxImportRows: DATASET_LIMITS.maxRows,
  maxColumns: DATASET_LIMITS.maxColumns,
  maxCellLength: DATASET_LIMITS.maxCellLength,
  maxPayloadChars: DATASET_LIMITS.maxCsvChars,
} as const;

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
const IPV6_LITERAL = /^[0-9A-Fa-f:.]+$/;

export const connectionTargetSchema = z.object({
  host: z.string().trim().min(1).max(253).refine(value => HOSTNAME.test(value) || (value.includes(":") && IPV6_LITERAL.test(value)), "Enter a hostname or IP address only — no scheme, path, port or credentials."),
  port: z.number().int().min(1).max(65535),
  databaseName: z.string().trim().min(1).max(160).refine(value => !/[\0\s]/.test(value), "Database names cannot contain spaces or control characters."),
  username: z.string().trim().min(1).max(160).refine(value => !/[\0\s]/.test(value), "Usernames cannot contain spaces or control characters."),
  password: z.string().min(1, "A password is required.").max(512),
  sslMode: z.enum(SSL_MODES),
});
export type ConnectionTarget = z.infer<typeof connectionTargetSchema>;

export const connectionCreateSchema = connectionTargetSchema.extend({
  name: z.string().trim().min(3).max(160).regex(/^[\w .()-]+$/, "Use letters, numbers, spaces, dots, dashes, brackets or underscores."),
});

/** Postgres identifiers as they come back from the catalog (<= 63 bytes, but allow a margin). */
export const sourceObjectSchema = z.object({ schema: z.string().min(1).max(128), table: z.string().min(1).max(128) });

export function qualifiedName(schema: string, table: string) {
  const quote = (value: string) => (/^[a-z_][a-z0-9_$]*$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`);
  return `${quote(schema)}.${quote(table)}`;
}

export function suggestDatasetName(schema: string, table: string) {
  const base = (schema === "public" ? table : `${schema}_${table}`).replace(/[^\w .-]+/g, "_").replace(/_+/g, "_").replace(/^[_ .-]+|[_ .-]+$/g, "");
  return (base.length >= 2 ? base : `pg_${base || "table"}`).slice(0, 160);
}

/** Source value → Astra row value. Astra rows hold strings/null (like a CSV import) so every downstream consumer sees one shape. */
export function normalizeSourceValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof Uint8Array !== "undefined" && value instanceof Uint8Array) {
    return `\\x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return JSON.stringify(value);
}

export class SourceShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceShapeError";
  }
}

/**
 * Validate the shape of a source table and convert its rows. Mirrors the CSV import
 * limits so an imported table can do everything a CSV dataset can — and nothing is
 * silently truncated: anything over a limit is refused with a precise reason.
 */
export function normalizeSourceRows(columns: string[], rawRows: Array<Record<string, unknown>>, limits = CONNECTOR_LIMITS): { columns: string[]; rows: Row[] } {
  if (!columns.length) throw new SourceShapeError("The source object has no columns.");
  if (columns.length > limits.maxColumns) throw new SourceShapeError(`The source has ${columns.length} columns; the limit is ${limits.maxColumns}. Import a view that selects fewer columns.`);
  const seen = new Map<string, string>();
  columns.forEach(name => {
    if (name.length > DATASET_LIMITS.maxColumnNameLength) throw new SourceShapeError(`Column "${name.slice(0, 40)}…" is longer than ${DATASET_LIMITS.maxColumnNameLength} characters.`);
    const clash = seen.get(name.toLowerCase());
    if (clash) throw new SourceShapeError(`Columns "${clash}" and "${name}" differ only by case, which Astra datasets do not support. Import a view that renames one.`);
    seen.set(name.toLowerCase(), name);
  });
  if (!rawRows.length) throw new SourceShapeError("The source object has no rows to import.");
  if (rawRows.length > limits.maxImportRows) throw new SourceShapeError(`The source has more than ${limits.maxImportRows.toLocaleString()} rows. Import a filtered view instead — Astra does not silently import a partial table.`);
  let payload = 0;
  const rows = rawRows.map((raw, index) => {
    const row: Row = {};
    for (const name of columns) {
      const value = normalizeSourceValue(raw[name]);
      if (value !== null) {
        if (value.length > limits.maxCellLength) throw new SourceShapeError(`Row ${index + 1}, column "${name}" is ${value.length.toLocaleString()} characters; the limit is ${limits.maxCellLength.toLocaleString()}. Import a view that shortens or excludes it.`);
        payload += value.length;
      }
      row[name] = value;
    }
    return row;
  });
  if (payload > limits.maxPayloadChars) throw new SourceShapeError(`The source data is ${payload.toLocaleString()} characters; the limit is ${limits.maxPayloadChars.toLocaleString()}. Import a filtered view instead.`);
  return { columns, rows };
}

export type ConnectorFailureKind =
  | "blocked_host" | "dns" | "refused" | "timeout" | "unreachable" | "tls" | "auth" | "database"
  | "permission" | "not_found" | "read_only" | "statement_timeout" | "server" | "shape" | "config" | "unknown";

export type ConnectorFailure = { kind: ConnectorFailureKind; message: string };

const TLS_CODES = new Set(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_SSL_WRONG_VERSION_NUMBER", "EPROTO"]);

/** Map a driver/network error to a stable, credential-free message. `secrets` are scrubbed from any passthrough text. */
export function describeConnectorError(error: unknown, secrets: string[] = []): ConnectorFailure {
  const err = error as { code?: string; message?: string; name?: string } | undefined;
  const code = err?.code ?? "";
  const scrub = (text: string) => secrets.filter(secret => secret && secret.length >= 3).reduce((out, secret) => out.split(secret).join("•••"), text).slice(0, 240);
  if (err?.name === "SourceShapeError") return { kind: "shape", message: scrub(err.message ?? "") };
  if (code === "BLOCKED_HOST") return { kind: "blocked_host", message: scrub(err?.message ?? "This host is not allowed.") };
  switch (code) {
    case "ENOTFOUND": case "EAI_AGAIN": return { kind: "dns", message: "The host name could not be resolved. Check the host for typos." };
    case "ECONNREFUSED": return { kind: "refused", message: "The server refused the connection. Check the host and port, and that PostgreSQL accepts remote connections." };
    case "OPERATION_TIMEOUT": return { kind: "timeout", message: `The source operation took longer than ${CONNECTOR_LIMITS.operationTimeoutMs / 1000} seconds and was stopped.` };
    case "CONNECT_TIMEOUT": case "ETIMEDOUT": return { kind: "timeout", message: `No response within ${CONNECTOR_LIMITS.connectTimeoutSeconds} seconds. Check the host, port and any firewall / IP allow-list.` };
    case "EHOSTUNREACH": case "ENETUNREACH": return { kind: "unreachable", message: "The host is not reachable from the Astra server." };
    case "ECONNRESET": return { kind: "unreachable", message: "The server closed the connection during setup. If SSL is disabled on the server, it cannot be used with an encrypted mode." };
    case "28P01": return { kind: "auth", message: "Password authentication failed for this user." };
    case "28000": return { kind: "auth", message: "The server rejected this user from this address (pg_hba / allow-list), or the user does not exist." };
    case "3D000": return { kind: "database", message: "The database does not exist on this server." };
    case "42501": return { kind: "permission", message: "This user does not have permission to read that object." };
    case "42P01": return { kind: "not_found", message: "That table or view does not exist in the source, or this user is not allowed to read it." };
    case "25006": return { kind: "read_only", message: "The source rejected a write: Astra only reads from external databases." };
    case "57014": return { kind: "statement_timeout", message: `The source query took longer than ${CONNECTOR_LIMITS.statementTimeoutMs / 1000} seconds and was cancelled. Import a smaller view.` };
    case "53300": return { kind: "server", message: "The source server has no free connection slots." };
  }
  if (TLS_CODES.has(code) || /certificate|self[- ]signed|SSL|TLS/i.test(err?.message ?? "")) {
    return { kind: "tls", message: "The TLS/SSL handshake failed (certificate not trusted, wrong host name, or SSL unsupported). Try mode “Encrypted, certificate not verified” only if you trust the network path." };
  }
  if (/^[0-9A-Z]{5}$/.test(code)) return { kind: "server", message: scrub(`The source returned error ${code}: ${err?.message ?? "unknown error"}`) };
  return { kind: "unknown", message: "The connection failed for an unknown reason. Details were logged on the server." };
}

export type SourceObject = { schema: string; name: string; kind: "table" | "view" | "materialized view" | "foreign table"; estimatedRows: number | null; columnCount: number };
export type SourceColumn = { name: string; type: string; nullable: boolean; primaryKey: boolean };
