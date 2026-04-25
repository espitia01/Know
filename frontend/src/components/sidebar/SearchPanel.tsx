"use client";

import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { Badge } from "@/components/ui/badge";

interface SearchPanelProps {
  paperId: string;
}

function highlightSnippet(snippet: string, q: string) {
  const t = q.trim();
  if (!t) return snippet;
  const lower = snippet.toLowerCase();
  const needle = t.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) {
    return snippet;
  }
  const end = idx + t.length;
  return (
    <>
      {snippet.slice(0, idx)}
      <mark className="rounded-sm bg-foreground/10 px-0.5 text-foreground">{snippet.slice(idx, end)}</mark>
      {snippet.slice(end)}
    </>
  );
}

export function SearchPanel({ paperId }: SearchPanelProps) {
  const { searchResults, setSearchResults, searchLoading, setSearchLoading } = useStore();
  const [query, setQuery] = useState("");

  const qTrim = useMemo(() => query.trim(), [query]);

  const handleSearch = async () => {
    const q = qTrim;
    if (!q) return;
    setSearchLoading(true);
    try {
      const result = await api.search(paperId, q);
      setSearchResults(result.results);
    } catch (e) {
      console.error("Search failed:", e);
    } finally {
      setSearchLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <Input
        placeholder="Search paper content…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!e.target.value.trim()) setSearchResults([]);
        }}
        onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        className="text-[var(--text-md)]"
      />

      {searchLoading && (
        <div className="flex min-h-[20vh] flex-col items-center justify-center gap-3 py-6 motion-safe:animate-fade-in">
          <div className="w-full max-w-xs">
            <AnalysisProgress kind="search" />
          </div>
          <p className="text-[var(--text-sm)] text-muted-foreground">Searching…</p>
        </div>
      )}

      {!searchLoading && searchResults.length > 0 && (
        <div className="space-y-0 overflow-hidden rounded-lg border border-border/60 bg-card/30 motion-safe:animate-fade-in">
          {searchResults.map((r, i) => (
            <div
              key={i}
              className="border-b border-border/60 px-4 py-3 last:border-b-0 motion-safe:transition-colors motion-safe:duration-150 hover:bg-accent/40"
            >
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <Badge variant="dot" className="max-w-[8rem] font-medium normal-case">
                  {r.match_type}
                </Badge>
                <span className="text-[var(--text-xs)] text-muted-foreground/80">{r.section}</span>
              </div>
              <p className="text-[var(--text-sm)] leading-relaxed text-foreground/90">
                {highlightSnippet(r.snippet, qTrim)}
              </p>
            </div>
          ))}
        </div>
      )}

      {!searchLoading && query && searchResults.length === 0 && (
        <p className="py-6 text-center text-[var(--text-md)] text-muted-foreground/80">
          No results found.
        </p>
      )}
    </div>
  );
}
