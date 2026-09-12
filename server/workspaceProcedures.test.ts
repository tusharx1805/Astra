import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const databaseRef = vi.hoisted(() => ({ current: null as any }));
vi.mock("./db", () => ({ getDb: async () => databaseRef.current }));

function makeContext(role: "admin" | "developer" | "reviewer" | "user" = "developer"): TrpcContext {
  return {
    user: {
      id: 7,
      openId: "workspace-test-user",
      name: "Workspace Tester",
      email: "tester@example.com",
      loginMethod: "test",
      role,
      organizationId: 11,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function fakeDatabase(selectResults: unknown[], insertIds: number[]) {
  const insertedValues: unknown[] = [];
  const selectQueue = [...selectResults];
  const db = {
    select: vi.fn(() => {
      const builder: any = {
        from: () => builder,
        innerJoin: () => builder,
        where: () => builder,
        limit: async () => selectQueue.shift() ?? [],
      };
      return builder;
    }),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        insertedValues.push(values);
        return Promise.resolve([{ insertId: insertIds.shift() ?? 1 }]);
      }),
    })),
  };
  return { db, insertedValues };
}

describe("ASTRA saved-query workspace procedures", () => {
  it("rejects a developer attempting to create a saved query through the real tRPC procedure", async () => {
    const fake = fakeDatabase([[{ id: 44, name: "Team", organizationId: 11, createdBy: 7, createdAt: new Date(), updatedAt: new Date(), role: "developer" }]], []);
    databaseRef.current = fake.db;
    const caller = appRouter.createCaller(makeContext("developer"));

    await expect(caller.workspace.createSavedQuery({ workspaceId: 44, datasetId: 9, name: "Blocked", sqlText: "SELECT * FROM preview" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fake.db.insert).not.toHaveBeenCalled();
  });

  it("rejects a query run outside the member workspace and audits successful create/run paths", async () => {
    const outside = fakeDatabase([[]], []);
    databaseRef.current = outside.db;
    const caller = appRouter.createCaller(makeContext("developer"));
    await expect(caller.workspace.recordQueryRun({ workspaceId: 999, queryId: 1, rowCount: 1, durationMs: 12 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    const success = fakeDatabase([
      [{ id: 44, name: "Team", organizationId: 11, createdBy: 7, createdAt: new Date(), updatedAt: new Date(), role: "admin" }],
      [{ id: 9, sourceType: "CSV / Files" }],
    ], [501, 9001]);
    databaseRef.current = success.db;
    const adminCaller = appRouter.createCaller(makeContext("admin"));
    await expect(adminCaller.workspace.createSavedQuery({ workspaceId: 44, datasetId: 9, name: "Active customers", sqlText: "SELECT * FROM preview LIMIT 25" }))
      .resolves.toMatchObject({ id: 501 });
    expect(success.insertedValues).toContainEqual(expect.objectContaining({ action: "SAVED_QUERY_CREATED" }));

    const runDb = fakeDatabase([
      [{ id: 44, name: "Team", organizationId: 11, createdBy: 7, createdAt: new Date(), updatedAt: new Date(), role: "developer" }],
      [{ id: 501 }],
    ], [601, 9002]);
    databaseRef.current = runDb.db;
    await expect(caller.workspace.recordQueryRun({ workspaceId: 44, queryId: 501, rowCount: 2, durationMs: 18 }))
      .resolves.toMatchObject({ id: 601 });
    expect(runDb.insertedValues).toContainEqual(expect.objectContaining({ action: "SAVED_QUERY_RUN" }));
  });
});
