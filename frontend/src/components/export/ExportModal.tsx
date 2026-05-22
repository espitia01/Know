"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { useUserTier, canAccess } from "@/lib/UserTierContext";
import { cn } from "@/lib/utils";

const SECTION_OPTIONS = [
  { id: "summary", label: "Summary" },
  { id: "qa", label: "Q&A" },
  { id: "notes", label: "Notes" },
  { id: "highlights", label: "Highlights" },
  { id: "selection", label: "Selection history" },
  { id: "assumptions", label: "Assumptions" },
  { id: "figures", label: "Figures" },
  { id: "cross", label: "Cross-paper Q&A" },
  { id: "related", label: "Related work" },
  { id: "prepare", label: "Prepare" },
] as const;

type ExportFormat = "pdf" | "pptx" | "podcast";

interface ExportModalProps {
  paperId: string;
  open: boolean;
  onClose: () => void;
  hasOpenAiKey?: boolean;
}

function estimateSize(
  format: ExportFormat,
  sections: string[],
  qaCount: number,
  figureCount: number,
  podcastMinutes: number,
): string {
  if (format === "podcast") {
    return `~${podcastMinutes} min (+30 s intro/outro)`;
  }
  if (format === "pptx") {
    const slides = Math.max(1, sections.length) + Math.ceil(qaCount / 5);
    return `~${Math.round(slides * 140)} KB`;
  }
  const kb = 120 + qaCount * 8 + figureCount * 60;
  return `~${kb} KB`;
}

export function ExportModal({ paperId, open, onClose, hasOpenAiKey = true }: ExportModalProps) {
  const { user: tierUser } = useUserTier();
  const tier = tierUser?.tier || "free";
  const setExport = useStore((s) => s.setExport);
  const setExportToast = useStore((s) => s.setExportToast);
  const setExportMenuOpen = useStore((s) => s.setExportMenuOpen);
  const figureCount = useStore((s) => s.papersById[paperId]?.figures?.length ?? 0);

  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [sections, setSections] = useState<string[]>(["summary"]);
  const [paperSize, setPaperSize] = useState<"Letter" | "A4">("Letter");
  const [includeFigures, setIncludeFigures] = useState(true);
  const [compact, setCompact] = useState(false);
  const [pptxTheme, setPptxTheme] = useState<"light" | "dark">("light");
  const [dense, setDense] = useState(false);
  const [voice, setVoice] = useState<"onyx" | "nova" | "alloy">("onyx");
  const [lengthMinutes, setLengthMinutes] = useState<5 | 8 | 12>(8);
  const [busy, setBusy] = useState(false);

  const canPdf = canAccess(tier, "export-pdf");
  const canPptx = canAccess(tier, "export-pptx");
  const canPodcast = canAccess(tier, "export-podcast") && hasOpenAiKey;

  const estimate = useMemo(
    () => estimateSize(format, sections, 0, figureCount, lengthMinutes),
    [format, sections, figureCount, lengthMinutes],
  );

  if (!open) return null;

  async function handleGenerate() {
    const feature =
      format === "pdf" ? "export-pdf" : format === "pptx" ? "export-pptx" : "export-podcast";
    if (!canAccess(tier, feature)) return;
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
      const { export_id } = await api.requestExport(paperId, { format, sections, options });
      const row = await api.getExport(export_id);
      setExport(row);
      setExportToast("Export started — open Exports in the panel menu to track progress.");
      setExportMenuOpen(true);
      onClose();
    } catch (e) {
      setExportToast(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  function toggleSection(id: string) {
    setSections((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal
      aria-label="Export analysis"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-[var(--radius-lg)] border border-border/50 bg-popover p-4 shadow-[var(--shadow-sm)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-[var(--text-base)] font-semibold tracking-[-0.02em] mb-3">
          Export analysis
        </h2>

        <div className="space-y-3 text-[var(--text-sm)]">
          <fieldset>
            <legend className="text-[var(--text-xs)] font-semibold text-muted-foreground/80 mb-1">
              Format
            </legend>
            <div className="space-y-1">
              {(
                [
                  { id: "pdf" as const, label: "PDF", allowed: canPdf },
                  { id: "pptx" as const, label: "PowerPoint", allowed: canPptx },
                  {
                    id: "podcast" as const,
                    label: "Podcast (MP3)",
                    allowed: canPodcast,
                    hint: !hasOpenAiKey
                      ? "Audio synthesis requires the operator to set KNOW_OPENAI_API_KEY"
                      : undefined,
                  },
                ] as const
              ).map((f) => (
                <label
                  key={f.id}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1",
                    !f.allowed && "opacity-50",
                  )}
                  title={"hint" in f ? f.hint : undefined}
                >
                  <input
                    type="radio"
                    name="export-format"
                    checked={format === f.id}
                    disabled={!f.allowed}
                    onChange={() => setFormat(f.id)}
                  />
                  <span>{f.label}</span>
                  {!f.allowed && tier === "free" && (
                    <Link href="/settings" className="text-[var(--text-xs)] text-primary underline ml-auto">
                      Upgrade to Scholar
                    </Link>
                  )}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-[var(--text-xs)] font-semibold text-muted-foreground/80 mb-1">
              Sections
            </legend>
            <div className="grid grid-cols-2 gap-1">
              {SECTION_OPTIONS.map((s) => (
                <label key={s.id} className="flex items-center gap-1.5 text-[var(--text-xs)]">
                  <input
                    type="checkbox"
                    checked={sections.includes(s.id)}
                    onChange={() => toggleSection(s.id)}
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </fieldset>

          {format === "pdf" && (
            <div className="space-y-2 border-t border-border/40 pt-2">
              <label className="flex items-center justify-between gap-2">
                <span>Paper size</span>
                <select
                  value={paperSize}
                  onChange={(e) => setPaperSize(e.target.value as "Letter" | "A4")}
                  className="rounded-md border border-border bg-background px-2 py-1 text-[var(--text-xs)]"
                >
                  <option value="Letter">Letter</option>
                  <option value="A4">A4</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includeFigures}
                  onChange={(e) => setIncludeFigures(e.target.checked)}
                />
                Include figures
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
                Compact layout
              </label>
            </div>
          )}

          {format === "pptx" && (
            <div className="space-y-2 border-t border-border/40 pt-2">
              <label className="flex items-center justify-between gap-2">
                <span>Theme</span>
                <select
                  value={pptxTheme}
                  onChange={(e) => setPptxTheme(e.target.value as "light" | "dark")}
                  className="rounded-md border border-border bg-background px-2 py-1 text-[var(--text-xs)]"
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={dense} onChange={(e) => setDense(e.target.checked)} />
                Dense — multiple bullets per slide
              </label>
            </div>
          )}

          {format === "podcast" && (
            <div className="space-y-2 border-t border-border/40 pt-2">
              <label className="flex items-center justify-between gap-2">
                <span>Voice</span>
                <select
                  value={voice}
                  onChange={(e) => setVoice(e.target.value as typeof voice)}
                  className="rounded-md border border-border bg-background px-2 py-1 text-[var(--text-xs)]"
                >
                  <option value="onyx">Onyx — male, measured</option>
                  <option value="nova">Nova — female, warm</option>
                  <option value="alloy">Alloy — neutral</option>
                </select>
              </label>
              <label className="flex items-center justify-between gap-2">
                <span>Length</span>
                <select
                  value={lengthMinutes}
                  onChange={(e) => setLengthMinutes(Number(e.target.value) as 5 | 8 | 12)}
                  className="rounded-md border border-border bg-background px-2 py-1 text-[var(--text-xs)]"
                >
                  <option value={5}>5 min</option>
                  <option value={8}>8 min</option>
                  <option value={12}>12 min</option>
                </select>
              </label>
            </div>
          )}

          <p className="text-[var(--text-xs)] text-muted-foreground/80">
            Estimated {format === "podcast" ? "duration" : "size"}: {estimate}
          </p>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-[var(--text-sm)] hover:bg-accent/40 motion-safe:duration-150"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={
              busy ||
              sections.length === 0 ||
              (format === "pdf" && !canPdf) ||
              (format === "pptx" && !canPptx) ||
              (format === "podcast" && !canPodcast)
            }
            onClick={() => void handleGenerate()}
            className="rounded-md bg-primary px-3 py-1.5 text-[var(--text-sm)] text-primary-foreground disabled:opacity-40 motion-safe:duration-150"
          >
            {busy ? "Starting…" : "Generate"}
          </button>
        </div>
      </div>
    </div>
  );
}
