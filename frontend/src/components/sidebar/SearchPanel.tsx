"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Input } from "@/components/ui/input";

interface SearchPanelProps {
  paperId: string;
}

export function SearchPanel({ paperId }: SearchPanelProps) {
  const { searchResults, setSearchResults, searchLoading, setSearchLoading } = useStore();
  const [query, setQuery] = useState("");

  const handleSearch = async () => {
    const q = query.trim();
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
        placeholder="Search paper content..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        className="text-[13px]"
      />

      {searchLoading && (
        <div className="flex items-center gap-3 py-6 justify-center animate-fade-in">
          <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin" />
          <p className="text-[13px] text-muted-foreground">Searching...</p>
        </div>
      )}

      {!searchLoading && searchResults.length > 0 && (
        <div className="space-y-1.5 animate-fade-in">
          {searchResults.map((r, i) => (
            <div key={i} className="rounded-lg bg-accent/50 px-3.5 py-2.5">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 bg-muted px-2 py-0.5 rounded-full font-medium">
                  {r.match_type}
                </span>
                <span className="text-[10px] text-muted-foreground/50">{r.section}</span>
              </div>
              <p className="text-[12px] leading-relaxed">{r.snippet}</p>
            </div>
          ))}
        </div>
      )}

      {!searchLoading && query && searchResults.length === 0 && (
        <p className="text-[13px] text-muted-foreground/60 text-center py-6">
          No results found.
        </p>
      )}
    </div>
  );
}
