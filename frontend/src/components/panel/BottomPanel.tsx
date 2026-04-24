"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { FEATURE_TOOLTIPS } from "@/lib/tooltips";
import { useUserTier, canAccess } from "@/lib/UserTierContext";
import { SelectionResultPanel } from "./SelectionResultPanel";
import { PreReadingPanel } from "../sidebar/PreReadingPanel";
import { QAPanel } from "../sidebar/QAPanel";
import { AssumptionsPanel } from "../sidebar/AssumptionsPanel";
import { NotesPanel } from "../sidebar/NotesPanel";
import { SummaryPanel } from "../sidebar/SummaryPanel";
import { FiguresPanel } from "../sidebar/FiguresPanel";
import { CrossPaperPanel } from "../sidebar/CrossPaperPanel";

export type PanelPosition = "right" | "left" | "bottom";

interface AnalysisPanelProps {
  paperId: string;
  position: PanelPosition;
  onCyclePosition: () => void;
}

const POSITION_LABEL: Record<PanelPosition, string> = {
  right: "Right",
  bottom: "Bottom",
  left: "Left",
};

// Shared tab style — underlined, in the spirit of Linear / Things /
// Notion. We rely on the base TabsList `variant="line"` for the actual
// underline geometry (it draws a hairline `::after` pseudo-element that
// fades in on the active tab) and only override the text weight and
// padding so the labels feel like section headings rather than pills.
const TAB_STYLE =
  "text-[11.5px] h-7 px-2.5 font-medium text-muted-foreground/70 hover:text-foreground data-active:text-foreground [&::after]:h-[1.5px] [&::after]:rounded-full";

const positionIcons: Record<PanelPosition, { path: string; next: string }> = {
  right: {
    path: "M3 3h18v18H3V3zm12 0v18",
    next: "Move to bottom",
  },
  bottom: {
    path: "M3 3h18v18H3V3zm0 12h18",
    next: "Move to left",
  },
  left: {
    path: "M3 3h18v18H3V3zm6 0v18",
    next: "Move to right",
  },
};

export function AnalysisPanel({ paperId, position, onCyclePosition }: AnalysisPanelProps) {
  const {
    activeTab, setActiveTab,
    selectionResult, selectionLoading, selectionHistory,
    setSelectionResult, setSelectionLoading, addSelectionToHistory,
    sessionPapers, bumpUsageRefresh,
    analysisFontScale, bumpAnalysisFontScale, setAnalysisFontScale,
  } = useStore();
  const { user } = useUserTier();
  const tier = user?.tier || "free";

  // Keep the Selections tab pinned whenever the user has at least one
  // past selection for this paper. Previously it only appeared while a
  // result was actively displayed, which meant a hard refresh wiped the
  // tab even though the server still had the full history — users had to
  // make a fresh selection just to get back into their prior analyses.
  // The tab hides again only when history is empty AND nothing is
  // streaming.
  const showSelectionTab =
    selectionLoading || selectionResult !== null || selectionHistory.length > 0;
  const hasMultiplePapers = sessionPapers.length > 1;

  const effectiveTab = activeTab === "selection" && !showSelectionTab ? "summary" : activeTab;

  const icon = positionIcons[position] || positionIcons.right;

  // Overflow-menu state. Both the font-scale control cluster and the
  // pane-position cycle live behind a single kebab to keep the tab
  // strip visually quiet. Click-outside + Escape close the menu so it
  // behaves like the native menus elsewhere in the app.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const handleFollowUp = useCallback(async (question: string, context: string) => {
    setSelectionLoading(true);
    try {
      const result = await api.analyzeSelection(paperId, `${context}\n\nFollow-up question: ${question}`, "question");
      const followUpResult = { ...result, action: "followup" as const, selected_text: question };
      addSelectionToHistory(followUpResult);
      setSelectionResult(followUpResult);
      bumpUsageRefresh();
    } catch (e) {
      setSelectionResult({
        action: "followup",
        selected_text: question,
        explanation: `Follow-up failed: ${e instanceof Error ? e.message : "Unknown error"}`,
      });
    } finally {
      setSelectionLoading(false);
    }
  }, [paperId, setSelectionLoading, setSelectionResult, addSelectionToHistory, bumpUsageRefresh]);

  return (
    <Tabs
      value={effectiveTab}
      onValueChange={setActiveTab}
      className="flex flex-col h-full"
    >
      <div className="shrink-0 flex items-center gap-1 px-3 h-[38px] border-b border-border/70 bg-background/60 backdrop-blur-md min-w-0">
        <div className="overflow-x-auto scrollbar-hide min-w-0 flex-1">
          <TabsList variant="line" className="h-8 gap-1 p-0 flex-nowrap inline-flex w-max">
            {showSelectionTab && (
              <TabsTrigger value="selection" className={TAB_STYLE} title={FEATURE_TOOLTIPS["Selection"]}>
                Selection
                {selectionLoading && (
                  <span className="ml-1 w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                )}
              </TabsTrigger>
            )}
            <TabsTrigger value="summary" className={TAB_STYLE} title={FEATURE_TOOLTIPS["Summary"]}>Summary</TabsTrigger>
            {([
              { value: "preread", feature: "prepare", label: "Prepare" },
              { value: "assume", feature: "assumptions", label: "Assumptions" },
              { value: "qa", feature: "qa", label: "Q&A" },
              { value: "figures", feature: "figures", label: "Figures" },
              { value: "notes", feature: "notes", label: "Notes" },
            ] as const).map((tab) => {
              const locked = !canAccess(tier, tab.feature);
              return (
                <TabsTrigger
                  key={tab.value}
                  value={tab.value}
                  className={`${TAB_STYLE} ${locked ? "opacity-50" : ""}`}
                  title={FEATURE_TOOLTIPS[tab.label]}
                  disabled={locked}
                >
                  {locked && (
                    <svg className="w-3 h-3 mr-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                    </svg>
                  )}
                  {tab.label}
                </TabsTrigger>
              );
            })}
            {hasMultiplePapers && canAccess(tier, "multi-qa") && (
              <TabsTrigger
                value="compare"
                className={TAB_STYLE}
                title="Compare and ask questions across all papers in this session"
              >
                <svg className="w-3 h-3 mr-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                </svg>
                Compare
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        {/* Overflow menu — hides the secondary pane controls behind a
            single kebab so the tab bar reads cleanly at a glance. Both
            clusters (text-size and pane position) live here because
            they're "settings" rather than primary navigation. */}
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="p-1 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors data-open:bg-accent/60"
            data-open={menuOpen ? "" : undefined}
            title="Panel options"
            aria-label="Panel options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <circle cx="5"  cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1.5 w-56 rounded-xl border border-border bg-popover text-popover-foreground shadow-lg p-2 z-50 animate-fade-in"
            >
              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70">
                Text size
              </div>
              <div className="flex items-center gap-1 px-1 pb-2">
                <button
                  type="button"
                  onClick={() => bumpAnalysisFontScale(-0.1)}
                  disabled={analysisFontScale <= 0.85 + 1e-6}
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border hover:bg-accent disabled:opacity-40 disabled:pointer-events-none"
                  aria-label="Decrease text size"
                >
                  <span className="text-[11px] font-semibold leading-none">A−</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAnalysisFontScale(1)}
                  disabled={Math.abs(analysisFontScale - 1) < 1e-6}
                  className="flex-1 h-7 inline-flex items-center justify-center rounded-md border border-border hover:bg-accent disabled:opacity-40 disabled:pointer-events-none text-[11px] font-medium tabular-nums"
                  aria-label="Reset text size"
                >
                  {Math.round(analysisFontScale * 100)}%
                </button>
                <button
                  type="button"
                  onClick={() => bumpAnalysisFontScale(0.1)}
                  disabled={analysisFontScale >= 1.6 - 1e-6}
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border hover:bg-accent disabled:opacity-40 disabled:pointer-events-none"
                  aria-label="Increase text size"
                >
                  <span className="text-[13px] font-semibold leading-none">A+</span>
                </button>
              </div>

              <div className="h-px bg-border/70 mx-1 my-1" />

              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70">
                Pane position
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => { onCyclePosition(); setMenuOpen(false); }}
                className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-[12px] hover:bg-accent transition-colors"
              >
                <span className="flex items-center gap-2 text-foreground/90">
                  <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={icon.path} />
                  </svg>
                  {POSITION_LABEL[position]}
                </span>
                <span className="text-[10px] text-muted-foreground/80">{icon.next}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        <div
          className="px-5 py-5 max-w-3xl mx-auto w-full"
          style={{ ["--analysis-font-scale" as string]: analysisFontScale }}
        >
          {showSelectionTab && (
            <TabsContent value="selection" className="mt-0">
              <SelectionResultPanel
                result={selectionResult}
                loading={selectionLoading}
                history={selectionHistory}
                onFollowUp={handleFollowUp}
              />
            </TabsContent>
          )}
          <TabsContent value="summary" className="mt-0"><SummaryPanel paperId={paperId} /></TabsContent>
          <TabsContent value="preread" className="mt-0"><PreReadingPanel paperId={paperId} /></TabsContent>
          <TabsContent value="assume" className="mt-0"><AssumptionsPanel paperId={paperId} /></TabsContent>
          <TabsContent value="qa" className="mt-0"><QAPanel paperId={paperId} /></TabsContent>
          <TabsContent value="figures" className="mt-0"><FiguresPanel paperId={paperId} /></TabsContent>
          <TabsContent value="notes" className="mt-0"><NotesPanel paperId={paperId} /></TabsContent>
          {hasMultiplePapers && canAccess(tier, "multi-qa") && (
            <TabsContent value="compare" className="mt-0"><CrossPaperPanel /></TabsContent>
          )}
        </div>
      </div>
    </Tabs>
  );
}
