"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useShallow } from "zustand/react/shallow";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { useUserTier, canAccess } from "@/lib/UserTierContext";
import { cn } from "@/lib/utils";
import {
  getExportSectionAvailability,
  type ExportSectionId,
} from "@/lib/exportSectionAvailability";

const SECTION_OPTIONS = [
  { id: "summary", label: "Summary", hint: "Overview, contributions, methods, results" },
  { id: "qa", label: "Q&A", hint: "Your questions and model answers" },
  { id: "notes", label: "Notes", hint: "Saved notes from reading" },
  { id: "highlights", label: "Highlights", hint: "Marked passages and annotations" },
  { id: "selection", label: "Selection history", hint: "Explain / derive results" },
  { id: "assumptions", label: "Assumptions", hint: "Explicit and implicit assumptions" },
  { id: "figures", label: "Figures", hint: "Figure analyses and captions" },
  { id: "cross", label: "Cross-paper Q&A", hint: "Session cross-paper answers" },
  { id: "related", label: "Related work", hint: "Bibliography and cited-by" },
  { id: "prepare", label: "Prepare", hint: "Definitions and concepts" },
] as const;

const FORMATS = [
  {
    id: "pdf" as const,
    label: "PDF document",
    feature: "export-pdf" as const,
    blurb: "Print-ready report with a cover page, table of contents, and one section per analysis tab.",
    details: ["Letter or A4 page size", "Embedded figures at readable resolution", "Math rendered for print"],
    bestFor: "Archiving, sharing with advisors, or reading offline",
  },
  {
    id: "pptx" as const,
    label: "PowerPoint deck",
    feature: "export-pptx" as const,
    blurb: "16:9 slide deck — cover slide plus paginated section slides with bullet hierarchy.",
    details: ["Light or dark theme", "One section per slide, or dense multi-bullet layout", "Math as embedded images"],
    bestFor: "Lab meetings, journal clubs, and conference prep",
  },
  {
    id: "podcast" as const,
    label: "Podcast (MP3)",
    feature: "export-podcast" as const,
    blurb: "Single-speaker academic walkthrough — a measured lecture, not a chatty two-host show.",
    details: ["5, 8, or 12 minute target length", "Onyx, Nova, or Alloy voice", "Intro + section narration + outro"],
    bestFor: "Commute listening or rehearsing a talk",
    needsOpenAi: true,
  },
];

type ExportFormat = (typeof FORMATS)[number]["id"];

interface ExportModalProps {
  paperId: string;
  open: boolean;
  onClose: () => void;
  hasOpenAiKey?: boolean;
}

function estimateSize(
  format: ExportFormat,
  sections: string[],
  figureCount: number,
  podcastMinutes: number,
): string {
  if (format === "podcast") return `~${podcastMinutes} min audio (+30 s intro/outro)`;
  if (format === "pptx") {
    const slides = 1 + Math.max(1, sections.length);
    return `~${Math.round(slides * 140)} KB · ${slides} slides`;
  }
  const kb = 120 + sections.length * 24 + figureCount * 60;
  return `~${kb} KB`;
}

export function ExportModal({ paperId, open, onClose, hasOpenAiKey = true }: ExportModalProps) {
  const { user: tierUser } = useUserTier();
  const tier = tierUser?.tier || "free";
  const setExport = useStore((s) => s.setExport);
  const setExportToast = useStore((s) => s.setExportToast);
  const setExportMenuOpen = useStore((s) => s.setExportMenuOpen);
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
  const wasOpenRef = useRef(false);

  const selectedFormat = FORMATS.find((f) => f.id === format)!;
  const canSelectFormat = (f: (typeof FORMATS)[number]) => {
    if (!canAccess(tier, f.feature)) return false;
    if (f.needsOpenAi && !hasOpenAiKey) return false;
    return true;
  };

  const estimate = useMemo(
    () => estimateSize(format, sections, figureCount, lengthMinutes),
    [format, sections, figureCount, lengthMinutes],
  );

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    const justOpened = !wasOpenRef.current;
    wasOpenRef.current = true;

    setSections((prev) => {
      const kept = prev.filter((id) => availableSectionIds.includes(id as ExportSectionId));
      if (kept.length > 0) return kept;
      if (availableSectionIds.length === 0) return kept;
      if (justOpened || prev.length === 0) {
        return availableSectionIds.slice(0, Math.min(2, availableSectionIds.length));
      }
      return kept;
    });
  }, [open, availableSectionIds]);

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
      setExportToast("Export started — track progress in Panel options → Recent exports.");
      setExportMenuOpen(true);
      onClose();
    } catch (e) {
      setExportToast(e instanceof Error ? e.message : "Export failed");
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

  const modal = (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal
      aria-label="Export analysis"
      onClick={onClose}
    >
      <div
        className="flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border/50 bg-popover shadow-[var(--shadow-sm)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border/40 px-5 py-4">
          <h2 className="font-display text-[var(--text-base)] font-semibold tracking-[-0.02em]">
            Export analysis
          </h2>
          <p className="mt-1 text-[var(--text-xs)] leading-relaxed text-muted-foreground/85">
            Generate a downloadable artifact from{" "}
            <span className="text-foreground/90">{paperTitle}</span>. Pick a format, choose
            sections, then track the job under Panel options → Recent exports.
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[var(--text-sm)]">
          <fieldset className="space-y-2">
            <legend className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-muted-foreground/80">
              Output format
            </legend>
            <div className="space-y-2">
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
                      "w-full rounded-lg border px-3 py-2.5 text-left transition-colors motion-safe:duration-150",
                      selected
                        ? "border-foreground/25 bg-card/30"
                        : "border-border/50 bg-transparent hover:bg-muted/[0.08]",
                      !allowed && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-foreground">{f.label}</span>
                      {!allowed && tier === "free" && f.feature !== "export-podcast" && (
                        <Link
                          href="/settings"
                          className="shrink-0 text-[var(--text-xs)] text-primary underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Upgrade
                        </Link>
                      )}
                    </div>
                    <p className="mt-1 text-[var(--text-xs)] leading-relaxed text-muted-foreground/85">
                      {f.blurb}
                    </p>
                    <ul className="mt-1.5 space-y-0.5 text-[var(--text-xs)] text-muted-foreground/75">
                      {f.details.map((d) => (
                        <li key={d} className="flex gap-1.5">
                          <span aria-hidden>·</span>
                          <span>{d}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1.5 text-[var(--text-xs)] text-muted-foreground/70">
                      Best for: {f.bestFor}
                    </p>
                    {f.needsOpenAi && !hasOpenAiKey && (
                      <p className="mt-1 text-[var(--text-xs)] text-muted-foreground/70">
                        Requires KNOW_OPENAI_API_KEY on the server.
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <legend className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-muted-foreground/80">
                Sections to include
              </legend>
              <button
                type="button"
                disabled={availableSectionIds.length === 0}
                onClick={selectAllSections}
                className="text-[var(--text-xs)] font-medium text-muted-foreground transition-colors motion-safe:duration-150 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Select all
              </button>
            </div>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {SECTION_OPTIONS.map((s) => {
                const hasContent = availability[s.id as ExportSectionId];
                return (
                <label
                  key={s.id}
                  className={cn(
                    "flex items-start gap-2 rounded-md border border-transparent px-2 py-1.5",
                    hasContent ? "cursor-pointer hover:bg-muted/[0.06]" : "cursor-not-allowed opacity-50",
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={!hasContent}
                    checked={sections.includes(s.id)}
                    onChange={() => toggleSection(s.id)}
                  />
                  <span className="min-w-0">
                    <span className="block text-[var(--text-xs)] font-medium">{s.label}</span>
                    <span className="block text-[10px] leading-snug text-muted-foreground/75">
                      {hasContent ? s.hint : "No content yet"}
                    </span>
                  </span>
                </label>
              );
              })}
            </div>
          </fieldset>

          {format === "pdf" && (
            <div className="space-y-2 rounded-lg border border-border/40 bg-muted/[0.06] px-3 py-2.5">
              <p className="text-[var(--text-xs)] font-semibold text-muted-foreground/80">PDF options</p>
              <label className="flex items-center justify-between gap-2 text-[var(--text-xs)]">
                <span>Paper size</span>
                <select
                  value={paperSize}
                  onChange={(e) => setPaperSize(e.target.value as "Letter" | "A4")}
                  className="rounded-md border border-border bg-background px-2 py-1"
                >
                  <option value="Letter">US Letter</option>
                  <option value="A4">A4</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-[var(--text-xs)]">
                <input type="checkbox" checked={includeFigures} onChange={(e) => setIncludeFigures(e.target.checked)} />
                Embed figure images
              </label>
              <label className="flex items-center gap-2 text-[var(--text-xs)]">
                <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
                Compact layout (smaller section headers)
              </label>
            </div>
          )}

          {format === "pptx" && (
            <div className="space-y-2 rounded-lg border border-border/40 bg-muted/[0.06] px-3 py-2.5">
              <p className="text-[var(--text-xs)] font-semibold text-muted-foreground/80">Slide options</p>
              <label className="flex items-center justify-between gap-2 text-[var(--text-xs)]">
                <span>Theme</span>
                <select
                  value={pptxTheme}
                  onChange={(e) => setPptxTheme(e.target.value as "light" | "dark")}
                  className="rounded-md border border-border bg-background px-2 py-1"
                >
                  <option value="light">Light background</option>
                  <option value="dark">Dark background</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-[var(--text-xs)]">
                <input type="checkbox" checked={dense} onChange={(e) => setDense(e.target.checked)} />
                Dense slides (more bullets per slide)
              </label>
            </div>
          )}

          {format === "podcast" && (
            <div className="space-y-2 rounded-lg border border-border/40 bg-muted/[0.06] px-3 py-2.5">
              <p className="text-[var(--text-xs)] font-semibold text-muted-foreground/80">Audio options</p>
              <label className="flex items-center justify-between gap-2 text-[var(--text-xs)]">
                <span>Narrator voice</span>
                <select
                  value={voice}
                  onChange={(e) => setVoice(e.target.value as typeof voice)}
                  className="rounded-md border border-border bg-background px-2 py-1"
                >
                  <option value="onyx">Onyx — measured, male</option>
                  <option value="nova">Nova — warm, female</option>
                  <option value="alloy">Alloy — neutral</option>
                </select>
              </label>
              <label className="flex items-center justify-between gap-2 text-[var(--text-xs)]">
                <span>Target length</span>
                <select
                  value={lengthMinutes}
                  onChange={(e) => setLengthMinutes(Number(e.target.value) as 5 | 8 | 12)}
                  className="rounded-md border border-border bg-background px-2 py-1"
                >
                  <option value={5}>5 minutes</option>
                  <option value={8}>8 minutes</option>
                  <option value={12}>12 minutes</option>
                </select>
              </label>
            </div>
          )}

          <p className="text-[var(--text-xs)] text-muted-foreground/80">
            Estimated {format === "podcast" ? "duration" : "size"}: {estimate}
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-border/40 px-5 py-3">
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
              !canSelectFormat(selectedFormat)
            }
            onClick={() => void handleGenerate()}
            className="rounded-md bg-primary px-3 py-1.5 text-[var(--text-sm)] text-primary-foreground disabled:opacity-40 motion-safe:duration-150"
          >
            {busy ? "Starting…" : "Generate export"}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
