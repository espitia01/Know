"use client";

import { useCallback, useEffect, useMemo } from "react";
import { api, type ExportRow } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ExportFormatIcon, exportFormatLabel } from "./ExportFormatIcon";

function isActive(row: ExportRow) {
  return row.status === "pending" || row.status === "running";
}

interface ExportStatusBarProps {
  paperId: string;
  className?: string;
}

/**
 * Visible export progress + download CTA in the analysis pane —
 * users shouldn't have to reopen Panel options to fetch a file.
 */
export function ExportStatusBar({ paperId, className }: ExportStatusBarProps) {
  const exportsById = useStore((s) => s.exportsById);
  const setExport = useStore((s) => s.setExport);
  const setExportUnreadBadge = useStore((s) => s.setExportUnreadBadge);
  const dismissExportStatus = useStore((s) => s.dismissExportStatus);
  const dismissedIds = useStore((s) => s.dismissedExportStatusIds);

  const row = useMemo(() => {
    const forPaper = Object.values(exportsById)
      .filter((e) => e.paper_id === paperId)
      .sort((a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime());
    const active = forPaper.find(isActive);
    if (active) return active;
    const recent = forPaper.find(
      (e) =>
        (e.status === "completed" && e.download_url && !dismissedIds.includes(e.id)) ||
        (e.status === "failed" && !dismissedIds.includes(e.id)),
    );
    return recent ?? null;
  }, [exportsById, paperId, dismissedIds]);

  const poll = useCallback(async () => {
    if (!row || !isActive(row)) return;
    try {
      const fresh = await api.getExport(row.id);
      setExport(fresh);
      if (fresh.status === "completed") setExportUnreadBadge(true);
    } catch {
      /* transient */
    }
  }, [row, setExport, setExportUnreadBadge]);

  useEffect(() => {
    if (!row || !isActive(row)) return;
    const t = setInterval(() => void poll(), 2000);
    return () => clearInterval(t);
  }, [row, poll]);

  if (!row) return null;

  const active = isActive(row);

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-border/40 bg-muted/[0.06] px-4 py-2.5",
        className,
      )}
      role="status"
    >
      <ExportFormatIcon format={row.format} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-[var(--text-xs)] font-medium text-foreground truncate">
          {active
            ? `Generating ${exportFormatLabel(row.format).toLowerCase()}…`
            : row.status === "failed"
              ? "Export failed"
              : `${exportFormatLabel(row.format)} ready`}
        </p>
        {active ? (
          <p className="text-[10px] text-muted-foreground/80">Usually under a minute</p>
        ) : row.byte_size != null ? (
          <p className="text-[10px] tabular-nums text-muted-foreground/80">
            {(row.byte_size / 1024).toFixed(0)} KB
            {row.duration_s != null ? ` · ${Math.round(row.duration_s / 60)} min` : ""}
          </p>
        ) : null}
        {row.status === "failed" && row.error_message && (
          <p className="text-[10px] text-destructive/90 truncate">{row.error_message}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {row.status === "completed" && row.download_url && (
          <a
            href={row.download_url}
            download
            className="rounded-md bg-primary px-2.5 py-1 text-[var(--text-xs)] font-medium text-primary-foreground motion-safe:duration-150 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Download
          </a>
        )}
        {active && (
          <span
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground/70"
            aria-hidden
          />
        )}
        <button
          type="button"
          onClick={() => dismissExportStatus(row.id)}
          className="rounded-md px-1.5 py-1 text-[var(--text-xs)] text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label="Dismiss export status"
        >
          ×
        </button>
      </div>
    </div>
  );
}
