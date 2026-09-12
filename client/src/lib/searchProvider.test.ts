import { describe, expect, it } from "vitest";
import { combinedSearchProvider, makeRealSearchProvider, mockSearchProvider, staticSearchPages, type SearchResult } from "./searchProvider";

describe("ASTRA search providers", () => {
  it("combines real and simulated results without a fuzzy-ranking claim", async () => {
    const real: SearchResult[] = [{ id: "p1", type: "project", title: "Customer Analytics", href: "/projects" }];
    const results = await combinedSearchProvider("customer", { workspaceId: "7" }, [makeRealSearchProvider(real), mockSearchProvider]);
    expect(results.map(result => result.title)).toContain("Customer Analytics");
    expect(results.every(result => result.title.toLowerCase().includes("customer"))).toBe(true);
  });

  it("registers the new utility, explore, and data engineering destinations", () => {
    const hrefs = new Set(staticSearchPages.map(page => page.href));
    ["/recents", "/integrations", "/saved-queries", "/query-history", "/pipeline-runs", "/ingestion", "/dashboards"].forEach(href => expect(hrefs.has(href)).toBe(true));
  });

  it("silently omits an unavailable provider", async () => {
    const results = await combinedSearchProvider("orders", { workspaceId: "7" }, [{ search: async () => { throw new Error("provider unavailable"); } }, mockSearchProvider]);
    expect(results.every(result => result.isSimulated)).toBe(true);
  });
});
