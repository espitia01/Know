"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useShallow } from "zustand/react/shallow";
import { api, type ExportRow } from "@/lib/api";
import { useStore } from "@/lib/store";
import { useUserTier, canAccess } from "@/lib/UserTierContext";
import { cn } from "@/lib/utils";
import {
  getExportSectionAvailability,
  type ExportSectionId,
} from "@/lib/exportSectionAvailability";
import { ExportFormatIcon, exportFormatLabel } from "./ExportFormatIcon";

const SECTION_OPTIONS = [
  { id: "summary", label: "Summary" },
  { id: "qa", label: "Q&A" },
  { id: "notes", label: "Notes" },
  { id: "highlights", label: "Highlights" },
  { id: "selection", label: "Selections" },
  { id: "assumptions", label: "Assumptions" },
  { id: "figures", label: "Figures" },
  { id: "cross", label: "Cross-paper Q&A" },
  { id: "related", label: "Related work" },
  { id: "prepare", label: "Prepare" },
] as const;

const FORMATS = [
  {
    id: "pdf" as const,
    label: "PDF",
    feature: "export-pdf" as const,
    blurb: "Print-ready report with cover and table of contents",
    needsOpenAi: false,
  },
  {
    id: "pptx" as const,
    label: "PowerPoint",
    feature: "export-pptx" as const,
    blurb: "16:9 slide deck for meetings and journal clubs",
    needsOpenAi: false,
  },
  {
    id: "podcast" as const,
    label: "Podcast",
    feature: "export-podcast" as const,
    blurb: "Single-speaker MP3 walkthrough",
    needsOpenAi: true,
  },
];

type ExportFormat = (typeof FORMATS)[number]["id"];
type ModalPhase = "configure" | "progress" | "ready" | "failed";

interface ExportModalProps {
  paperId: string;
  open: boolean;
  onClose: () => void;
  hasOpenAiKey?: boolean;
}

function isActive(row: ExportRow) {
  return row.status === "pending" || row.status === "running";
}

export function ExportModal({ paperId, open, onClose, hasOpenAiKey = true }: ExportModalProps) {
  const { user: tierUser } = useUserTier();
  const tier = tierUser?.tier || "free";
  const setExport = useStore((s) => s.setExport);
  const setExportUnreadBadge = useStore((s) => s.setExportUnreadBadge);
  const dismissExportStatus = useStore((s) => s.dismissExportStatus);
  const figureCount = useStore((s) => s.papersById[paperId]?.figures?.length ?? 0);
  const paperTitle = useStore((s) => s.papersById[paperId]?.title ?? "This paper");
  const availability = useStore(
    useShallow((s) => getExportSectionAvailability(paperId, s)),
  );
  const availableSectionIds = useMemo(
    () => SECTION_OPTIONS.filter((s) => availability[s.id as ExportSectionId]).map((s) => s.id),
    [availability],
  );

  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [sections, setSections] = useState<string[]>(["summary", "qa"]);
  const [paperSize, setPaperSize] = useState<"Letter" | "A4">("Letter");
  const [includeFigures, setIncludeFigures] = useState(true);
  const [compact, setCompact] = useState(false);
  const [pptxTheme, setPptxTheme] = useState<"light" | "dark">("light");
  const [dense, setDense] = useState(false);
  const [voice, setVoice] = useState<"onyx" | "nova" | "alloy">("onyx");
  const [lengthMinutes, setLengthMinutes] = useState<5 | 8 | 12>(8);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ModalPhase>("configure");
  const [activeExportId, setActiveExportId] = useState<string | null>(null);
  const [activeRow, setActiveRow] = useState<ExportRow | null>(null);
  const wasOpenRef = useRef(false);

  const selectedFormat = FORMATS.find((f) => f.id === format)!;
  const canSelectFormat = (f: (typeof FORMATS)[number]) => {
    if (!canAccess(tier, f.feature)) return false;
    if (f.needsOpenAi && !hasOpenAiKey) return false;
    return true;
  };

  const resetModal = useCallback(() => {
    setPhase("configure");
    setActiveExportId(null);
    setActiveRow(null);
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    const justOpened = !wasOpenRef.current;
    wasOpenRef.current = true;
    if (justOpened) resetModal();

    setSections((prev) => {
      const kept = prev.filter((id) => availableSectionIds.includes(id as ExportSectionId));
      if (kept.length > 0) return kept;
      if (availableSectionIds.length === 0) return kept;
      if (justOpened || prev.length === 0) {
        return availableSectionIds.slice(0, Math.min(2, availableSectionIds.length));
      }
      return kept;
    });
  }, [open, availableSectionIds, resetModal]);

  const pollExport = useCallback(async () => {
    if (!activeExportId) return;
    try {
      const fresh = await api.getExport(activeExportId);
      setExport(fresh);
      setActiveRow(fresh);
      if (fresh.status === "completed") {
        setPhase("ready");
        setExportUnreadBadge(true);
        dismissExportStatus(fresh.id);
      } else if (fresh.status === "failed") {
        setPhase("failed");
      }
    } catch {
      /* transient */
    }
  }, [activeExportId, setExport, setExportUnreadBadge, dismissExportStatus]);

  useEffect(() => {
    if (!open || !activeExportId || phase === "ready" || phase === "failed") return;
    const t = setInterval(() => void pollExport(), 2000);
    void pollExport();
    return () => clearInterval(t);
  }, [open, activeExportId, phase, pollExport]);

  if (!open || typeof document === "undefined") return null;

  async function handleGenerate() {
    const feature = selectedFormat.feature;
    if (!canAccess(tier, feature)) return;
    if (selectedFormat.needsOpenAi && !hasOpenAiKey) return;
    setBusy(true);
    try {
      const options: Record<string, unknown> = {};
      if (format === "pdf") {
        options.pdf = { paper_size: paperSize, include_figures: includeFigures, compact };
      } else if (format === "pptx") {
        options.pptx = { theme: pptxTheme, dense };
      } else {
        options.podcast = { voice, length_minutes: lengthMinutes };
      }
      const { export_id } = await api.requestExport(paperId, {
        format,
        sections: sections.filter((id) =>
          availableSectionIds.includes(id as ExportSectionId),
        ),
        options,
      });
      const row = await api.getExport(export_id);
      setExport(row);
      setActiveExportId(export_id);
      setActiveRow(row);
      setPhase("progress");
      dismissExportStatus(export_id);
    } catch (e) {
      setPhase("failed");
      setActiveRow({
        id: "error",
        paper_id: paperId,
        format,
        status: "failed",
        sections,
        storage_path: null,
        byte_size: null,
        duration_s: null,
        error_code: "request_failed",
        error_message: e instanceof Error ? e.message : "Export failed",
        requested_at: new Date().toISOString(),
        completed_at: null,
      });
    } finally {
      setBusy(false);
    }
  }

  function toggleSection(id: string) {
    if (!availability[id as ExportSectionId]) return;
    setSections((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  }

  function selectAllSections() {
    setSections([...availableSectionIds]);
  }

  function handleClose() {
    resetModal();
    onClose();
  }

  const progressRow = activeRow;
  const showConfigure = phase === "configure";

  const modal = (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal
      aria-label="Export analysis"
      onClick={handleClose}
    >
      <div
        className="flex max-h-[min(90vh,680px)] w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border/50 bg-popover shadow-[var(--shadow-sm)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border/40 px-5 py-4">
          <h2 className="font-display text-[var(--text-base)] font-semibold tracking-[-0.02em]">
            {showConfigure ? "Export analysis" : phase === "ready" ? "Export ready" : phase === "failed" ? "Export failed" : "Generating export"}
          </h2>
          <p className="mt-1 text-[var(--text-xs)] leading-relaxed text-muted-foreground/85">
            {showConfigure ? (
              <>
                Download a file from{" "}
                <span className="text-foreground/90">{paperTitle}</span>
              </>
            ) : (
              exportFormatLabel(format)
            )}
          </p>
        </div>

        {showConfigure ? (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[var(--text-sm)]">
              <fieldset className="space-y-2">
                <legend className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-muted-foreground/80">
                  Format
                </legend>
                <div className="grid grid-cols-3 gap-2">
                  {FORMATS.map((f) => {
                    const allowed = canSelectFormat(f);
                    const selected = format === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        disabled={!allowed}
                        onClick={() => allowed && setFormat(f.id)}
                        className={cn(
                          "flex flex-col items-center gap-2 rounded-lg border px-2 py-3 text-center transition-colors motion-safe:duration-150",
                          selected
                            ? "border-foreground/25 bg-card/30"
                            : "border-border/50 hover:bg-muted/[0.08]",
                          !allowed && "cursor-not-allowed opacity-45",
                        )}
                      >
                        <ExportFormatIcon format={f.id} size="md" />
                        <span className="text-[var(--text-xs)] font-medium">{f.label}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[var(--text-xs)] text-muted-foreground/80">{selectedFormat.blurb}</p>
                {!canSelectFormat(selectedFormat) && tier === "free" && (
                  <Link href="/settings" className="text-[var(--text-xs)] text-primary underline">
                    Upgrade to export
                  </Link>
                )}
                {selectedFormat.needsOpenAi && !hasOpenAiKey && (
                  <p className="text-[var(--text-xs)] text-muted-foreground/70">
                    Requires OpenAI on the server for narration.
                  </p>
                )}
              </fieldset>

              <fieldset className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <legend className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-muted-foreground/80">
                    Sections
                  </legend>
                  <button
                    type="button"
                    disabled={availableSectionIds.length === 0}
                    onClick={selectAllSections}
                    className="text-[var(--text-xs)] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    Select all
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {SECTION_OPTIONS.map((s) => {
                    const hasContent = availability[s.id as ExportSectionId];
                    return (
                      <label
                        key={s.id}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-2 py-1.5 text-[var(--text-xs)]",
                          hasContent ? "cursor-pointer hover:bg-muted/[0.06]" : "cursor-not-allowed opacity-50",
                        )}
                      >
                        <input
                          type="checkbox"
                          disabled={!hasContent}
                          checked={sections.includes(s.id)}
                          onChange={() => toggleSection(s.id)}
                        />
                        <span>{s.label}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {format === "pdf" && (
                <div className="space-y-2 rounded-lg border border-border/40 bg-muted/[0.06] px-3 py-2.5 text-[var(--text-xs)]">
                  <label className="flex items-center justify-between gap-2">
                    <span>Paper size</span>
                    <select
                      value={paperSize}
                      onChange={(e) => setPaperSize(e.target.value as "Letter" | "A4")}
                      className="rounded-md border border-border bg-background px-2 py-1"
                    >
                      <option value="Letter">Letter</option>
                      <option value="A4">A4</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={includeFigures} onChange={(e) => setIncludeFigures(e.target.checked)} />
                    Embed figures ({figureCount})
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
                    Compact layout
                  </label>
                </div>
              )}

              {format === "pptx" && (
                <div className="space-y-2 rounded-lg border border-border/40 bg-muted/[0.06] px-3 py-2.5 text-[var(--text-xs)]">
                  <label className="flex items-center justify-between gap-2">
                    <span>Theme</span>
                    <select
                      value={pptxTheme}
                      onChange={(e) => setPptxTheme(e.target.value as "light" | "dark")}
                      className="rounded-md border border-border bg-background px-2 py-1"
                    >
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={dense} onChange={(e) => setDense(e.target.checked)} />
                    Dense slides
                  </label>
                </div>
              )}

              {format === "podcast" && (
                <div className="space-y-2 rounded-lg border border-border/40 bg-muted/[0.06] px-3 py-2.5 text-[var(--text-xs)]">
                  <label className="flex items-center justify-between gap-2">
                    <span>Voice</span>
                    <select
                      value={voice}
                      onChange={(e) => setVoice(e.target.value as typeof voice)}
                      className="rounded-md border border-border bg-background px-2 py-1"
                    >
                      <option value="onyx">Onyx</option>
                      <option value="nova">Nova</option>
                      <option value="alloy">Alloy</option>
                    </select>
                  </label>
                  <label className="flex items-center justify-between gap-2">
                    <span>Length</span>
                    <select
                      value={lengthMinutes}
                      onChange={(e) => setLengthMinutes(Number(e.target.value) as 5 | 8 | 12)}
                      className="rounded-md border border-border bg-background px-2 py-1"
                    >
                      <option value={5}>5 min</option>
                      <option value={8}>8 min</option>
                      <option value={12}>12 min</option>
                    </select>
                  </label>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-border/40 px-5 py-3">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-md border border-border px-3 py-1.5 text-[var(--text-sm)] hover:bg-accent/40 motion-safe:duration-150"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || sections.length === 0 || !canSelectFormat(selectedFormat)}
                onClick={() => void handleGenerate()}
                className="rounded-md bg-primary px-3 py-1.5 text-[var(--text-sm)] text-primary-foreground disabled:opacity-40 motion-safe:duration-150"
              >
                {busy ? "Starting…" : "Generate"}
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-4 px-5 py-10 text-center">
            <ExportFormatIcon format={format} size="lg" />
            {phase === "progress" && (
              <>
                <div
                  className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground/80"
                  aria-hidden
                />
                <p className="text-[var(--text-sm)] text-foreground/90">
                  Building your {exportFormatLabel(format).toLowerCase()}…
                </p>
                <p className="max-w-xs text-[var(--text-xs)] text-muted-foreground/80">
                  This usually takes under a minute. You can close this dialog — progress stays visible in the analysis pane.
                </p>
              </>
            )}
            {phase === "ready" && progressRow?.download_url && (
              <>
                <p className="text-[var(--text-sm)] font-medium text-foreground">Your file is ready.</p>
                {progressRow.byte_size != null && (
                  <p className="text-[var(--text-xs)] tabular-nums text-muted-foreground/80">
                    {(progressRow.byte_size / 1024).toFixed(0)} KB
                  </p>
                )}
                <a
                  href={progressRow.download_url}
                  download
                  className="rounded-md bg-primary px-4 py-2 text-[var(--text-sm)] font-medium text-primary-foreground motion-safe:duration-150 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  Download {format.toUpperCase()}
                </a>
                {format === "podcast" && (
                  <audio controls src={progressRow.download_url} className="w-full max-w-sm h-8" preload="none" />
                )}
              </>
            )}
            {phase === "failed" && (
              <>
                <p className="text-[var(--text-sm)] text-destructive/90">
                  {progressRow?.error_message ?? "Something went wrong."}
                </p>
                <button
                  type="button"
                  onClick={() => setPhase("configure")}
                  className="text-[var(--text-xs)] font-medium text-muted-foreground underline hover:text-foreground"
                >
                  Try again
                </button>
              </>
            )}
            <button
              type="button"
              onClick={handleClose}
              className="mt-2 text-[var(--text-xs)] text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
