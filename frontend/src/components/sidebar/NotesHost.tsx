"use client";

import { useState } from "react";
import { NotesPanel } from "@/components/sidebar/NotesPanel";
import { HighlightsPanel } from "@/components/sidebar/HighlightsPanel";

interface NotesHostProps {
  paperId: string;
}

export function NotesHost({ paperId }: NotesHostProps) {
  const [tab, setTab] = useState<"notes" | "highlights">("notes");

  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-lg border border-border/40 bg-muted/[0.08] p-0.5">
        {(["notes", "highlights"] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex-1 rounded-md px-2.5 py-1.5 text-[var(--text-xs)] font-medium capitalize transition-colors motion-safe:duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
              tab === id
                ? "bg-card/30 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {id}
          </button>
        ))}
      </div>
      {tab === "notes" ? <NotesPanel paperId={paperId} /> : <HighlightsPanel paperId={paperId} />}
    </div>
  );
}
