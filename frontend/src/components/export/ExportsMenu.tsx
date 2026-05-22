"use client";

import { useCallback, useEffect, useMemo } from "react";
import { api, type ExportRow } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const FORMAT_LABEL: Record<ExportRow["format"], string> = {
  pdf: "PDF",
  pptx: "PPTX",
  podcast: "Podcast",
};

function isActive(row: ExportRow) {
  return row.status === "pending" || row.status === "running";
}

export function ExportsMenu() {
  const exportsById = useStore((s) => s.exportsById);
  const setExport = useStore((s) => s.setExport);
  const removeExport = useStore((s) => s.removeExport);
  const setExportUnreadBadge = useStore((s) => s.setExportUnreadBadge);

  const sorted = useMemo(
    () =>
      Object.values(exportsById).sort(
        (a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime(),
      ),
    [exportsById],
  );

  const pollActive = useCallback(async () => {
    const active = sorted.filter(isActive);
    if (!active.length) return;
    await Promise.all(
      active.map(async (row) => {
        try {
          const fresh = await api.getExport(row.id);
          setExport(fresh);
          if (fresh.status === "completed") {
            setExportUnreadBadge(true);
          }
        } catch {
          /* ignore transient poll errors */
        }
      }),
    );
  }, [sorted, setExport, setExportUnreadBadge]);

  useEffect(() => {
    void api.listExports(20).then(({ items }) => {
      items.forEach((row) => setExport(row));
    });
  }, [setExport]);

  useEffect(() => {
    if (!sorted.some(isActive)) return;
    const t = setInterval(() => void pollActive(), 2000);
    return () => clearInterval(t);
  }, [sorted, pollActive]);

  async function handleDelete(id: string) {
    try {
      await api.deleteExport(id);
      removeExport(id);
    } catch {
      /* best-effort */
    }
  }

  if (!sorted.length) {
    return (
      <p className="px-2 py-2 text-[var(--text-xs)] text-muted-foreground/70">
        No exports yet.
      </p>
    );
  }

  return (
    <div className="max-h-64 overflow-y-auto space-y-1">
      <div className="px-2 pt-1 pb-1 text-[var(--text-xs)] font-semibold text-muted-foreground/80">
        Recent exports
      </div>
      {sorted.slice(0, 20).map((row) => (
        <div
          key={row.id}
          className="flex flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-accent/40 text-[var(--text-xs)]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium truncate">
              {FORMAT_LABEL[row.format]} · {row.status}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {row.status === "completed" && row.download_url && (
                <a
                  href={row.download_url}
                  download
                  className="rounded border border-border px-1.5 py-0.5 hover:bg-accent/60"
                >
                  Download
                </a>
              )}
              <button
                type="button"
                onClick={() => void handleDelete(row.id)}
                className="rounded border border-border px-1.5 py-0.5 hover:bg-accent/60 text-muted-foreground"
                aria-label="Delete export"
              >
                ×
              </button>
            </div>
          </div>
          {row.status === "failed" && row.error_message && (
            <span className="text-destructive/80 truncate">{row.error_message}</span>
          )}
          {row.format === "podcast" && row.status === "completed" && row.download_url && (
            <audio controls src={row.download_url} className="w-full h-7" preload="none" />
          )}
          {row.byte_size != null && row.status === "completed" && (
            <span className="text-muted-foreground/70 tabular-nums">
              {(row.byte_size / 1024).toFixed(0)} KB
              {row.duration_s != null ? ` · ${Math.round(row.duration_s / 60)} min` : ""}
            </span>
          )}
          {isActive(row) && (
            <span className={cn("text-muted-foreground/70")}>Processing…</span>
          )}
        </div>
      ))}
    </div>
  );
}
