import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const listWorkspacesForUser = vi.hoisted(() => vi.fn());
vi.mock("./workspaceDb", async () => {
  const actual = await vi.importActual<typeof import("./workspaceDb")>("./workspaceDb");
  return { ...actual, listWorkspacesForUser };
});

function context(): TrpcContext {
  return {
    user: { id: 7, openId: "fixture-user", name: "Fixture User", email: "fixture@example.com", loginMethod: "test", role: "developer", organizationId: 11, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as TrpcContext["user"],
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("fixture workspace procedure authorization", () => {
  it("allows a member to list fixture datasets", async () => {
    listWorkspacesForUser.mockResolvedValue([{ id: 1 }]);
    const result = await appRouter.createCaller(context()).workspace.fixtureDatasets({ workspaceId: 1 });
    expect(result[0]).toMatchObject({ id: 7001, sourceType: "CSV / Files" });
  });

  it("rejects a non-member before returning fixture data", async () => {
    listWorkspacesForUser.mockResolvedValue([{ id: 1 }]);
    await expect(appRouter.createCaller(context()).workspace.fixtureDatasets({ workspaceId: 999 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
