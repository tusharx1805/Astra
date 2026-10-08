import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

/** Phase 6 checkpoint tests against a REAL Supabase-shaped Postgres. Skipped unless TEST_DATABASE_URL is set. */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CSV = "customer_id,email,plan,seats,active,region\nC-1001,ada@example.com,pro,12,true,Mumbai\nC-1002,ben@example.com,starter,4,true,Nashik\nC-1003,,pro,8,false,Pune\nC-1004,\"drew, jr@example.com\",enterprise,41,true,Mumbai\nC-1005,esha@example.com,pro,15,true,\n";

describe.skipIf(!url)("Phase 6 — lineage from persisted relationships (real database)", async () => {
  const { appRouter } = await import("./routers");
  const dbModule = await import("./db");
  const { randomUUID } = await import("node:crypto");
  const schema = await import("../drizzle/schema");
  type Ctx = TrpcContext;
  const users: Record<string, NonNullable<Ctx["user"]>> = {};
  const caller = (key: string) => appRouter.createCaller({ user: users[key]!, req: { protocol: "https", headers: {} } as Ctx["req"], res: {} as Ctx["res"] });
  let ws = 0, wsB = 0, outsiderWs = 0, a = 0, other = 0, reader = 0;

  beforeAll(async () => {
    const db = (await dbModule.getDb())!;
    for (const key of ["owner", "viewer", "outsider"]) {
      const user = { id: randomUUID(), email: `${key}-p6-${suffix}@example.com`, name: key, role: "developer" as const };
      await db.execute(sql`insert into auth.users (id, email, raw_user_meta_data) values (${user.id}, ${user.email}, ${JSON.stringify({ username: `p6${key}_${suffix}`.replace(/[^a-z0-9_]/g, "_").slice(0, 30), full_name: key })}::jsonb)`);
      users[key] = user;
    }
    ws = (await caller("owner").workspace.create({ name: `P6 A ${suffix}` })).id;
    wsB = (await caller("owner").workspace.create({ name: `P6 B ${suffix}` })).id;
    outsiderWs = (await caller("outsider").workspace.create({ name: `P6 O ${suffix}` })).id;
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: users.viewer!.id, role: "viewer" });
    a = (await caller("owner").dataset.importCsv({ workspaceId: ws, name: "dataset_a", csvText: CSV })).id;
    other = (await caller("owner").dataset.importCsv({ workspaceId: ws, name: "other", csvText: CSV })).id;
    await caller("owner").dataset.importCsv({ workspaceId: wsB, name: "b_only", csvText: CSV });
  });

  let pipelineId = 0, outputId = 0, runId = 0;

  it("Dataset A → Pipeline → Dataset B appears once the pipeline has run", async () => {
    pipelineId = (await caller("owner").pipeline.create({ workspaceId: ws, name: "a to b", sourceDatasetId: a, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "active", operator: "equals", value: "true" }] })).id;
    let graph = await caller("owner").lineage.graph({ workspaceId: ws });
    expect(graph.edges.map(edge => edge.id)).toEqual([`reads:${a}->${pipelineId}`]);
    const run = await caller("owner").pipeline.run({ workspaceId: ws, pipelineId });
    runId = run.id; outputId = run.log.output!.datasetId;
    graph = await caller("owner").lineage.graph({ workspaceId: ws });
    expect(graph.edges.map(edge => [edge.source, edge.kind, edge.target])).toEqual(expect.arrayContaining([[`dataset:${a}`, "reads", `pipeline:${pipelineId}`], [`pipeline:${pipelineId}`, "produced", `dataset:${outputId}`]]));
    expect(graph.edges.find(edge => edge.kind === "produced")).toMatchObject({ observed: true, label: `run #${runId}` });
    expect(graph.nodes.find(node => node.id === `dataset:${outputId}`)).toMatchObject({ derived: true });
    expect(graph.positions[`dataset:${a}`]!.x).toBeLessThan(graph.positions[`dataset:${outputId}`]!.x);
    // Same graph on a second read (refresh).
    expect(await caller("owner").lineage.graph({ workspaceId: ws })).toEqual(graph);
  });

  it("an overwrite pipeline links to its destination; a downstream reader extends the chain; focus shows up/downstream", async () => {
    const writer = (await caller("owner").pipeline.create({ workspaceId: ws, name: "refresh other", sourceDatasetId: outputId, destinationMode: "overwrite_existing", destinationDatasetId: other, steps: [] })).id;
    reader = (await caller("owner").pipeline.create({ workspaceId: ws, name: "reads other", sourceDatasetId: other, destinationMode: "new_dataset", steps: [] })).id;
    let graph = await caller("owner").lineage.graph({ workspaceId: ws });
    expect(graph.edges.find(edge => edge.id === `overwrites:${writer}->${other}`)).toMatchObject({ declared: true, observed: false });
    await caller("owner").pipeline.run({ workspaceId: ws, pipelineId: writer });
    graph = await caller("owner").lineage.graph({ workspaceId: ws });
    expect(graph.edges.find(edge => edge.id === `overwrites:${writer}->${other}`)).toMatchObject({ declared: true, observed: true });
    const focus = await caller("owner").lineage.graph({ workspaceId: ws, focus: `dataset:${other}` });
    expect(focus.upstream.sort()).toEqual([`dataset:${a}`, `dataset:${outputId}`, `pipeline:${pipelineId}`, `pipeline:${writer}`].sort());
    expect(focus.downstream).toEqual([`pipeline:${reader}`]);
  });

  it("changing a relationship changes the graph (no stale edges)", async () => {
    const current = await caller("owner").pipeline.get({ workspaceId: ws, pipelineId: reader });
    await caller("owner").pipeline.update({ workspaceId: ws, pipelineId: reader, baseVersion: current.version, name: "reads other", sourceDatasetId: a, destinationMode: "new_dataset", steps: [] });
    const graph = await caller("owner").lineage.graph({ workspaceId: ws });
    expect(graph.edges.some(edge => edge.id === `reads:${other}->${reader}`)).toBe(false);
    expect(graph.edges.some(edge => edge.id === `reads:${a}->${reader}`)).toBe(true);
  });

  it("is workspace-scoped and read-only for viewers", async () => {
    const b = await caller("owner").lineage.graph({ workspaceId: wsB });
    expect(b.nodes.map(node => node.label)).toEqual(["b_only"]);
    expect(b.edges).toEqual([]);
    await expect(caller("owner").lineage.graph({ workspaceId: wsB, focus: `dataset:${a}` })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller("viewer").lineage.graph({ workspaceId: ws })).resolves.toMatchObject({ counts: { pipelines: 3 } });
    await expect(caller("outsider").lineage.graph({ workspaceId: ws })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await caller("outsider").lineage.graph({ workspaceId: outsiderWs })).nodes).toEqual([]);
  });
});
