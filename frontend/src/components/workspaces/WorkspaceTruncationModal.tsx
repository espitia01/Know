"use client";

import { useEffect, useMemo, useState } from "react";
import type { LoadedWorkspacePaper } from "@/lib/workspaceSessionLoad";
import { setRememberedWorkspaceSelection } from "@/lib/workspaceTruncationPrefs";

export interface WorkspaceTruncationModalProps {
  open: boolean;
  workspaceId: string;
  workspaceUpdatedAt: string;
  requested: number;
  missingCount: number;
  cap: number;
  papers: LoadedWorkspacePaper[];
  onClose: () => void;
  onConfirm: (selected: LoadedWorkspacePaper[], remember: boolean) => void;
}

function truncateTitle(title: string, max = 50): string {
  return title.length > max ? `${title.slice(0, max)}…` : title;
}

/**
 * Shown when a saved workspace has more loadable papers than MAX_SESSION_PAPERS.
 * Lets the user pick which papers to pin before navigation continues.
 */
export function WorkspaceTruncationModal({
  open,
  workspaceId,
  workspaceUpdatedAt,
  requested,
  missingCount,
  cap,
  papers,
  onClose,
  onConfirm,
}: WorkspaceTruncationModalProps) {
  const paperIdsKey = useMemo(
    () => papers.map((p) => p.id).join(","),
    [papers],
  );

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(papers.slice(0, cap).map((p) => p.id)));
    setRemember(false);
  }, [open, paperIdsKey, cap, papers]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const atCap = selected.size >= cap;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      if (next.size >= cap) return prev;
      next.add(id);
      return next;
    });
  };

  const handleConfirm = () => {
    const picked = papers.filter((p) => selected.has(p.id));
    if (picked.length === 0 || picked.length > cap) return;
    if (remember) {
      setRememberedWorkspaceSelection(workspaceId, workspaceUpdatedAt, picked.map((p) => p.id));
    }
    onConfirm(picked, remember);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Choose papers for workspace session"
    >
      <div
        className="absolute inset-0 bg-foreground/25 backdrop-blur-md"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative glass-strong rounded-2xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[85vh] animate-fade-in">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-[14px] font-semibold text-foreground font-display tracking-[-0.02em]">
            This workspace has more papers than your session can hold
          </h3>
          <p className="mt-2 text-[var(--text-sm)] text-muted-foreground">
            This workspace has <strong className="font-medium text-foreground">{requested} papers</strong> but a
            workspace session holds at most <strong className="font-medium text-foreground">{cap}</strong>. Pick the{" "}
            {cap} you want to load — the rest stay saved in the workspace.
          </p>
          {missingCount > 0 && (
            <p className="mt-2 text-[var(--text-xs)] text-muted-foreground/90">
              {missingCount} {missingCount === 1 ? "paper in this workspace has" : "papers in this workspace have"}{" "}
              been deleted and won&apos;t appear below.
            </p>
          )}
        </div>

        <ul className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
          {papers.map((p) => {
            const checked = selected.has(p.id);
            const disabled = !checked && atCap;
            return (
              <li key={p.id}>
                <label
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors motion-safe:duration-150 ${
                    checked
                      ? "border-border/60 bg-card/30"
                      : disabled
                        ? "border-border/40 opacity-50 cursor-not-allowed"
                        : "border-border/50 hover:border-border/60 hover:bg-accent/30"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggle(p.id)}
                    className="shrink-0 rounded border-border"
                  />
                  <span className="flex-1 min-w-0 text-[var(--text-sm)] text-foreground truncate">
                    {truncateTitle(p.title)}
                  </span>
                  <span className="shrink-0 rounded-md border border-border/55 bg-muted/[0.10] px-1.5 py-0.5 text-[var(--text-xs)] text-muted-foreground/80 tabular-nums">
                    #{p.workspaceIndex}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="px-5 py-3 border-t border-border flex items-center gap-2">
          <label className="flex items-center gap-2 text-[var(--text-xs)] text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="rounded border-border"
            />
            Remember this choice
          </label>
          <span className="ml-auto text-[var(--text-xs)] text-muted-foreground tabular-nums">
            {selected.size}/{cap}
          </span>
        </div>

        <div className="px-5 py-4 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-[var(--text-sm)] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={selected.size === 0}
            className="btn-primary-glass rounded-lg px-4 py-2 text-[var(--text-sm)] font-medium text-background transition-opacity disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Open with selected
          </button>
        </div>
      </div>
    </div>
  );
}
