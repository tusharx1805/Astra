import { TRPCError } from "@trpc/server";
import { applyTransformSteps, type Row, type TransformStep } from "../shared/transformations";

export const FIXTURE_MODE_DISCLOSURE = "DEVELOPMENT FIXTURE — replace with a real connection and uploaded snapshot before production use.";
const MAX_ROWS = 5000;

type FixtureDataset = { id: number; workspaceId: number; name: string; sourceType: "CSV / Files" | "PostgreSQL"; rows: Row[] };
type FixturePipeline = { id: number; workspaceId: number; name: string; sourceDatasetId: number; destinationMode: "new_dataset" | "overwrite_existing"; destinationDatasetId?: number; steps: TransformStep[] };

const FIXTURE_CSV = `customer_id,email,plan,seats,active\nC-1001,ada@example.com,pro,12,true\nC-1002,ben@example.com,starter,4,true\nC-1003,,pro,8,false\nC-1004,drew@example.com,enterprise,41,true`;

export function normalizeCsvSnapshot(csv: string, maxRows = MAX_ROWS): Row[] {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  const headers = (lines.shift() ?? "").split(",").map(header => header.trim()).filter(Boolean);
  return lines.slice(0, maxRows).map(line => {
    const values = line.split(",");
    return headers.reduce<Row>((row, header, index) => { row[header] = values[index]?.trim() || null; return row; }, {});
  });
}

const datasets = new Map<number, FixtureDataset>([
  [7001, { id: 7001, workspaceId: 1, name: "customer_accounts_fixture", sourceType: "CSV / Files", rows: normalizeCsvSnapshot(FIXTURE_CSV) }],
]);
const pipelines = new Map<number, FixturePipeline>();
const runs = new Map<number, { id: number; pipelineId: number; status: string; rowsIn: number; rowsOut: number; coercionFailures: number; durationMs: number; logs: string[]; errorMessage?: string }>();
let nextRunId = 9100;
let nextDatasetId = 7100;

function assertWorkspace(workspaceId: number) {
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "A valid workspace is required." });
}

function inferColumns(rows: Row[]) {
  const names = Array.from(new Set(rows.flatMap(row => Object.keys(row))));
  return names.map(name => {
    const values = rows.map(row => row[name]);
    const nonNull = values.filter(value => value !== null && value !== undefined && value !== "");
    const allNumbers = nonNull.length > 0 && nonNull.every(value => Number.isFinite(Number(value)));
    const allBooleans = nonNull.length > 0 && nonNull.every(value => ["true", "false", "0", "1", true, false].includes(value as never));
    const dataType = allNumbers ? "number" : allBooleans ? "boolean" : "string";
    const distinct = new Set(nonNull.map(value => String(value))).size;
    return { name, dataType, nullable: values.some(value => value === null || value === undefined || value === ""), uniqueValues: distinct, nullPercent: rows.length ? Math.round(((rows.length - nonNull.length) / rows.length) * 100) : 0 };
  });
}

export function listFixtureDatasets(workspaceId: number) {
  assertWorkspace(workspaceId);
  return Array.from(datasets.values()).filter(dataset => dataset.workspaceId === workspaceId).map(dataset => ({ id: dataset.id, name: dataset.name, sourceType: dataset.sourceType, rowCount: dataset.rows.length, columns: inferColumns(dataset.rows), disclosure: FIXTURE_MODE_DISCLOSURE }));
}

export function getFixtureDataset(workspaceId: number, datasetId: number) {
  assertWorkspace(workspaceId);
  const dataset = datasets.get(datasetId);
  if (!dataset || dataset.workspaceId !== workspaceId) throw new TRPCError({ code: "NOT_FOUND", message: "Dataset not found in the active workspace." });
  return { ...dataset, columns: inferColumns(dataset.rows), disclosure: FIXTURE_MODE_DISCLOSURE };
}

export function getFixtureDatasetStats(workspaceId: number, datasetId: number) {
  const dataset = getFixtureDataset(workspaceId, datasetId);
  return dataset.columns.map(column => {
    const values = dataset.rows.map(row => row[column.name]).filter(value => value !== null && value !== undefined && value !== "");
    const nullCount = dataset.rows.length - values.length;
    const distinctCount = new Set(values.map(value => String(value))).size;
    if (column.dataType === "number") {
      const numbers = values.map(Number).filter(Number.isFinite);
      return { ...column, nullCount, distinctCount, min: Math.min(...numbers), max: Math.max(...numbers), average: numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null };
    }
    const frequencies = new Map<string, number>();
    values.forEach(value => frequencies.set(String(value), (frequencies.get(String(value)) ?? 0) + 1));
    return { ...column, nullCount, distinctCount, topValues: Array.from(frequencies.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5) };
  });
}

export function testPostgresConnection(input: { host: string; port: number; databaseName: string; username: string; ssl: boolean }) {
  return { ok: false, mode: "fixture", message: "Live PostgreSQL is disabled until CONNECTION_ENCRYPTION_KEY is supplied.", disclosure: FIXTURE_MODE_DISCLOSURE, fingerprint: `${input.username}@${input.host}:${input.port}/${input.databaseName}${input.ssl ? " (SSL)" : ""}` };
}

export function browsePostgresTables() {
  return { tables: [{ name: "customer_accounts_fixture", columns: inferColumns(normalizeCsvSnapshot(FIXTURE_CSV)), rowCount: normalizeCsvSnapshot(FIXTURE_CSV).length }], mode: "fixture", message: "Showing the bounded fixture table catalog. Live table browsing will be enabled after credential setup.", disclosure: FIXTURE_MODE_DISCLOSURE };
}

export function importFixturePostgresTable(workspaceId: number, tableName: string) {
  assertWorkspace(workspaceId);
  if (tableName !== "customer_accounts_fixture") throw new TRPCError({ code: "NOT_FOUND", message: "Fixture table not found." });
  const rows = normalizeCsvSnapshot(FIXTURE_CSV);
  const dataset = { id: nextDatasetId++, workspaceId, name: `${tableName}_snapshot`, sourceType: "PostgreSQL" as const, rows };
  datasets.set(dataset.id, dataset);
  return { ...dataset, columns: inferColumns(rows), disclosure: FIXTURE_MODE_DISCLOSURE };
}

export function createFixturePipeline(input: { workspaceId: number; name: string; sourceDatasetId: number; destinationMode: "new_dataset" | "overwrite_existing"; destinationDatasetId?: number; steps: TransformStep[] }) {
  assertWorkspace(input.workspaceId);
  getFixtureDataset(input.workspaceId, input.sourceDatasetId);
  if (input.destinationMode === "overwrite_existing" && input.destinationDatasetId) getFixtureDataset(input.workspaceId, input.destinationDatasetId);
  const id = Math.max(0, ...Array.from(pipelines.keys())) + 1;
  const pipeline = { id, ...input };
  pipelines.set(id, pipeline);
  return { ...pipeline, disclosure: FIXTURE_MODE_DISCLOSURE };
}

export function listFixturePipelines(workspaceId: number) {
  assertWorkspace(workspaceId);
  return Array.from(pipelines.values()).filter(pipeline => pipeline.workspaceId === workspaceId).map(pipeline => ({ ...pipeline, disclosure: FIXTURE_MODE_DISCLOSURE }));
}

export function runFixturePipeline(workspaceId: number, pipelineId: number) {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline || pipeline.workspaceId !== workspaceId) throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in the active workspace." });
  const started = Date.now();
  const source = getFixtureDataset(workspaceId, pipeline.sourceDatasetId);
  const rowsIn = source.rows.length;
  const result = applyTransformSteps(source.rows.slice(0, MAX_ROWS), pipeline.steps);
  const logs = [`Loaded ${rowsIn} rows from ${source.name}`, ...result.effects];
  let destination: FixtureDataset;
  if (pipeline.destinationMode === "overwrite_existing" && pipeline.destinationDatasetId) {
    const current = getFixtureDataset(workspaceId, pipeline.destinationDatasetId);
    destination = { ...current, rows: result.rows };
  } else {
    destination = { id: nextDatasetId++, workspaceId, name: `${pipeline.name}_output`, sourceType: "CSV / Files", rows: result.rows };
  }
  datasets.set(destination.id, destination);
  logs.push(`Wrote ${result.rows.length} rows to ${destination.name}`);
  const run = { id: nextRunId++, pipelineId, status: "success", rowsIn, rowsOut: result.rows.length, coercionFailures: result.coercionFailures, durationMs: Date.now() - started, logs };
  runs.set(run.id, run);
  return { ...run, destinationId: destination.id, disclosure: FIXTURE_MODE_DISCLOSURE };
}

export function listFixtureRuns(workspaceId: number, pipelineId?: number) {
  const allowed = new Set(listFixturePipelines(workspaceId).map(pipeline => pipeline.id));
  return Array.from(runs.values()).filter(run => allowed.has(run.pipelineId) && (pipelineId ? run.pipelineId === pipelineId : true)).sort((a, b) => b.id - a.id).map(run => ({ ...run, disclosure: FIXTURE_MODE_DISCLOSURE }));
}

export function getFixtureDashboardMetrics(workspaceId: number) {
  const workspacePipelines = listFixturePipelines(workspaceId);
  const workspaceRuns = listFixtureRuns(workspaceId);
  const successfulRuns = workspaceRuns.filter(run => run.status === "success").length;
  const failedRuns = workspaceRuns.filter(run => run.status === "failed").length;
  const rowCounts = listFixtureDatasets(workspaceId).reduce((sum, dataset) => sum + dataset.rowCount, 0);
  return { pipelineHealth: workspaceRuns.length ? Math.round((successfulRuns / workspaceRuns.length) * 1000) / 10 : 100, activePipelines: workspacePipelines.length, successfulRuns, failedRuns, qualityScore: 100, totalRows: rowCounts, disclosure: FIXTURE_MODE_DISCLOSURE };
}
