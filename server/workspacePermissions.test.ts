import { describe, expect, it } from "vitest";
import { mayAssignWorkspaceRole, mayInviteWorkspaceMember, mayManageMember, mayManageWorkspace, mayReadWorkspace, mayUpdateWorkspaceEnvironment } from "./workspacePermissions";

describe("workspace permissions", () => {
  it("limits workspace management to owners and admins", () => {
    expect(mayManageWorkspace("owner")).toBe(true);
    expect(mayManageWorkspace("admin")).toBe(true);
    expect(mayManageWorkspace("developer")).toBe(false);
    expect(mayManageWorkspace("reviewer")).toBe(false);
    expect(mayManageWorkspace("viewer")).toBe(false);
  });

  it("never permits standard flows to modify an owner or assign ownership", () => {
    expect(mayManageMember("admin", "owner")).toBe(false);
    expect(mayAssignWorkspaceRole("owner", "developer", "owner")).toBe(false);
    expect(mayAssignWorkspaceRole("admin", "reviewer", "admin")).toBe(true);
  });

  it("protects workspace setup and invitation mutations for developer, reviewer, and viewer roles", () => {
    (["developer", "reviewer", "viewer"] as const).forEach(role => {
      expect(mayUpdateWorkspaceEnvironment(role)).toBe(false);
      expect(mayInviteWorkspaceMember(role)).toBe(false);
      expect(mayAssignWorkspaceRole(role, "viewer", "admin")).toBe(false);
      expect(mayManageMember(role, "developer")).toBe(false);
    });
    expect(mayUpdateWorkspaceEnvironment("owner")).toBe(true);
    expect(mayInviteWorkspaceMember("admin")).toBe(true);
  });

  it("requires a verified membership scope before loading a workspace", () => {
    expect(mayReadWorkspace(44, [12, 44, 77])).toBe(true);
    expect(mayReadWorkspace(45, [12, 44, 77])).toBe(false);
  });
});
