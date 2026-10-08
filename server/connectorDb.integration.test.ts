import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

/**
 * Phase 9 checkpoint tests: a REAL Astra database (TEST_DATABASE_URL, Phase 9 migration applied)
 * plus a REAL external PostgreSQL source (TEST_SOURCE_*). The source needs:
 *   - a read-only role (TEST_SOURCE_READER / TEST_SOURCE_READER_PASSWORD) with SELECT on public.customers,
 *     public."Mixed Case", sales.orders, sales.paid_orders and NOT on public.secrets_table;
 *   - a writer role (TEST_SOURCE_WRITER / TEST_SOURCE_WRITER_PASSWORD) used only by the test to change the source.
 * Skipped unless both are configured.
 */
const url = process.env.TEST_DATABASE_URL;
const source = {
  host: process.env.TEST_SOURCE_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_SOURCE_PORT ?? 5432),
  databaseName: process.env.TEST_SOURCE_DB ?? "",
  reader: process.env.TEST_SOURCE_READER ?? "",
  readerPassword: process.env.TEST_SOURCE_READER_PASSWORD ?? "",
  writer: process.env.TEST_SOURCE_WRITER ?? "",
  writerPassword: process.env.TEST_SOURCE_WRITER_PASSWORD ?? "",
};
const configured = Boolean(url && source.databaseName && source.reader && source.writer);
if (url) process.env.DATABASE_URL = url;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const KEY = "phase9-test-encryption-key-please-rotate";

describe.skipIf(!configured)("Phase 9 — external PostgreSQL, read-only (real databases)", async () => {
  process.env.CONNECTION_ENCRYPTION_KEY = KEY;
  const { appRouter } = await import("./routers");
  const dbModule = await import("./db");
  const { randomUUID } = await import("node:crypto");
  const schema = await import("../drizzle/schema");
  const postgres = (await import("postgres")).default;
  const { withReadOnlySource } = await import("./pgClient");
  type Ctx = TrpcContext;
  const users: Record<string, NonNullable<Ctx["user"]>> = {};
  const caller = (key: string) => appRouter.createCaller({ user: users[key]!, req: { protocol: "https", headers: {} } as Ctx["req"], res: {} as Ctx["res"] });
  const db = async () => (await dbModule.getDb())!;
  const owner = () => caller("owner");
  const writerSql = postgres({ host: source.host, port: source.port, database: source.databaseName, username: source.writer, password: source.writerPassword, ssl: "require", max: 1, onnotice: () => undefined });
  const reader = { host: source.host, port: source.port, databaseName: source.databaseName, username: source.reader, password: source.readerPassword, sslMode: "require" as const };
  const tempTable = `p9_temp_${suffix.replace(/\D/g, "").slice(-8)}`;
  let ws = 0, otherWs = 0, connectionId = 0, customersId = 0;

  beforeAll(async () => {
    for (const key of ["owner", "developer", "viewer", "outsider"]) {
      const user = { id: randomUUID(), email: `${key}-p9-${suffix}@example.com`, name: key, role: "developer" as const };
      await (await db()).execute(sql`insert into auth.users (id, email, raw_user_meta_data) values (${user.id}, ${user.email}, ${JSON.stringify({ username: `p9${key}_${suffix}`.replace(/[^a-z0-9_]/g, "_").slice(0, 30), full_name: key })}::jsonb)`);
      users[key] = user;
    }
    ws = (await owner().workspace.create({ name: `P9 A ${suffix}` })).id;
    otherWs = (await caller("outsider").workspace.create({ name: `P9 O ${suffix}` })).id;
    await (await db()).insert(schema.workspaceMembers).values([{ workspaceId: ws, userId: users.developer!.id, role: "developer" }, { workspaceId: ws, userId: users.viewer!.id, role: "viewer" }]);
    // Reset the parts of the source this suite changes.
    await writerSql.unsafe(`delete from public.customers where customer_id > 250`);
    await writerSql.unsafe(`alter table public.customers drop column if exists loyalty_tier`);
  });

  it("network policy: private/loopback hosts are refused unless the server explicitly allows them; metadata IPs are always refused", async () => {
    delete process.env.ASTRA_CONNECTOR_ALLOW_PRIVATE_NETWORK;
    const blocked = await owner().connector.testDraft({ workspaceId: ws, ...reader, host: "127.0.0.1" });
    expect(blocked).toMatchObject({ ok: false, failure: { kind: "blocked_host", message: expect.stringMatching(/private or loopback/) } });
    process.env.ASTRA_CONNECTOR_ALLOW_PRIVATE_NETWORK = "true";
    const metadata = await owner().connector.testDraft({ workspaceId: ws, ...reader, host: "169.254.169.254" });
    expect(metadata).toMatchObject({ ok: false, failure: { kind: "blocked_host", message: expect.stringMatching(/never connects/) } });
    await expect(owner().connector.testDraft({ workspaceId: ws, ...reader, host: "db.example.com/evil" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("connection test succeeds only when a real connection succeeds, and reports what the role could write", async () => {
    const good = await owner().connector.testDraft({ workspaceId: ws, ...reader });
    expect(good.ok).toBe(true);
    if (!good.ok) throw new Error("expected ok");
    expect(good.probe).toMatchObject({ currentUser: source.reader, database: source.databaseName, superuser: false, writableTables: 0, readOnlyEnforced: true, readableObjects: 4 });
    expect(good.warnings).toEqual([]);
    const writer = await owner().connector.testDraft({ workspaceId: ws, ...reader, username: source.writer, password: source.writerPassword });
    expect(writer.ok && writer.warnings[0]).toMatch(/can write to \d+ tables/);
    const failures = await Promise.all([
      owner().connector.testDraft({ workspaceId: ws, ...reader, password: "definitely-wrong-password" }),
      owner().connector.testDraft({ workspaceId: ws, ...reader, databaseName: "no_such_db_p9" }),
      owner().connector.testDraft({ workspaceId: ws, ...reader, port: 5999 }),
      owner().connector.testDraft({ workspaceId: ws, ...reader, sslMode: "verify-full" }),
      owner().connector.testDraft({ workspaceId: ws, ...reader, host: "no-such-host.invalid" }),
    ]);
    expect(failures.map(result => (result.ok ? "ok" : result.failure.kind))).toEqual(["auth", "database", "refused", "tls", "dns"]);
    expect(JSON.stringify(failures)).not.toContain("definitely-wrong-password");
    const audits = await (await db()).select().from(schema.auditLogs).where(and(eq(schema.auditLogs.workspaceId, ws), eq(schema.auditLogs.action, "PG_CONNECTION_DRAFT_TESTED")));
    expect(audits.length).toBeGreaterThanOrEqual(7);
    expect(audits.filter(row => row.result === "failure").length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(audits)).not.toMatch(/definitely-wrong-password|reader-pass|writer-pass/);
  });

  it("credentials are stored only after a successful test, only encrypted, and never returned", async () => {
    const saved = process.env.CONNECTION_ENCRYPTION_KEY;
    delete process.env.CONNECTION_ENCRYPTION_KEY;
    await expect(owner().connector.create({ workspaceId: ws, name: "CRM replica", ...reader })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    process.env.CONNECTION_ENCRYPTION_KEY = saved;
    await expect(owner().connector.create({ workspaceId: ws, name: "CRM replica", ...reader, password: "wrong-password-p9" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/Not saved.*Password authentication failed/) });
    expect(await (await db()).select().from(schema.datasetConnections).where(eq(schema.datasetConnections.workspaceId, ws))).toHaveLength(0);
    await expect(caller("developer").connector.create({ workspaceId: ws, name: "CRM replica", ...reader })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const created = await owner().connector.create({ workspaceId: ws, name: "CRM replica", ...reader });
    connectionId = created.id;
    expect(JSON.stringify(created)).not.toContain(source.readerPassword);
    const [row] = await (await db()).select().from(schema.datasetConnections).where(eq(schema.datasetConnections.id, connectionId));
    expect(row!.encryptedPassword.startsWith("astra:v1.")).toBe(true);
    expect(row!.encryptedPassword).not.toContain(source.readerPassword);
    await expect(owner().connector.create({ workspaceId: ws, name: "crm REPLICA", ...reader })).rejects.toMatchObject({ code: "CONFLICT" });
    const list = await owner().connector.list({ workspaceId: ws });
    expect(list.connections).toHaveLength(1);
    expect(list.connections[0]).toMatchObject({ id: connectionId, name: "CRM replica", host: reader.host, username: source.reader, sslMode: "require", lastTest: { meta: { ok: true } } });
    expect(JSON.stringify(list)).not.toMatch(new RegExp(`${source.readerPassword}|astra:v1|encryptedPassword`));
  });

  it("authorization: developers use saved connections, viewers cannot, other workspaces see NOT_FOUND", async () => {
    await expect(caller("developer").connector.list({ workspaceId: ws })).resolves.toMatchObject({ canManage: false });
    await expect(caller("developer").connector.testDraft({ workspaceId: ws, ...reader })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("developer").connector.remove({ workspaceId: ws, connectionId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("viewer").connector.list({ workspaceId: ws })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("viewer").connector.browse({ workspaceId: ws, connectionId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("outsider").connector.browse({ workspaceId: ws, connectionId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("outsider").connector.browse({ workspaceId: otherWs, connectionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller("outsider").connector.importObject({ workspaceId: otherWs, connectionId, schema: "public", table: "customers", datasetName: "stolen" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("table browsing reads the live catalog: it changes when the source changes, and hides what the role cannot read", async () => {
    const before = await caller("developer").connector.browse({ workspaceId: ws, connectionId });
    expect(before.objects.map(object => `${object.schema}.${object.name}:${object.kind}`)).toEqual(["public.Mixed Case:table", "public.customers:table", "sales.orders:table", "sales.paid_orders:view"]);
    await writerSql.unsafe(`create table public.${tempTable} (id int primary key)`);
    await writerSql.unsafe(`grant select on public.${tempTable} to ${source.reader}`);
    const during = await caller("developer").connector.browse({ workspaceId: ws, connectionId });
    expect(during.objects.map(object => object.name)).toContain(tempTable);
    await writerSql.unsafe(`drop table public.${tempTable}`);
    const after = await caller("developer").connector.browse({ workspaceId: ws, connectionId });
    expect(after.objects.map(object => object.name)).not.toContain(tempTable);
    expect(after.objects.map(object => object.name)).not.toContain("secrets_table");
    const preview = await caller("developer").connector.preview({ workspaceId: ws, connectionId, schema: "public", table: "customers" });
    expect(preview.primaryKey).toEqual(["customer_id"]);
    expect(preview.rows).toHaveLength(20);
    expect(preview.rows[0]).toMatchObject({ customer_id: "1", full_name: "Customer 1", signed_up: "2024-01-02", updated_at: "2025-05-01 05:30:00+00", profile: '{"tier":1}' });
  });

  it("import creates a real Astra dataset through the Phase 1 path, with provenance, readable back from the database", async () => {
    const imported = await caller("developer").connector.importObject({ workspaceId: ws, connectionId, schema: "public", table: "customers", datasetName: "crm_customers" });
    customersId = imported.id;
    expect(imported).toMatchObject({ name: "crm_customers", rowCount: 250, columnCount: 10, sourceType: "PostgreSQL", object: "public.customers", orderedBy: ["customer_id"] });
    const dataset = await owner().dataset.get({ workspaceId: ws, datasetId: customersId });
    expect(dataset.columns.map(column => `${column.name}:${column.dataType}`)).toEqual(["customer_id:number", "full_name:string", "email:string", "country:string", "lifetime_value:number", "is_active:boolean", "signed_up:string", "updated_at:string", "tags:string", "profile:string"]);
    const rows = await owner().dataset.rows({ workspaceId: ws, datasetId: customersId, offset: 0, limit: 500 });
    const truth = await writerSql.unsafe(`select c.customer_id::text as customer_id, c.email, c.lifetime_value::text as lifetime_value from public.customers c order by c.customer_id::int`);
    expect(rows.total).toBe(truth.length);
    expect(rows.rows.map(row => [row.data.customer_id, row.data.email, row.data.lifetime_value])).toEqual(truth.map(row => [row.customer_id, row.email, row.lifetime_value]));
    const source = await owner().connector.datasetSource({ workspaceId: ws, datasetId: customersId });
    expect(source).toMatchObject({ available: true, connectionId, connectionName: "CRM replica", schema: "public", table: "customers", syncCount: 1, lastSyncRows: 250 });
    const attempts = await (await db()).select().from(schema.ingestionAttempts).where(and(eq(schema.ingestionAttempts.workspaceId, ws), eq(schema.ingestionAttempts.datasetName, "crm_customers")));
    expect(attempts.map(attempt => [attempt.status, attempt.sourceType, attempt.rowsIngested])).toEqual([["complete", "PostgreSQL", 250]]);
    await expect(owner().connector.importObject({ workspaceId: ws, connectionId, schema: "public", table: "customers", datasetName: "crm_customers" })).rejects.toMatchObject({ code: "CONFLICT" });
    const view = await owner().connector.importObject({ workspaceId: ws, connectionId, schema: "sales", table: "paid_orders", datasetName: "paid_orders" });
    expect(view.rowCount).toBe(400);
    const mixed = await owner().connector.importObject({ workspaceId: ws, connectionId, schema: "public", table: "Mixed Case", datasetName: "mixed_case" });
    expect(mixed).toMatchObject({ rowCount: 2, object: 'public."Mixed Case"' });
  });

  it("the imported dataset behaves like any Astra dataset: pipelines run on it", async () => {
    const pipeline = await owner().pipeline.create({ workspaceId: ws, name: "active IN customers", sourceDatasetId: customersId, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "country", operator: "equals", value: "IN" }] as never });
    const run = await owner().pipeline.run({ workspaceId: ws, pipelineId: pipeline.id });
    expect(run.status).toBe("success");
    expect(run.log.output?.rowCount).toBe(62);
  });

  it("failures are explicit: unreadable objects are refused, logged as failed ingestion, and create nothing", async () => {
    await expect(owner().connector.importObject({ workspaceId: ws, connectionId, schema: "public", table: "secrets_table", datasetName: "secrets" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(owner().connector.importObject({ workspaceId: ws, connectionId, schema: "public", table: "customers; drop table public.customers", datasetName: "inject" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const found = await (await db()).select().from(schema.datasets).where(and(eq(schema.datasets.workspaceId, ws), eq(schema.datasets.name, "secrets")));
    expect(found).toHaveLength(0);
    const failed = await (await db()).select().from(schema.ingestionAttempts).where(and(eq(schema.ingestionAttempts.workspaceId, ws), eq(schema.ingestionAttempts.status, "failed")));
    expect(failed.map(attempt => attempt.datasetName).sort()).toEqual(["inject", "secrets"]); // (the oversize test below adds "too_big")
    expect((await writerSql.unsafe(`select count(*)::int as n from public.customers`))[0]!.n).toBe(250);
  });

  it("oversized sources are refused while streaming, never partially imported", async () => {
    await writerSql.unsafe(`drop table if exists public.p9_big`);
    await writerSql.unsafe(`create table public.p9_big as select g as id from generate_series(1, 20001) g`);
    await writerSql.unsafe(`grant select on public.p9_big to ${source.reader}`);
    await expect(owner().connector.importObject({ workspaceId: ws, connectionId, schema: "public", table: "p9_big", datasetName: "too_big" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/more than 20,000 rows/) });
    expect(await (await db()).select().from(schema.datasets).where(and(eq(schema.datasets.workspaceId, ws), eq(schema.datasets.name, "too_big")))).toHaveLength(0);
    await writerSql.unsafe(`drop table public.p9_big`);
  });

  it("every source session is READ ONLY: even a role that can write cannot write through Astra's client", async () => {
    const writerTarget = { ...reader, username: source.writer, password: source.writerPassword };
    await expect(withReadOnlySource(writerTarget, tx => tx.unsafe(`insert into public.customers (customer_id, full_name) values (999999, 'should not exist')`))).rejects.toMatchObject({ code: "25006" });
    expect((await writerSql.unsafe(`select count(*)::int as n from public.customers where customer_id = 999999`))[0]!.n).toBe(0);
  });

  it("refresh re-reads the source: new rows and columns arrive, quality checks re-run with trigger 'sync'", async () => {
    await owner().quality.createCheck({ workspaceId: ws, datasetId: customersId, severity: "warning", definition: { checkType: "row_count", columnName: null, config: { max: 250 } } });
    await writerSql.unsafe(`alter table public.customers add column loyalty_tier text`);
    await writerSql.unsafe(`insert into public.customers (customer_id, full_name, country, loyalty_tier) values (251, 'Customer 251', 'IN', 'gold')`);
    const refreshed = await caller("developer").connector.refreshDataset({ workspaceId: ws, datasetId: customersId });
    expect(refreshed).toMatchObject({ rowsBefore: 250, rowsAfter: 251, columnsAdded: ["loyalty_tier"], columnsRemoved: [] });
    expect(refreshed.checks.map(check => check.status)).toEqual(["fail"]);
    const [check] = await owner().quality.checks({ workspaceId: ws, datasetId: customersId });
    expect(check!.latest).toMatchObject({ status: "fail", trigger: "sync" });
    const rows = await owner().dataset.rows({ workspaceId: ws, datasetId: customersId, offset: 250, limit: 5 });
    expect(rows.rows[0]!.data).toMatchObject({ customer_id: "251", loyalty_tier: "gold" });
    const provenance = await owner().connector.datasetSource({ workspaceId: ws, datasetId: customersId });
    expect(provenance).toMatchObject({ syncCount: 2, lastSyncRows: 251 });
    await expect(caller("viewer").connector.refreshDataset({ workspaceId: ws, datasetId: customersId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a changed encryption key and a removed connection fail clearly instead of pretending", async () => {
    process.env.CONNECTION_ENCRYPTION_KEY = "a-different-key";
    await expect(owner().connector.browse({ workspaceId: ws, connectionId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    process.env.CONNECTION_ENCRYPTION_KEY = KEY;
    const retest = await owner().connector.test({ workspaceId: ws, connectionId });
    expect(retest.ok).toBe(true);
    await owner().connector.remove({ workspaceId: ws, connectionId });
    await expect(owner().connector.refreshDataset({ workspaceId: ws, datasetId: customersId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const dataset = await owner().dataset.get({ workspaceId: ws, datasetId: customersId });
    expect(dataset.rowCount).toBe(251); // the data stays; only the ability to refresh is gone
    await writerSql.unsafe(`delete from public.customers where customer_id > 250`);
    await writerSql.unsafe(`alter table public.customers drop column if exists loyalty_tier`);
    await writerSql.end();
  });
});
