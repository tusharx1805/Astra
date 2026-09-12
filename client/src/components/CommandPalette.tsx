import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import React, { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { ChevronRight, Clock3, Loader2, Search as SearchIcon } from "lucide-react";
import { useLocation } from "wouter";
import { combinedSearchProvider, getNextSelectedIndex, makeRealSearchProvider, mockSearchProvider, resultTypeLabel, staticSearchPages, type SearchResult } from "@/lib/searchProvider";
import { SimulatedBadge } from "@/components/SimulatedBadge";

const groupOrder: SearchResult["type"][] = ["project", "dataset", "pipeline", "saved_query", "change", "incident", "page"];

export function CommandPalette({ open, onOpenChange, workspaceId, onRecent }: { open: boolean; onOpenChange: (open: boolean) => void; workspaceId: number | null; onRecent: (result: SearchResult) => void }) {
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recent, setRecent] = useState<SearchResult[]>([]);
  const realSearch = trpc.workspace.search.useQuery({ workspaceId: workspaceId ?? 0, query: query.trim() || "_" }, { enabled: open && Boolean(workspaceId) && Boolean(query.trim()), staleTime: 15_000 });
  const realResults = useMemo(() => {
    const data = realSearch.data;
    if (!data) return [];
    return [...data.projects, ...data.datasets, ...data.pipelines, ...(data.savedQueries ?? [])] as SearchResult[];
  }, [realSearch.data]);
  const [results, setResults] = useState<SearchResult[]>([]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
  }, [open]);
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    let cancelled = false;
    combinedSearchProvider(query, { workspaceId: String(workspaceId ?? "") }, [makeRealSearchProvider(realResults), mockSearchProvider]).then(next => { if (!cancelled) { setResults(next); setSelectedIndex(0); } });
    return () => { cancelled = true; };
  }, [query, realResults, workspaceId]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); onOpenChange(true); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange]);

  const visibleResults = results.filter(result => result.type !== "page");
  const groupedResults = groupOrder.map(type => ({ type, items: visibleResults.filter(result => result.type === type) })).filter(group => group.items.length);
  const selectable = visibleResults;
  const go = (result: SearchResult) => { onRecent(result); setRecent(current => [result, ...current.filter(item => item.id !== result.id)].slice(0, 5)); onOpenChange(false); setLocation(result.href); };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setSelectedIndex(index => getNextSelectedIndex(index, "next", selectable.length)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setSelectedIndex(index => getNextSelectedIndex(index, "previous", selectable.length)); }
    if (event.key === "Enter" && selectable[selectedIndex]) { event.preventDefault(); go(selectable[selectedIndex]); }
    if (event.key === "Escape") onOpenChange(false);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="command-palette"><DialogTitle className="sr-only">Global search</DialogTitle><DialogDescription className="sr-only">Search workspaces, entities, and platform destinations.</DialogDescription><div className="command-search-row"><SearchIcon size={18} /><Input autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={handleKeyDown} placeholder="Search ASTRA..." /><kbd>ESC</kbd></div>{!query.trim() ? <div className="command-home"><div><p className="command-label">NAVIGATE</p>{staticSearchPages.map(page => <button key={page.id} onClick={() => go(page)}><span>{page.title}<small>{page.subtitle}</small></span><ChevronRight size={15} /></button>)}</div>{recent.length ? <div><p className="command-label"><Clock3 size={12} /> RECENT</p>{recent.map(item => <button key={item.id} onClick={() => go(item)}><span>{item.title}<small>{resultTypeLabel[item.type]}</small></span><ChevronRight size={15} /></button>)}</div> : null}</div> : realSearch.isLoading ? <div className="command-state"><Loader2 className="animate-spin" size={19} /><span>SEARCHING WORKSPACE ENTITIES…</span></div> : groupedResults.length ? <div className="command-results">{groupedResults.map(group => <div key={group.type}><p className="command-label">{resultTypeLabel[group.type]}</p>{group.items.slice(0, 5).map(result => { const index = selectable.findIndex(item => item.id === result.id); return <button key={result.id} className={index === selectedIndex ? "selected" : ""} onMouseEnter={() => setSelectedIndex(index)} onClick={() => go(result)}><span><b>{result.title}</b><small>{result.subtitle}</small></span>{result.isSimulated ? <SimulatedBadge compact /> : <ChevronRight size={15} />}</button>; })}{group.items.length > 5 ? <button className="command-view-all" onClick={() => go({ ...group.items[0], title: `${resultTypeLabel[group.type]} · VIEW ALL` })}>VIEW ALL {group.items.length} RESULTS <ChevronRight size={14} /></button> : null}</div>)}</div> : <div className="command-state"><span>NO RESULTS FOR “{query}”</span><small>Check spelling or browse from the sidebar instead.</small></div>}</DialogContent></Dialog>;
}
