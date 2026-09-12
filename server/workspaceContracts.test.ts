import { describe, expect, it } from "vitest";
import { mayCreateSavedQuery, mayRunSavedQuery, WORKSPACE_AUDIT_ACTIONS } from "./workspaceContracts";

describe("workspace saved-query contracts", () => {
  it("gates saved-query creation to owner and admin roles", () => {
    expect(mayCreateSavedQuery("owner")).toBe(true);
    expect(mayCreateSavedQuery("admin")).toBe(true);
    expect(mayCreateSavedQuery("developer")).toBe(false);
    expect(mayCreateSavedQuery("reviewer")).toBe(false);
    expect(mayCreateSavedQuery("viewer")).toBe(false);
  });

  it("allows execution for members and preserves auditable action identifiers", () => {
    expect(mayRunSavedQuery("viewer")).toBe(true);
    expect(WORKSPACE_AUDIT_ACTIONS.savedQueryCreated).toBe("SAVED_QUERY_CREATED");
    expect(WORKSPACE_AUDIT_ACTIONS.savedQueryRun).toBe("SAVED_QUERY_RUN");
    expect(WORKSPACE_AUDIT_ACTIONS.datasetConnected).toBe("DATASET_CONNECTED_VIA_INTEGRATIONS");
  });
});
