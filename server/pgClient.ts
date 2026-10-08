import dns from "node:dns/promises";
import net from "node:net";
import postgres from "postgres";
import { CONNECTOR_LIMITS, normalizeSourceRows, normalizeSourceValue, SourceShapeError, type ConnectionTarget, type SourceColumn, type SourceObject } from "../shared/pgConnector";
import type { Row } from "../shared/transformations";

/**
 * Phase 9 — the ONLY code that opens sockets to external PostgreSQL servers.
 *
 * Safety boundary (defence in depth):
 *  1. Network: the host is resolved once, every address is checked against a block
 *     list (loopback, private, link-local/metadata, multicast…), and the socket is
 *     pinned to the checked address so DNS cannot be re-bound between check and use.
 *  2. Transport: plaintext is only allowed to private-network hosts (dev mode).
 *  3. Session: every statement runs inside BEGIN READ ONLY with a statement timeout.
 *  4. Statements: fixed catalog queries with bound parameters; the only dynamic SQL is
 *     `SELECT * FROM <schema>.<table>`, where the object was first looked up in the live
 *     catalog (existence + SELECT privilege) and is then escaped as identifiers.
 *     Users never supply SQL text.
 *  5. Lifetime: one connection per request, closed in `finally`. No pool is kept.
 */

export class BlockedHostError extends Error {
  code = "BLOCKED_HOST";
  constructor(message: string) {
    super(message);
    this.name = "BlockedHostError";
  }
}

/** Addresses that are never reachable, even in development (metadata services, unspecified, multicast). */
const ALWAYS_BLOCKED = new net.BlockList();
ALWAYS_BLOCKED.addSubnet("0.0.0.0", 8, "ipv4");
ALWAYS_BLOCKED.addSubnet("169.254.0.0", 16, "ipv4");
ALWAYS_BLOCKED.addSubnet("224.0.0.0", 4, "ipv4");
ALWAYS_BLOCKED.addSubnet("240.0.0.0", 4, "ipv4");
ALWAYS_BLOCKED.addAddress("::", "ipv6");
ALWAYS_BLOCKED.addSubnet("fe80::", 10, "ipv6");
ALWAYS_BLOCKED.addSubnet("ff00::", 8, "ipv6");

/** Private / internal ranges: blocked unless ASTRA_CONNECTOR_ALLOW_PRIVATE_NETWORK=true. */
const PRIVATE = new net.BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.0.0.0", 24, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("198.18.0.0", 15, "ipv4");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");

export function privateNetworkAllowed() {
  return process.env.ASTRA_CONNECTOR_ALLOW_PRIVATE_NETWORK === "true";
}

/** IPv4-mapped IPv6 (::ffff:10.0.0.1) is judged by its IPv4 address. */
function unmap(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1] : address;
}

export type AddressClass = "public" | "private" | "blocked";

export function classifyAddress(raw: string): AddressClass {
  const address = unmap(raw);
  const family = net.isIP(address);
  if (!family) return "blocked";
  const type = family === 4 ? "ipv4" : "ipv6";
  if (ALWAYS_BLOCKED.check(address, type)) return "blocked";
  if (PRIVATE.check(address, type)) return "private";
  return "public";
}

export type ResolvedTarget = { address: string; family: 4 | 6; private: boolean };

/** Resolve the host and apply the network policy to EVERY address it resolves to. */
export async function resolveTarget(host: string, sslMode: ConnectionTarget["sslMode"], lookup: (host: string) => Promise<Array<{ address: string; family: number }>> = h => dns.lookup(h, { all: true, verbatim: true })): Promise<ResolvedTarget> {
  const literal = net.isIP(host);
  const addresses = literal ? [{ address: host, family: literal }] : await lookup(host);
  if (!addresses.length) throw Object.assign(new Error("No addresses"), { code: "ENOTFOUND" });
  const classes = addresses.map(entry => classifyAddress(entry.address));
  if (classes.includes("blocked")) throw new BlockedHostError("This host resolves to an address Astra never connects to (link-local, metadata, multicast or unspecified).");
  const isPrivate = classes.includes("private");
  if (isPrivate && !privateNetworkAllowed()) throw new BlockedHostError("This host resolves to a private or loopback address. Connections to internal networks are disabled on this Astra server.");
  if (sslMode === "disable" && !(isPrivate && classes.every(value => value === "private"))) throw new BlockedHostError("Unencrypted connections are only allowed to private-network hosts. Choose an encrypted SSL mode.");
  const first = addresses[0];
  return { address: unmap(first.address), family: (net.isIP(unmap(first.address)) === 6 ? 6 : 4), private: isPrivate };
}

/** Raw text for date/time types (no timezone guessing); everything else uses postgres-js defaults with array parsing off. */
const RAW_TEXT_TYPES = [1082, 1083, 1114, 1184, 1266, 1186];

function openClient(target: ConnectionTarget, resolved: ResolvedTarget) {
  const ssl = target.sslMode === "disable"
    ? false
    : { rejectUnauthorized: target.sslMode === "verify-full", servername: net.isIP(target.host) ? undefined : target.host };
  return postgres({
    host: resolved.address,
    port: target.port,
    database: target.databaseName,
    username: target.username,
    password: target.password,
    ssl,
    max: 1,
    prepare: false, // works through transaction-mode poolers (e.g. Supabase :6543)
    fetch_types: false, // no extra type-discovery query; arrays arrive as text
    connect_timeout: CONNECTOR_LIMITS.connectTimeoutSeconds,
    idle_timeout: 5,
    max_lifetime: 60,
    onnotice: () => undefined,
    connection: { application_name: "astra-readonly-connector" },
    types: { rawtext: { to: 25, from: RAW_TEXT_TYPES, serialize: (value: unknown) => String(value), parse: (value: string) => value } },
  });
}

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

/** Open → BEGIN READ ONLY → work → COMMIT → close. The connection never outlives the call. */
export async function withReadOnlySource<T>(target: ConnectionTarget, work: (tx: Tx) => Promise<T>, lookup?: Parameters<typeof resolveTarget>[2]): Promise<T> {
  const resolved = await resolveTarget(target.host, target.sslMode, lookup);
  const sql = openClient(target, resolved);
  // statement_timeout is enforced by the REMOTE server, which Astra does not trust:
  // this local deadline closes the socket no matter what the other side does.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      sql.end({ timeout: 0 }).catch(() => undefined);
      reject(Object.assign(new Error("Source operation timed out"), { code: "OPERATION_TIMEOUT" }));
    }, CONNECTOR_LIMITS.operationTimeoutMs);
  });
  try {
    const session = sql.begin("read only", async tx => {
      await tx.unsafe(`set local statement_timeout = ${Number(CONNECTOR_LIMITS.statementTimeoutMs)}`);
      await tx.unsafe("set local idle_in_transaction_session_timeout = 30000");
      await tx.unsafe("set local timezone = 'UTC'");
      return work(tx);
    });
    session.catch(() => undefined); // the deadline may win; never leave a rejection unhandled
    return (await Promise.race([session, deadline])) as T;
  } finally {
    clearTimeout(timer);
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

const USER_SCHEMAS = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'`;

export type ProbeResult = {
  serverVersion: string;
  currentUser: string;
  database: string;
  superuser: boolean;
  writableTables: number;
  readableObjects: number;
  readOnlyEnforced: boolean;
};

/** A real round trip: authenticates, reads server facts, and measures what this role could write. */
export async function probeSource(target: ConnectionTarget, lookup?: Parameters<typeof resolveTarget>[2]): Promise<ProbeResult> {
  return withReadOnlySource(target, async tx => {
    const [facts] = await tx.unsafe(`
      select current_setting('server_version') as server_version, current_user as current_user, current_database() as database,
        coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
        current_setting('transaction_read_only') = 'on' as read_only`);
    const [counts] = await tx.unsafe(`
      select
        count(*) filter (where c.relkind in ('r','p') and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE') or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE')))::int as writable,
        count(*) filter (where has_schema_privilege(n.oid, 'USAGE') and has_table_privilege(c.oid, 'SELECT'))::int as readable
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p','v','m','f') and ${USER_SCHEMAS}`);
    return {
      serverVersion: String(facts.server_version),
      currentUser: String(facts.current_user),
      database: String(facts.database),
      superuser: Boolean(facts.superuser),
      writableTables: Number(counts.writable),
      readableObjects: Number(counts.readable),
      readOnlyEnforced: Boolean(facts.read_only),
    };
  }, lookup);
}

const KIND: Record<string, SourceObject["kind"]> = { r: "table", p: "table", v: "view", m: "materialized view", f: "foreign table" };

/** Live catalog: every table/view this role can SELECT from. */
export async function listSourceObjects(target: ConnectionTarget, lookup?: Parameters<typeof resolveTarget>[2]): Promise<{ objects: SourceObject[]; truncated: boolean }> {
  return withReadOnlySource(target, async tx => {
    const rows = await tx.unsafe(`
      select n.nspname as schema, c.relname as name, c.relkind as relkind,
        case when c.reltuples < 0 then null else c.reltuples::bigint end as estimated_rows,
        (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)::int as column_count
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p','v','m','f') and ${USER_SCHEMAS}
        and has_schema_privilege(n.oid, 'USAGE') and has_table_privilege(c.oid, 'SELECT')
      order by n.nspname, c.relname
      limit $1`, [CONNECTOR_LIMITS.maxBrowseObjects + 1]);
    const objects = rows.slice(0, CONNECTOR_LIMITS.maxBrowseObjects).map(row => ({
      schema: String(row.schema),
      name: String(row.name),
      kind: KIND[String(row.relkind)] ?? "table",
      estimatedRows: row.estimated_rows === null ? null : Number(row.estimated_rows),
      columnCount: Number(row.column_count),
    }));
    return { objects, truncated: rows.length > CONNECTOR_LIMITS.maxBrowseObjects };
  }, lookup);
}

/** Catalog gate: the object must exist AND be readable by this role. Returns its oid, kind and columns. */
async function describeObject(tx: Tx, schema: string, table: string) {
  const [object] = await tx.unsafe(`
    select c.oid::int as oid, c.relkind as relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and c.relname = $2 and c.relkind in ('r','p','v','m','f') and ${USER_SCHEMAS}
      and has_schema_privilege(n.oid, 'USAGE') and has_table_privilege(c.oid, 'SELECT')`, [schema, table]);
  if (!object) throw Object.assign(new Error("Object not found or not readable"), { code: "42P01" });
  const columns = await tx.unsafe(`
    select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
      coalesce(array_position(i.indkey::int2[], a.attnum) - array_lower(i.indkey::int2[], 1) + 1, 0) as pk_position
    from pg_attribute a
    left join pg_index i on i.indrelid = a.attrelid and i.indisprimary
    where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped
    order by a.attnum`, [object.oid]);
  const described: SourceColumn[] = columns.map(column => ({ name: String(column.name), type: String(column.type), nullable: Boolean(column.nullable), primaryKey: Number(column.pk_position) > 0 }));
  const primaryKey = columns.filter(column => Number(column.pk_position) > 0).sort((a, b) => Number(a.pk_position) - Number(b.pk_position)).map(column => String(column.name));
  return { kind: KIND[String(object.relkind)] ?? "table", columns: described, primaryKey };
}

function orderClause(tx: Tx, primaryKey: string[]) {
  return primaryKey.length ? tx`order by ${tx(primaryKey)}` : tx``;
}

export async function previewSourceObject(target: ConnectionTarget, schema: string, table: string, lookup?: Parameters<typeof resolveTarget>[2]) {
  return withReadOnlySource(target, async tx => {
    const described = await describeObject(tx, schema, table);
    const result = await tx`select * from ${tx(schema)}.${tx(table)} ${orderClause(tx, described.primaryKey)} limit ${CONNECTOR_LIMITS.previewRows}`;
    const names = described.columns.map(column => column.name);
    const rows = result.map(raw => Object.fromEntries(names.map(name => {
      const value = normalizeSourceValue(raw[name]);
      return [name, value !== null && value.length > 200 ? `${value.slice(0, 200)}…` : value];
    })));
    return { ...described, rows };
  }, lookup);
}

export type SourceSnapshot = { kind: SourceObject["kind"]; columns: string[]; sourceColumns: SourceColumn[]; primaryKey: string[]; rows: Row[] };

/** Read an entire (bounded) table/view. Refuses — never truncates — anything over the import limits. */
export async function readSourceObject(target: ConnectionTarget, schema: string, table: string, lookup?: Parameters<typeof resolveTarget>[2]): Promise<SourceSnapshot> {
  return withReadOnlySource(target, async tx => {
    const described = await describeObject(tx, schema, table);
    const names = described.columns.map(column => column.name);
    // Stream in batches and stop as soon as a limit is crossed, instead of buffering an unbounded result.
    const collected: Array<Record<string, unknown>> = [];
    let approxChars = 0;
    await tx`select * from ${tx(schema)}.${tx(table)} ${orderClause(tx, described.primaryKey)} limit ${CONNECTOR_LIMITS.maxImportRows + 1}`
      .cursor(CONNECTOR_LIMITS.fetchBatchRows, rows => {
        for (const row of rows) {
          collected.push(row as Record<string, unknown>);
          for (const name of names) {
            const value = (row as Record<string, unknown>)[name];
            approxChars += value === null || value === undefined ? 0 : typeof value === "string" ? value.length : String(normalizeSourceValue(value) ?? "").length;
          }
        }
        if (collected.length > CONNECTOR_LIMITS.maxImportRows) throw new SourceShapeError(`The source has more than ${CONNECTOR_LIMITS.maxImportRows.toLocaleString()} rows. Import a filtered view instead — Astra does not silently import a partial table.`);
        if (approxChars > CONNECTOR_LIMITS.maxPayloadChars) throw new SourceShapeError(`The source data is larger than ${CONNECTOR_LIMITS.maxPayloadChars.toLocaleString()} characters. Import a filtered view instead.`);
      });
    const normalized = normalizeSourceRows(names, collected);
    return { kind: described.kind, columns: normalized.columns, sourceColumns: described.columns, primaryKey: described.primaryKey, rows: normalized.rows };
  }, lookup);
}
