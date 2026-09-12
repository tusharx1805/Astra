export type SearchResultType = "project" | "dataset" | "pipeline" | "saved_query" | "change" | "incident" | "page";

export interface SearchResult {
  id: string;
  type: SearchResultType;
  title: string;
  subtitle?: string;
  href: string;
  isSimulated?: boolean;
}

export interface SearchProvider {
  search(query: string, opts: { workspaceId: string }): Promise<SearchResult[]>;
}

export const staticSearchPages: SearchResult[] = [
  { id: "page-overview", type: "page", title: "Dashboard", subtitle: "System overview", href: "/" },
  { id: "page-projects", type: "page", title: "Projects", subtitle: "Build / project inventory", href: "/projects" },
  { id: "page-recents", type: "page", title: "Recents", subtitle: "Recently viewed resources", href: "/recents" },
  { id: "page-catalog", type: "page", title: "Catalog", subtitle: "Workspace data catalog", href: "/catalog" },
  { id: "page-pipelines", type: "page", title: "Pipelines", subtitle: "Build / pipeline registry", href: "/pipelines" },
  { id: "page-integrations", type: "page", title: "Integrations", subtitle: "Connect sources", href: "/integrations" },
  { id: "page-saved-queries", type: "page", title: "Saved Queries", subtitle: "Explore / CSV query library", href: "/saved-queries" },
  { id: "page-query-history", type: "page", title: "Query History", subtitle: "Explore / execution log", href: "/query-history" },
  { id: "page-pipeline-runs", type: "page", title: "Pipeline Runs", subtitle: "Data engineering / execution", href: "/pipeline-runs" },
  { id: "page-ingestion", type: "page", title: "Data Ingestion", subtitle: "Data engineering / source history", href: "/ingestion" },
  { id: "page-dashboards", type: "page", title: "Dashboards", subtitle: "Explore / risk and health", href: "/dashboards" },
  { id: "page-admin", type: "page", title: "Account & Admin", subtitle: "Access and governance", href: "/admin" },
  { id: "page-settings", type: "page", title: "Settings", subtitle: "Platform configuration", href: "/settings" },
];

const simulatedFixtures: SearchResult[] = [
  { id: "change-customer-id", type: "change", title: "Widen customer identifier", subtitle: "SQL · Critical risk", href: "/changes", isSimulated: true },
  { id: "change-orders-contract", type: "change", title: "Orders contract migration", subtitle: "Schema · History", href: "/changes/history", isSimulated: true },
  { id: "incident-etl-regression", type: "incident", title: "Customer ETL regression", subtitle: "Open · P1", href: "/incidents", isSimulated: true },
  { id: "incident-null-rate", type: "incident", title: "Null-rate anomaly", subtitle: "Resolved · P2", href: "/incidents", isSimulated: true },
];

export const mockSearchProvider: SearchProvider = {
  async search(query) {
    const normalized = query.trim().toLowerCase();
    return simulatedFixtures.filter(result => `${result.title} ${result.subtitle}`.toLowerCase().includes(normalized));
  },
};

export function makeRealSearchProvider(results: SearchResult[]): SearchProvider {
  return {
    async search(query) {
      const normalized = query.trim().toLowerCase();
      return results.filter(result => `${result.title} ${result.subtitle ?? ""}`.toLowerCase().includes(normalized));
    },
  };
}

export function getNextSelectedIndex(current: number, direction: "next" | "previous", total: number): number {
  if (total <= 0) return 0;
  return direction === "next" ? Math.min(current + 1, total - 1) : Math.max(current - 1, 0);
}

export async function combinedSearchProvider(
  query: string,
  opts: { workspaceId: string },
  providers: SearchProvider[],
): Promise<SearchResult[]> {
  const results = await Promise.all(providers.map(provider => provider.search(query, opts).catch(error => {
    console.warn("[SearchProvider] provider omitted after failure", error);
    return [];
  })));
  return results.flat();
}

export const resultTypeLabel: Record<SearchResultType, string> = {
  page: "NAVIGATION",
  project: "PROJECTS",
  dataset: "DATASETS",
  pipeline: "PIPELINES",
  saved_query: "SAVED QUERIES",
  change: "CHANGES",
  incident: "INCIDENTS",
};
