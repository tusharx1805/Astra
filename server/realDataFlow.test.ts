import { describe, expect, it } from "vitest";
import { browsePostgresTables, createFixturePipeline, getFixtureDashboardMetrics, getFixtureDatasetStats, importFixturePostgresTable, listFixtureDatasets, listFixtureRuns, normalizeCsvSnapshot, runFixturePipeline, testPostgresConnection } from "./realDataFlow";

describe("ASTRA fixture data flow", () => {
  it("exposes clearly labeled dataset snapshots and computed statistics", () => {
    const datasets = listFixtureDatasets(1);
    expect(datasets[0]?.disclosure).toContain("DEVELOPMENT FIXTURE");
    const stats = getFixtureDatasetStats(1, 7001);
    expect(stats.find(column => column.name === "seats")).toMatchObject({ dataType: "number", min: 4, max: 41 });
  });

  it("keeps live PostgreSQL disabled without the encryption secret", () => {
    const result = testPostgresConnection({ host: "db.example", port: 5432, databaseName: "analytics", username: "reader", ssl: true });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("CONNECTION_ENCRYPTION_KEY");
  });

  it("normalizes bounded CSV input and materializes a fixture table snapshot", () => {
    const rows = normalizeCsvSnapshot("id,name\n1,Ada\n2,Ben", 1);
    expect(rows).toEqual([{ id: "1", name: "Ada" }]);
    expect(browsePostgresTables().tables[0]?.name).toBe("customer_accounts_fixture");
    const imported = importFixturePostgresTable(1, "customer_accounts_fixture");
    expect(imported.sourceType).toBe("PostgreSQL");
    expect(imported.rows).toHaveLength(4);
  });

  it("executes a fixture pipeline with a real transformation and records metrics", () => {
    const pipeline = createFixturePipeline({ workspaceId: 1, name: "active-customers", sourceDatasetId: 7001, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "active", operator: "equals", value: "true" }] });
    const run = runFixturePipeline(1, pipeline.id);
    expect(run.status).toBe("success");
    expect(run.rowsIn).toBe(4);
    expect(run.rowsOut).toBe(3);
    expect(run.logs.at(-1)).toContain("Wrote 3 rows");
    expect(listFixtureRuns(1, pipeline.id)[0]?.id).toBe(run.id);
  });

  it("computes workspace-scoped dashboard aggregates from fixture runs", () => {
    const pipeline = createFixturePipeline({ workspaceId: 1, name: "metrics-pipeline", sourceDatasetId: 7001, destinationMode: "new_dataset", steps: [] });
    runFixturePipeline(1, pipeline.id);
    const metrics = getFixtureDashboardMetrics(1);
    expect(metrics.activePipelines).toBeGreaterThan(0);
    expect(metrics.successfulRuns).toBeGreaterThan(0);
    expect(metrics.totalRows).toBeGreaterThan(0);
    expect(metrics.disclosure).toContain("DEVELOPMENT FIXTURE");
  });
});
