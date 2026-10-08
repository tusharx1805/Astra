import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModuleSubnav } from "@/components/ModuleSubnav";
import { StateMessage, WorkspaceGate } from "@/components/DatasetModules";
import { canImportDatasets, useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { trpc } from "@/lib/trpc";
import { CONNECTOR_LIMITS, qualifiedName, SSL_MODE_LABEL, SSL_MODES, suggestDatasetName, type SslMode } from "@shared/pgConnector";
import { ArrowUpRight, Database, Eye, GitBranch, Plug, RefreshCw, ShieldCheck, Trash2, UploadCloud } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

/**
 * Phase 9 — live, read-only PostgreSQL. Every value on these screens comes from
 * a real connection attempt or the Astra database; nothing is a fixture.
 */

const INTEGRATION_TABS = [
  { label: "CONNECTORS", href: "/integrations" },
  { label: "INGESTION HISTORY", href: "/ingestion" },
];

const OTHER_CONNECTORS = [
  { name: "CSV / Files", icon: UploadCloud, detail: "Upload a CSV into a persisted dataset", href: "/datasets/import", available: true },
  { name: "REST APIs", icon: Plug, detail: "Ingest from HTTP sources" },
  { name: "GitHub", icon: GitBranch, detail: "Code and change context" },
  { name: "MySQL", icon: Database, detail: "Relational source connector" },
  { name: "MinIO / S3", icon: UploadCloud, detail: "Object-storage files" },
  { name: "Airflow", icon: GitBranch, detail: "Pipeline execution context" },
  { name: "Other", icon: Plug, detail: "Tell us what you use" },
];

const when = (value: string | Date | null | undefined) => (value ? new Date(value).toLocaleString() : "—");

function Header({ title, description, action }: { title: React.ReactNode; description: string; action?: React.ReactNode }) {
  return <><section className="page-heading"><div><p className="eyebrow">UTILITY · DATA CONNECTIONS</p><h1>{title}</h1><p>{description}</p></div>{action}</section><ModuleSubnav tabs={INTEGRATION_TABS} /></>;
}

type LastTest = { at: string | Date; meta: { ok: boolean; message?: string | null; serverVersion?: string; currentUser?: string; superuser?: boolean; writableTables?: number; readableObjects?: number; durationMs?: number } } | null;

function TestBadge({ test }: { test: LastTest }) {
  if (!test) return <span className="status status--yellow">NOT TESTED</span>;
  return <span className={test.meta.ok ? "status status--green" : "status status--red"} title={test.meta.message ?? undefined}>{test.meta.ok ? "REACHABLE" : "FAILED"} · {when(test.at)}</span>;
}

function RoleWarning({ meta }: { meta: NonNullable<LastTest>["meta"] }) {
  if (!meta.ok) return null;
  if (meta.superuser) return <p className="form-error" role="alert">“{meta.currentUser}” is a superuser. Astra only reads, but store a dedicated read-only role instead.</p>;
  if ((meta.writableTables ?? 0) > 0) return <p className="form-error" role="alert">“{meta.currentUser}” can write to {meta.writableTables} table(s). Astra never writes (every session is READ ONLY), but a read-only role is the safer credential.</p>;
  return <p className="panel-copy connection-safe"><ShieldCheck size={13} /> <span>“{meta.currentUser}” has no write privileges on any table.</span></p>;
}

type Draft = { name: string; host: string; port: string; databaseName: string; username: string; password: string; sslMode: SslMode };
const EMPTY_DRAFT: Draft = { name: "", host: "", port: "5432", databaseName: "postgres", username: "", password: "", sslMode: "verify-full" };

function NewConnectionForm({ workspaceId, encryptionReady, onSaved }: { workspaceId: number; encryptionReady: boolean; onSaved: (id: number) => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [result, setResult] = useState<null | { ok: boolean; text: string; warnings: string[] }>(null);
  const set = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { setDraft(current => ({ ...current, [key]: event.target.value })); setResult(null); };
  const target = { workspaceId, host: draft.host.trim(), port: Number(draft.port), databaseName: draft.databaseName.trim(), username: draft.username.trim(), password: draft.password, sslMode: draft.sslMode };
  const complete = Boolean(target.host && target.databaseName && target.username && target.password && Number.isInteger(target.port) && target.port > 0);
  const test = trpc.connector.testDraft.useMutation({
    onSuccess: outcome => setResult(outcome.ok
      ? { ok: true, text: `Connected in ${outcome.durationMs} ms · PostgreSQL ${outcome.probe.serverVersion} · signed in as ${outcome.probe.currentUser} · ${outcome.probe.readableObjects} readable tables/views.`, warnings: outcome.warnings }
      : { ok: false, text: outcome.failure.message, warnings: [] }),
    onError: error => setResult({ ok: false, text: error.message, warnings: [] }),
  });
  const utils = trpc.useUtils();
  const create = trpc.connector.create.useMutation({
    onSuccess: saved => { toast.success("Connection saved", { description: `${saved.name} was tested live and stored with an encrypted password.` }); setDraft(EMPTY_DRAFT); utils.connector.list.invalidate(); onSaved(saved.id); },
    onError: error => setResult({ ok: false, text: error.message, warnings: [] }),
  });
  return <section className="panel" data-testid="new-connection"><p className="eyebrow">NEW POSTGRESQL CONNECTION · OWNERS & ADMINS</p><h2>CONNECT READ-ONLY</h2>
    <p className="panel-copy">Use a role that can only SELECT. Astra opens every session as READ ONLY, never runs your SQL, and stores the password encrypted (AES-256-GCM). A connection is saved only after a live test succeeds.</p>
    {!encryptionReady ? <p className="form-error" role="alert">CONNECTION_ENCRYPTION_KEY is not set on this server, so connections cannot be saved yet. You can still test credentials.</p> : null}
    <div className="workspace-form connection-form">
      <div><label htmlFor="pg-name">CONNECTION NAME</label><Input id="pg-name" value={draft.name} onChange={set("name")} placeholder="CRM replica" /></div>
      <div><label htmlFor="pg-host">HOST</label><Input id="pg-host" value={draft.host} onChange={set("host")} placeholder="aws-0-ap-south-1.pooler.supabase.com" autoComplete="off" /></div>
      <div><label htmlFor="pg-port">PORT</label><Input id="pg-port" inputMode="numeric" value={draft.port} onChange={set("port")} /></div>
      <div><label htmlFor="pg-db">DATABASE</label><Input id="pg-db" value={draft.databaseName} onChange={set("databaseName")} autoComplete="off" /></div>
      <div><label htmlFor="pg-user">USERNAME</label><Input id="pg-user" value={draft.username} onChange={set("username")} placeholder="astra_reader" autoComplete="off" /></div>
      <div><label htmlFor="pg-password">PASSWORD</label><Input id="pg-password" type="password" value={draft.password} onChange={set("password")} autoComplete="new-password" /></div>
      <div><label htmlFor="pg-ssl">SSL MODE</label><select id="pg-ssl" value={draft.sslMode} onChange={set("sslMode")}>{SSL_MODES.map(mode => <option key={mode} value={mode}>{mode} — {SSL_MODE_LABEL[mode]}</option>)}</select></div>
    </div>
    {result ? <div className={result.ok ? "connection-result connection-result--ok" : "connection-result connection-result--fail"} role="status" data-testid="connection-result"><b>{result.ok ? "CONNECTION OK" : "CONNECTION FAILED"}</b><span>{result.text}</span>{result.warnings.map(warning => <span key={warning} className="form-error">{warning}</span>)}</div> : null}
    <div className="step-actions connection-actions">
      <Button variant="outline" disabled={!complete || test.isPending} onClick={() => test.mutate(target)}>{test.isPending ? "TESTING…" : "TEST CONNECTION"}</Button>
      <Button className="button-red" disabled={!complete || draft.name.trim().length < 3 || !encryptionReady || create.isPending} onClick={() => create.mutate({ ...target, name: draft.name.trim() })}>{create.isPending ? "TESTING & SAVING…" : "TEST & SAVE"}</Button>
    </div>
  </section>;
}

function IntegrationsBody({ workspaceId, role }: { workspaceId: number; role: string | null }) {
  const [, setLocation] = useLocation();
  const canUse = canImportDatasets(role);
  const list = trpc.connector.list.useQuery({ workspaceId }, { enabled: canUse, retry: false });
  const [adding, setAdding] = useState(false);
  const canManage = list.data?.canManage ?? false;
  return <>
    <section className="connector-grid">
      <article className="connector-card"><div className="connector-card__icon"><Database size={20} /></div><p className="eyebrow">LIVE · READ-ONLY</p><h3>PostgreSQL</h3><p>Browse tables and views over a real connection and import them as datasets you can refresh.</p><span className="connector-status connector-status--available">AVAILABLE</span><Button className="button-red" disabled={!canManage} title={canManage ? undefined : "Owners and admins add connections"} onClick={() => setAdding(true)}>{canManage ? "ADD CONNECTION" : "ADMINS ADD CONNECTIONS"}</Button></article>
      {OTHER_CONNECTORS.map(connector => { const Icon = connector.icon; return <article className="connector-card" key={connector.name}><div className="connector-card__icon"><Icon size={20} /></div><p className="eyebrow">{connector.available ? "READY" : "ROADMAP"}</p><h3>{connector.name}</h3><p>{connector.detail}</p><span className={connector.available ? "connector-status connector-status--available" : "connector-status"}>{connector.available ? "AVAILABLE" : "COMING SOON"}</span><Button className={connector.available ? "button-red" : "button-muted"} disabled={!connector.available || !canUse} onClick={() => connector.href && setLocation(connector.href)}>{connector.available ? "IMPORT CSV" : "COMING SOON"}</Button></article>; })}
    </section>
    {adding && canManage ? <NewConnectionForm workspaceId={workspaceId} encryptionReady={list.data?.encryptionReady ?? false} onSaved={id => setLocation(`/integrations/postgres/${id}`)} /> : null}
    <section className="panel" data-testid="connection-list"><div className="workspace-section-head"><div><p className="eyebrow">POSTGRESQL · THIS WORKSPACE</p><h2>SAVED CONNECTIONS</h2></div><span className="module-meta">{list.data ? `${list.data.connections.length} SAVED` : ""}</span></div>
      {!canUse ? <StateMessage title="Connections are for build roles" detail="Owners, admins and developers can use database connections. Ask an admin for access." />
        : list.isLoading ? <div className="workspace-loading"><span>LOADING CONNECTIONS…</span></div>
        : list.error ? <StateMessage title="Connections unavailable" detail={list.error.message} />
        : list.data!.connections.length ? <div className="history-list connection-list">{list.data!.connections.map(connection => <div key={connection.id}><span><b>{connection.name}</b><small>{connection.username}@{connection.host}:{connection.port}/{connection.databaseName} · {connection.sslMode}</small></span><span><TestBadge test={connection.lastTest as LastTest} /></span><span><b>{connection.datasetCount}</b><small>IMPORTED DATASETS</small></span><span><Button variant="outline" onClick={() => setLocation(`/integrations/postgres/${connection.id}`)}><ArrowUpRight size={13} /> OPEN</Button></span></div>)}</div>
        : <StateMessage title="No connections yet" detail={canManage ? "Add a PostgreSQL connection above. It is saved only after a live connection test succeeds." : "An owner or admin must add the first connection."} />}
    </section>
  </>;
}

export function IntegrationsPage() {
  return <div className="page-stack"><Header title={<>CONNECT<br /><em>SOURCES.</em></>} description="CSV upload and live PostgreSQL are available. PostgreSQL connections are read-only, tested for real, and store credentials encrypted. Other sources are marked as roadmap." action={<Plug size={30} className="module-mark" />} /><WorkspaceGate subject="Connections">{(workspaceId, role) => <IntegrationsBody key={workspaceId} workspaceId={workspaceId} role={role} />}</WorkspaceGate></div>;
}

function ObjectPanel({ workspaceId, connectionId, schema, table, onClose }: { workspaceId: number; connectionId: number; schema: string; table: string; onClose: () => void }) {
  const [, setLocation] = useLocation();
  const [name, setName] = useState(() => suggestDatasetName(schema, table));
  const preview = trpc.connector.preview.useQuery({ workspaceId, connectionId, schema, table }, { retry: false, refetchOnWindowFocus: false });
  const utils = trpc.useUtils();
  const importObject = trpc.connector.importObject.useMutation({
    onSuccess: dataset => { toast.success("Imported from PostgreSQL", { description: `${dataset.rowCount.toLocaleString()} rows × ${dataset.columnCount} columns from ${dataset.object} are now dataset “${dataset.name}”.` }); utils.connector.get.invalidate(); utils.connector.list.invalidate(); utils.dataset.list.invalidate(); setLocation(`/datasets/${dataset.id}`); },
    onError: error => toast.error("Import failed — nothing was created", { description: error.message }),
  });
  const object = qualifiedName(schema, table);
  return <section className="panel object-panel" data-testid="object-panel"><div className="workspace-section-head"><div><p className="eyebrow">LIVE PREVIEW · FIRST {CONNECTOR_LIMITS.previewRows} ROWS</p><h2>{object}</h2></div><Button variant="outline" onClick={onClose}>CLOSE</Button></div>
    {preview.isLoading ? <div className="workspace-loading"><span>READING FROM SOURCE…</span></div>
      : preview.error ? <p className="form-error" role="alert">{preview.error.message}</p>
      : <>
        <p className="panel-copy">{preview.data!.kind} · {preview.data!.columns.length} columns · {preview.data!.primaryKey.length ? `ordered by primary key (${preview.data!.primaryKey.join(", ")})` : "no primary key — rows are imported in the order the server returns them"}</p>
        <div className="data-table-wrap"><table className="data-table"><thead><tr>{preview.data!.columns.map(column => <th key={column.name} title={column.type}>{column.name}<small className="ops-cell-note">{column.type}{column.primaryKey ? " · PK" : ""}</small></th>)}</tr></thead><tbody>{preview.data!.rows.map((row, index) => <tr key={index}>{preview.data!.columns.map(column => <td key={column.name}>{row[column.name] ?? "∅"}</td>)}</tr>)}</tbody></table></div>
        <div className="workspace-form connection-import"><div><label htmlFor="import-name">NEW DATASET NAME</label><Input id="import-name" value={name} onChange={event => setName(event.target.value)} /></div>
          <p className="panel-copy">Import reads the whole {preview.data!.kind} (up to {CONNECTOR_LIMITS.maxImportRows.toLocaleString()} rows) in a READ ONLY transaction and stores it as an Astra dataset. Bigger sources are refused, never silently cut.</p>
          <Button className="button-red" disabled={name.trim().length < 2 || importObject.isPending} onClick={() => importObject.mutate({ workspaceId, connectionId, schema, table, datasetName: name.trim() })}>{importObject.isPending ? "IMPORTING…" : "IMPORT AS DATASET"}</Button>
        </div>
      </>}
  </section>;
}

function ConnectionBody({ workspaceId, connectionId, role }: { workspaceId: number; connectionId: number; role: string | null }) {
  const [, setLocation] = useLocation();
  const canUse = canImportDatasets(role);
  const detail = trpc.connector.get.useQuery({ workspaceId, connectionId }, { enabled: canUse, retry: false });
  const browse = trpc.connector.browse.useQuery({ workspaceId, connectionId }, { enabled: canUse && detail.isSuccess, retry: false, refetchOnWindowFocus: false });
  const [schemaFilter, setSchemaFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<{ schema: string; table: string } | null>(null);
  const utils = trpc.useUtils();
  const test = trpc.connector.test.useMutation({
    onSuccess: outcome => { utils.connector.get.invalidate(); utils.connector.list.invalidate(); if (outcome.ok) toast.success("Connection reachable", { description: `PostgreSQL ${outcome.probe.serverVersion} in ${outcome.durationMs} ms.` }); else toast.error("Connection failed", { description: outcome.failure.message }); },
    onError: error => toast.error("Test could not run", { description: error.message }),
  });
  const remove = trpc.connector.remove.useMutation({ onSuccess: () => { toast.success("Connection removed", { description: "Imported datasets keep their rows but can no longer refresh." }); utils.connector.list.invalidate(); setLocation("/integrations"); }, onError: error => toast.error("Could not remove", { description: error.message }) });
  const schemas = useMemo(() => Array.from(new Set((browse.data?.objects ?? []).map(object => object.schema))), [browse.data]);
  const objects = (browse.data?.objects ?? []).filter(object => (schemaFilter === "ALL" || object.schema === schemaFilter) && `${object.schema}.${object.name}`.toLowerCase().includes(search.trim().toLowerCase()));
  if (!canUse) return <section className="panel"><StateMessage title="Connections are for build roles" detail="Owners, admins and developers can use database connections." /></section>;
  if (detail.isLoading) return <div className="workspace-loading"><span>LOADING CONNECTION…</span></div>;
  if (detail.error) return <section className="panel"><StateMessage title={detail.error.data?.code === "NOT_FOUND" ? "Connection not found" : "Connection unavailable"} detail={detail.error.message} action={<Button variant="outline" onClick={() => setLocation("/integrations")}>ALL CONNECTIONS</Button>} /></section>;
  const connection = detail.data!;
  const lastTest = connection.lastTest as LastTest;
  return <>
    <section className="panel" data-testid="connection-detail"><div className="workspace-section-head"><div><p className="eyebrow">POSTGRESQL · READ-ONLY</p><h2>{connection.name}</h2></div><TestBadge test={lastTest} /></div>
      <div className="detail-grid"><div><small>HOST</small><b>{connection.host}:{connection.port}</b></div><div><small>DATABASE</small><b>{connection.databaseName}</b></div><div><small>USER</small><b>{connection.username}</b></div><div><small>SSL</small><b>{connection.sslMode}</b></div><div><small>SERVER</small><b>{lastTest?.meta.serverVersion ?? "—"}</b></div><div><small>ADDED</small><b>{when(connection.createdAt)}</b></div></div>
      {lastTest && !lastTest.meta.ok ? <p className="form-error" role="alert">Last test failed: {lastTest.meta.message}</p> : lastTest ? <RoleWarning meta={lastTest.meta} /> : null}
      <p className="panel-copy">Password: stored encrypted, never shown. {connection.encryptionReady ? "" : "CONNECTION_ENCRYPTION_KEY is missing on this server, so this connection cannot be used until it is configured."}</p>
      <div className="step-actions"><Button variant="outline" disabled={test.isPending} onClick={() => test.mutate({ workspaceId, connectionId })}><RefreshCw size={13} /> {test.isPending ? "TESTING…" : "TEST NOW"}</Button>{connection.canManage ? <Button variant="outline" disabled={remove.isPending} onClick={() => { if (window.confirm(`Remove "${connection.name}"? Imported datasets keep their data but can no longer refresh from it.`)) remove.mutate({ workspaceId, connectionId }); }}><Trash2 size={13} /> REMOVE</Button> : null}</div>
    </section>
    <section className="panel table-browser" data-testid="table-browser"><div className="workspace-section-head"><div><p className="eyebrow">LIVE CATALOG · TABLES & VIEWS THIS USER CAN READ</p><h2>{browse.data ? `${browse.data.objects.length}${browse.data.truncated ? "+" : ""} OBJECTS` : "BROWSE SOURCE"}</h2></div><span className="step-actions"><span className="module-meta">{browse.data ? `READ ${when(browse.data.fetchedAt)}` : ""}</span><Button variant="outline" disabled={browse.isFetching} onClick={() => browse.refetch()}><RefreshCw size={13} /> {browse.isFetching ? "READING…" : "RELOAD"}</Button></span></div>
      {browse.isLoading ? <div className="workspace-loading"><span>READING CATALOG FROM SOURCE…</span></div>
        : browse.error ? <p className="form-error" role="alert">{browse.error.message}</p>
        : <>
          <div className="chip-row">{["ALL", ...schemas].map(schema => <button key={schema} className={schemaFilter === schema ? "chip chip--active" : "chip"} onClick={() => setSchemaFilter(schema)}>{schema}</button>)}<Input className="connection-search" placeholder="Filter tables…" value={search} onChange={event => setSearch(event.target.value)} /></div>
          {objects.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>OBJECT</th><th>KIND</th><th>EST. ROWS</th><th>COLUMNS</th><th /></tr></thead><tbody>{objects.map(object => <tr key={`${object.schema}.${object.name}`}><td><b>{qualifiedName(object.schema, object.name)}</b></td><td>{object.kind}</td><td>{object.estimatedRows === null ? "unknown" : object.estimatedRows.toLocaleString()}</td><td>{object.columnCount}</td><td><Button variant="outline" onClick={() => setSelected({ schema: object.schema, table: object.name })}><Eye size={13} /> PREVIEW & IMPORT</Button></td></tr>)}</tbody></table></div>
            : <StateMessage title="No readable tables" detail={browse.data!.objects.length ? "Nothing matches this filter." : "This user cannot SELECT from any table or view. Grant SELECT on the tables Astra should see."} />}
        </>}
    </section>
    {selected ? <ObjectPanel key={`${selected.schema}.${selected.table}`} workspaceId={workspaceId} connectionId={connectionId} schema={selected.schema} table={selected.table} onClose={() => setSelected(null)} /> : null}
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">PROVENANCE</p><h2>DATASETS FROM THIS CONNECTION</h2></div><span className="module-meta">{connection.imported.length} DATASETS</span></div>
      {connection.imported.length ? <div className="history-list">{connection.imported.map(item => <div key={item.datasetId}><span><b>{item.name}</b><small>{qualifiedName(item.schema, item.table)}</small></span><span><b>{item.rowCount.toLocaleString()}</b><small>ROWS</small></span><span><b>{when(item.lastSyncedAt)}</b><small>LAST SYNC · {item.syncCount}×</small></span><span><Button variant="outline" onClick={() => setLocation(`/datasets/${item.datasetId}`)}><ArrowUpRight size={13} /> OPEN</Button></span></div>)}</div>
        : <StateMessage title="Nothing imported yet" detail="Preview a table above and import it as a dataset." />}
    </section>
  </>;
}

export function ConnectionDetailPage({ id }: { id: string }) {
  const connectionId = Number(id);
  return <div className="page-stack"><Header title={<>POSTGRESQL<br /><em>SOURCE.</em></>} description="Live, read-only access: the catalog and previews are read from the source each time; imports become ordinary Astra datasets that remember where they came from." /><WorkspaceGate subject="Connections">{(workspaceId, role) => Number.isInteger(connectionId) && connectionId > 0 ? <ConnectionBody key={`${workspaceId}-${connectionId}`} workspaceId={workspaceId} connectionId={connectionId} role={role} /> : <section className="panel"><StateMessage title="Invalid connection id" detail={`“${id}” is not a connection id.`} /></section>}</WorkspaceGate></div>;
}

/** Shown on a dataset page when the dataset was imported from PostgreSQL. */
export function DatasetSourcePanel({ workspaceId, datasetId }: { workspaceId: number; datasetId: number }) {
  const [, setLocation] = useLocation();
  const { role } = useActiveWorkspace();
  const source = trpc.connector.datasetSource.useQuery({ workspaceId, datasetId }, { retry: false });
  const utils = trpc.useUtils();
  const refresh = trpc.connector.refreshDataset.useMutation({
    onSuccess: result => {
      const columnNote = [result.columnsAdded.length ? `added ${result.columnsAdded.join(", ")}` : "", result.columnsRemoved.length ? `removed ${result.columnsRemoved.join(", ")}` : ""].filter(Boolean).join("; ");
      const failing = result.checks.filter(check => check.status !== "pass").length;
      toast.success("Refreshed from source", { description: `${result.rowsBefore.toLocaleString()} → ${result.rowsAfter.toLocaleString()} rows${columnNote ? ` · columns ${columnNote}` : ""}${result.checks.length ? ` · ${result.checks.length - failing}/${result.checks.length} quality checks passing` : ""}.` });
      utils.dataset.get.invalidate({ workspaceId, datasetId }); utils.dataset.rows.invalidate(); utils.dataset.stats.invalidate({ workspaceId, datasetId }); utils.connector.datasetSource.invalidate({ workspaceId, datasetId }); utils.incidents.invalidate(); utils.quality.invalidate(); utils.monitoring.invalidate();
    },
    onError: error => toast.error("Refresh failed — the dataset was not changed", { description: error.message }),
  });
  if (source.isLoading || source.error || !source.data) return null;
  const data = source.data;
  if (!data.available) {
    if (data.reason === "not_external") return null;
    if (data.reason === "restricted") return <section className="panel"><p className="eyebrow">SOURCE · POSTGRESQL</p><p className="panel-copy">Imported from an external PostgreSQL database. Connection details are visible to owners, admins and developers.</p></section>;
    return <section className="panel"><p className="eyebrow">SOURCE · POSTGRESQL</p><p className="panel-copy">{data.reason === "migration" ? "Provenance needs the Phase 9 database migration (dataset_sources)." : "This dataset was created before source tracking existed, so it cannot be refreshed from its source."}</p></section>;
  }
  return <section className="panel" data-testid="dataset-source"><div className="workspace-section-head"><div><p className="eyebrow">SOURCE · POSTGRESQL · READ-ONLY</p><h2>{data.object}</h2></div><span className="step-actions">{data.connectionId ? <Button variant="outline" onClick={() => setLocation(`/integrations/postgres/${data.connectionId}`)}><ArrowUpRight size={13} /> CONNECTION</Button> : null}{canImportDatasets(role) ? <Button className="button-red" disabled={!data.connectionId || refresh.isPending} onClick={() => refresh.mutate({ workspaceId, datasetId })}><RefreshCw size={13} /> {refresh.isPending ? "READING SOURCE…" : "REFRESH FROM SOURCE"}</Button> : null}</span></div>
    <div className="detail-grid"><div><small>CONNECTION</small><b>{data.connectionName ?? "removed"}</b></div><div><small>DATABASE</small><b>{data.host ? `${data.host}/${data.databaseName}` : "—"}</b></div><div><small>KIND</small><b>{data.kind}</b></div><div><small>ORDERED BY</small><b>{data.orderedBy.length ? data.orderedBy.join(", ") : "server order"}</b></div><div><small>LAST SYNC</small><b>{when(data.lastSyncedAt)}</b></div><div><small>SYNCS</small><b>{data.syncCount} · {data.lastSyncRows.toLocaleString()} rows</b></div></div>
    {!data.connectionId ? <p className="form-error">The connection was removed. The rows stay, but this dataset can no longer refresh.</p> : <p className="panel-copy">Refresh re-reads the whole source object and replaces this dataset's rows in one transaction; its quality checks re-run on the new rows.</p>}
  </section>;
}
