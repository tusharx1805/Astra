import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModuleSubnav, type ModuleTab } from "@/components/ModuleSubnav";
import { DatasetSourcePanel } from "@/components/ConnectionModules";
import { canImportDatasets, useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { useRecentView } from "@/hooks/useRecentView";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, ArrowRight, ArrowUpRight, Database, FileUp, GitBranch, Loader2, UploadCloud } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

/**
 * Phase 1 — persisted dataset screens.
 * Every value on these screens is read back from the database through the
 * dataset.* tRPC procedures; nothing here is simulated.
 */

export const DATASET_TABS: ModuleTab[] = [
  { label: "INVENTORY", href: "/datasets" },
  { label: "EXPLORER", href: "/datasets/explorer" },
  { label: "IMPORT CSV", href: "/datasets/import" },
  { label: "CONNECTIONS", href: "/datasets/connections" },
  { label: "DEV FIXTURE", href: "/datasets/fixtures" },
];

const PAGE_SIZE = 50;
const MAX_UPLOAD_BYTES = 5_000_000;

export function PersistedBadge() {
  return <span className="status status--green" title="Read back from the Astra database">PERSISTED</span>;
}

function Heading({ eyebrow, title, description, action }: { eyebrow: string; title: React.ReactNode; description: string; action?: React.ReactNode }) {
  return <><section className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</section><ModuleSubnav tabs={DATASET_TABS} /></>;
}

export function StateMessage({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return <div className="module-empty"><Database size={23} /><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

export function WorkspaceGate({ children, subject = "Datasets" }: { children: (workspaceId: number, role: string | null) => React.ReactNode; subject?: string }) {
  const active = useActiveWorkspace();
  const [, setLocation] = useLocation();
  if (!active.isAuthenticated && !active.isLoading) return <section className="panel"><StateMessage title="Sign in required" detail={`${subject} are stored per workspace. Sign in to create and explore them.`} /></section>;
  if (active.isLoading) return <div className="workspace-loading"><span>LOADING WORKSPACE…</span></div>;
  if (active.storageError) return <section className="panel"><StateMessage title="Workspace data unavailable" detail="The data store could not be reached. You are still signed in; try again once the database is available." /></section>;
  if (!active.workspaceId) return <section className="panel"><StateMessage title="Workspace required" detail={`Create or join a workspace before working with ${subject.toLowerCase()}.`} action={<Button className="button-red" onClick={() => setLocation("/workspaces")}>OPEN WORKSPACES</Button>} /></section>;
  return <>{children(active.workspaceId, active.role)}</>;
}

function LineageLink({ datasetId }: { datasetId: number }) {
  const [, setLocation] = useLocation();
  return <Button variant="outline" onClick={() => setLocation(`/lineage?focus=dataset:${datasetId}`)}><GitBranch size={13} /> VIEW LINEAGE</Button>;
}

export function slugifyDatasetName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").replace(/[^\w .-]+/g, "_").replace(/_+/g, "_").trim().slice(0, 160) || "dataset";
}

export function DatasetImportPanel({ workspaceId, role, onImported }: { workspaceId: number; role: string | null; onImported?: (id: number) => void }) {
  const utils = trpc.useUtils();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const importCsv = trpc.dataset.importCsv.useMutation({
    // Success is only reported after the server has committed the transaction.
    onSuccess: result => {
      toast.success("Dataset imported", { description: `${result.rowCount.toLocaleString()} rows · ${result.columnCount} columns persisted.` });
      void utils.dataset.list.invalidate({ workspaceId });
      void utils.workspace.views.invalidate({ workspaceId });
      void utils.workspace.ingestionAttempts.invalidate({ workspaceId });
      setFile(null); setName("");
      if (fileInput.current) fileInput.current.value = "";
      onImported?.(result.id);
    },
    onError: error => {
      toast.error("Import failed — nothing was saved", { description: error.message });
      void utils.workspace.ingestionAttempts.invalidate({ workspaceId });
    },
  });
  const allowed = canImportDatasets(role);
  const choose = (next: File | null) => {
    setReadError(null);
    setFile(next);
    if (next) {
      if (next.size > MAX_UPLOAD_BYTES) setReadError(`File is ${(next.size / 1_000_000).toFixed(1)} MB; the limit is 5 MB.`);
      if (!name) setName(slugifyDatasetName(next.name));
    }
  };
  const submit = async () => {
    if (!file) return;
    try {
      const csvText = await file.text();
      importCsv.mutate({ workspaceId, name: name.trim(), csvText, fileName: file.name });
    } catch {
      setReadError("The browser could not read this file.");
    }
  };
  if (!allowed) return <section className="panel"><StateMessage title="Read-only role" detail="Only workspace owners, admins and developers can import datasets. You can still explore existing datasets." /></section>;
  return <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">CSV / FILES · UPLOAD</p><h2>IMPORT A DATASET</h2></div><UploadCloud size={22} className="module-mark" /></div><p className="panel-copy">The file is parsed and validated on the server, then its columns and rows are written to the database in a single transaction. If any step fails, nothing is saved. Limits: 5 MB, 20,000 rows, 200 columns; the first row must be a header.</p><div className="workspace-form"><div><label htmlFor="dataset-file">CSV FILE</label><input id="dataset-file" ref={fileInput} type="file" accept=".csv,text/csv" onChange={event => choose(event.target.files?.[0] ?? null)} /></div><div><label htmlFor="dataset-name">DATASET NAME</label><Input id="dataset-name" value={name} onChange={event => setName(event.target.value)} placeholder="customer_accounts" maxLength={160} /></div>{readError ? <p className="form-error" role="alert">{readError}</p> : null}<Button className="button-red" disabled={!file || name.trim().length < 2 || Boolean(readError) || importCsv.isPending} onClick={submit}>{importCsv.isPending ? <><Loader2 size={14} className="spin" /> IMPORTING</> : <><FileUp size={14} /> IMPORT DATASET</>}</Button></div></section>;
}

export function DatasetImportPage() {
  const [, setLocation] = useLocation();
  return <div className="page-stack"><Heading eyebrow="BUILD · DATASETS · IMPORT" title={<>IMPORT<br /><em>DATASET.</em></>} description="Upload a CSV file into the active workspace. Imported datasets persist across refreshes and server restarts." /><WorkspaceGate>{(workspaceId, role) => <DatasetImportPanel workspaceId={workspaceId} role={role} onImported={id => setLocation(`/datasets/${id}`)} />}</WorkspaceGate></div>;
}

function DatasetBody({ workspaceId, datasetId }: { workspaceId: number; datasetId: number }) {
  const [offset, setOffset] = useState(0);
  const detail = trpc.dataset.get.useQuery({ workspaceId, datasetId }, { retry: false });
  const stats = trpc.dataset.stats.useQuery({ workspaceId, datasetId }, { enabled: detail.isSuccess });
  const rows = trpc.dataset.rows.useQuery({ workspaceId, datasetId, offset, limit: PAGE_SIZE }, { enabled: detail.isSuccess, placeholderData: previous => previous });
  useRecentView({ workspaceId, entityType: "dataset", entityId: detail.data ? String(detail.data.id) : undefined, entityLabel: detail.data?.name });
  if (detail.isLoading) return <div className="workspace-loading"><span>LOADING DATASET…</span></div>;
  if (detail.error) return <section className="panel"><StateMessage title={detail.error.data?.code === "NOT_FOUND" ? "Dataset not found" : "Dataset unavailable"} detail={detail.error.message} /></section>;
  const dataset = detail.data!;
  const total = rows.data?.total ?? dataset.rowCount;
  const legacy = dataset.workspaceId === null;
  return <>
    <section className="split-grid">
      <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">SCHEMA · {dataset.sourceType}</p><h2>{dataset.name}</h2></div><PersistedBadge /></div><p className="panel-copy">{total.toLocaleString()} rows · {dataset.columns.length} columns · completeness {dataset.qualityScore ?? "—"}% · imported {new Date(dataset.createdAt).toLocaleString()}</p><LineageLink datasetId={dataset.id} />{dataset.columns.length ? <div className="history-list">{dataset.columns.map(column => <div key={column.name}><span><b>{column.name}</b><small>{column.dataType} · {column.nullable ? "NULLABLE" : "REQUIRED"}</small></span><span><b>{column.uniqueValues}</b><small>DISTINCT</small></span><span><b>{column.nullPercent}%</b><small>NULL</small></span></div>)}</div> : <p className="panel-copy">{legacy ? "Legacy registry entry: no columns or rows have been persisted for this dataset." : "No column metadata stored."}</p>}</section>
      <section className="panel"><p className="eyebrow">STATISTICS</p><h2>COMPUTED FROM STORED ROWS</h2>{stats.isLoading ? <div className="workspace-loading"><span>COMPUTING…</span></div> : stats.data?.columns.length ? <div className="history-list">{stats.data.columns.map(stat => <div key={stat.name}><span><b>{stat.name}</b><small>{stat.dataType}{stat.dataType === "number" && stat.min !== null && stat.min !== undefined ? ` · ${stat.min} – ${stat.max}` : stat.topValues?.[0] ? ` · top: ${stat.topValues[0][0]}` : ""}</small></span><span><b>{stat.nullCount}</b><small>NULLS</small></span><span><b>{stat.distinctCount}</b><small>DISTINCT</small></span></div>)}</div> : <p className="panel-copy">No statistics: this dataset has no stored rows.</p>}</section>
    </section>
    {dataset.sourceType === "PostgreSQL" ? <DatasetSourcePanel workspaceId={workspaceId} datasetId={dataset.id} /> : null}
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">ROWS · DATABASE</p><h2>{total ? `ROWS ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} OF ${total.toLocaleString()}` : "NO ROWS"}</h2></div><span className="step-actions"><Button variant="outline" aria-label="Previous page" disabled={offset === 0 || rows.isFetching} onClick={() => setOffset(current => Math.max(0, current - PAGE_SIZE))}><ArrowLeft size={13} /></Button><Button variant="outline" aria-label="Next page" disabled={offset + PAGE_SIZE >= total || rows.isFetching} onClick={() => setOffset(current => current + PAGE_SIZE)}><ArrowRight size={13} /></Button></span></div>{rows.error ? <p className="form-error" role="alert">{rows.error.message}</p> : total ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>#</th>{dataset.columns.map(column => <th key={column.name}>{column.name}</th>)}</tr></thead><tbody>{rows.data?.rows.map(row => <tr key={row.rowIndex}><td>{row.rowIndex + 1}</td>{dataset.columns.map(column => <td key={column.name}>{row.data[column.name] === null || row.data[column.name] === undefined ? "∅" : String(row.data[column.name])}</td>)}</tr>)}</tbody></table></div> : <p className="panel-copy">This dataset has no persisted rows.</p>}</section>
  </>;
}

export function PersistedDatasetDetail({ id }: { id: string }) {
  const datasetId = Number(id);
  return <div className="page-stack"><Heading eyebrow="BUILD · DATASETS · DETAIL" title={<>DATASET<br /><em>DETAIL.</em></>} description="Schema, statistics and rows read back from the database for the active workspace." /><WorkspaceGate>{workspaceId => Number.isInteger(datasetId) && datasetId > 0 ? <DatasetBody key={`${workspaceId}-${datasetId}`} workspaceId={workspaceId} datasetId={datasetId} /> : <section className="panel"><StateMessage title="Invalid dataset id" detail={`“${id}” is not a dataset id.`} /></section>}</WorkspaceGate></div>;
}

function ExplorerBody({ workspaceId, role }: { workspaceId: number; role: string | null }) {
  const [, setLocation] = useLocation();
  const list = trpc.dataset.list.useQuery({ workspaceId });
  const [selected, setSelected] = useState<number | null>(null);
  const datasets = list.data ?? [];
  const activeId = useMemo(() => (selected && datasets.some(item => item.id === selected) ? selected : datasets[0]?.id ?? null), [selected, datasets]);
  if (list.isLoading) return <div className="workspace-loading"><span>LOADING DATASETS…</span></div>;
  if (list.error) return <section className="panel"><StateMessage title="Datasets unavailable" detail={list.error.message} /></section>;
  if (!datasets.length) return <><section className="panel"><StateMessage title="No datasets yet" detail="Import a CSV file to create this workspace's first persisted dataset." /></section><DatasetImportPanel workspaceId={workspaceId} role={role} onImported={id => setSelected(id)} /></>;
  return <><section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">WORKSPACE CATALOG</p><h2>SELECT DATASET</h2></div><span className="module-meta">{datasets.length} DATASETS</span></div><div className="chip-row">{datasets.map(dataset => <button key={dataset.id} className={dataset.id === activeId ? "chip chip--active" : "chip"} onClick={() => setSelected(dataset.id)}>{dataset.name}</button>)}</div>{activeId ? <Button variant="outline" onClick={() => setLocation(`/datasets/${activeId}`)}><ArrowUpRight size={14} /> OPEN DETAIL PAGE</Button> : null}</section>{activeId ? <DatasetBody key={`${workspaceId}-${activeId}`} workspaceId={workspaceId} datasetId={activeId} /> : null}</>;
}

export function PersistedDatasetExplorer() {
  const [, setLocation] = useLocation();
  return <div className="page-stack"><Heading eyebrow="BUILD · DATASETS · EXPLORER" title={<>DATASET<br /><em>EXPLORER.</em></>} description="Browse datasets stored in the active workspace. Rows and statistics come from the database, not from fixtures." action={<Button className="button-red" onClick={() => setLocation("/datasets/import")}><FileUp size={14} /> IMPORT CSV</Button>} /><WorkspaceGate>{(workspaceId, role) => <ExplorerBody key={workspaceId} workspaceId={workspaceId} role={role} />}</WorkspaceGate></div>;
}
