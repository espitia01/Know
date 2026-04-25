"use client";

import { useEffect, useState } from "react";
import { getProgressStart } from "@/lib/analysisState";

type ProgressKind = "preReading" | "assumptions" | "summary" | "selection" | "qa";

const HALF_LIFE: Record<ProgressKind, number> = {
  preReading: 10,
  assumptions: 10,
  summary: 20,
  selection: 8,
  qa: 10,
};

export function AnalysisProgress({
  kind,
  paperId,
  className = "",
}: {
  kind: ProgressKind;
  paperId?: string;
  className?: string;
}) {
  const [localStart] = useState(() => Date.now());
  const [width, setWidth] = useState(0);

  useEffect(() => {
    // Per audit §5.1/§12.5: one progress primitive keeps timing and
    // visual treatment consistent across every analysis pane tab.
    const start = paperId && (kind === "preReading" || kind === "assumptions" || kind === "summary")
      ? getProgressStart(paperId, kind)
      : localStart;
    const interval = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      setWidth(Math.min(90, 90 * (1 - Math.exp(-elapsed / HALF_LIFE[kind]))));
    }, 150);
    return () => clearInterval(interval);
  }, [kind, paperId, localStart]);

  return (
    <div className={`w-full max-w-xs h-1 bg-accent rounded-full overflow-hidden ${className}`}>
      <div
        className="h-full bg-foreground/60 rounded-full transition-all duration-200 ease-out"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
