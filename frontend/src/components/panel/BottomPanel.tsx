"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

// Tab labels: compact weight + tracking; active state from data-active.
// `::after` indicator is refined in globals.css under `.analysis-panel-tabs`.
// `flex-none shrink-0` overrides TabsTrigger’s default `flex-1` so many tabs
// don’t compress in a narrow right/left column — the row scrolls instead.
const TAB_STYLE =
  "shrink-0 flex-none text-[var(--text-xs)] h-7 px-2.5 font-medium tracking-[0.01em] text-muted-foreground hover:text-foreground data-active:text-foreground";

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
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(
    () => new Set([effectiveTab]),
  );
  useEffect(() => {
    // Per audit §4.1/§6.3: inactive Radix tabs stay mounted by default,
    // which lets hidden panels hydrate and fetch data before the user
    // opens them. Mount each tab on first visit, then keep it hot.
    setMountedTabs((tabs) => {
      if (tabs.has(effectiveTab)) return tabs;
      const next = new Set(tabs);
      next.add(effectiveTab);
      return next;
    });
  }, [effectiveTab]);

  const icon = positionIcons[position] || positionIcons.right;

  // Overflow-menu state. Both the font-scale control cluster and the
  // pane-position cycle live behind a single kebab to keep the tab
  // strip visually quiet. Click-outside + Escape close the menu so it
  // behaves like the native menus elsewhere in the app.
  //
  // The menu is portaled to document.body so it always lands on the
  // topmost stacking context. An earlier version rendered it as a
  // child of the pane header and used `z-50`, which was fine in
  // isolation but got *visually* covered in focus mode: the pane
  // column itself sits inside a stacking context (z-20 in page.tsx)
  // and some TabsContent children (math, figures, lightbox backdrops)
  // can create their own higher contexts. A body-portal sidesteps
  // every one of those ancestor clipping / stacking traps.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuCoords, setMenuCoords] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (menuButtonRef.current?.contains(target)) return;
      setMenuOpen(false);
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
  // Re-compute the popover position whenever the menu opens *or* the
  // viewport changes (scroll / resize). Anchored to the kebab
  // button's current rect so the menu tracks its trigger even if the
  // user scrolls with the menu open. Uses useLayoutEffect so the
  // first paint never shows the menu at (0, 0).
  useLayoutEffect(() => {
    if (!menuOpen) { setMenuCoords(null); return; }
    const updateCoords = () => {
      const btn = menuButtonRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setMenuCoords({
        top: r.bottom + 6,
        right: Math.max(8, window.innerWidth - r.right),
      });
    };
    updateCoords();
    window.addEventListener("resize", updateCoords);
    window.addEventListener("scroll", updateCoords, true);
    return () => {
      window.removeEventListener("resize", updateCoords);
      window.removeEventListener("scroll", updateCoords, true);
    };
  }, [menuOpen]);

  const handleFollowUp = useCallback(async (question: string, context: string) => {
    setSelectionLoading(true);
    try {
      // Server now accepts `followup` as a first-class action so the
      // result persists with the right label across reloads. Earlier
      // versions sent `"question"` and overrode the action client-side
      // — that worked in-session but the server stored
      // `action: "question"` so on refresh the follow-up showed up
      // as "Answer" in history (which is what users were reporting).
      const result = await api.analyzeSelection(
        paperId,
        `${context}\n\nFollow-up question: ${question}`,
        "followup",
        { question },
      );
      // Per audit §11.3: keep server `selected_text` intact so hydration
      // doesn't rewrite the entry; surface the user's short prompt via
      // a separate `question` field for the threaded UI.
      const followUpResult = { ...result, action: "followup" as const, question };
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
      className="analysis-panel-tabs flex h-full flex-col"
    >
      <div className="flex h-[38px] min-w-0 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-3">
        {/* min-w-0 + overflow-x-auto: side panels stay narrow; tab row scrolls
            horizontally. Tab triggers must stay flex-none (see TAB_STYLE) or
            labels collapse. Light scrollbar so the strip is discoverable. */}
        <div className="min-h-0 min-w-0 flex-1 touch-pan-x overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-gutter:stable] analysis-tab-strip-scroll">
          <TabsList
            variant="line"
            className="inline-flex h-8 w-max flex-nowrap justify-start gap-1 p-0"
          >
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
                    <svg
                      className="mr-0.5 h-2.5 w-2.5 shrink-0 opacity-50"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      aria-hidden
                    >
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
                className={`${TAB_STYLE} data-active:[&>svg]:opacity-100`}
                title="Compare and ask questions across all papers in this session"
              >
                <svg
                  className="mr-0.5 h-3 w-3 shrink-0 opacity-70"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                </svg>
                Compare
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        {/* Overflow menu trigger. The actual popover is portaled to
            document.body (see below) so it can never be clipped or
            occluded by anything inside the analysis pane. */}
        <div className="relative shrink-0">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground data-open:bg-accent/60 data-open:[&_path]:text-foreground motion-safe:duration-150"
            data-open={menuOpen ? "" : undefined}
            title="Panel options — text size, pane position"
            aria-label="Panel options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <line x1="4" x2="4" y1="21" y2="14" />
              <line x1="4" x2="4" y1="10" y2="3" />
              <line x1="12" x2="12" y1="21" y2="12" />
              <line x1="12" x2="12" y1="8" y2="3" />
              <line x1="20" x2="20" y1="21" y2="16" />
              <line x1="20" x2="20" y1="12" y2="3" />
              <line x1="1" x2="7" y1="14" y2="14" />
              <line x1="9" x2="15" y1="8" y2="8" />
              <line x1="17" x2="23" y1="16" y2="16" />
            </svg>
          </button>
        </div>
      </div>

      {menuOpen && menuCoords && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: "fixed", top: menuCoords.top, right: menuCoords.right, zIndex: 1000 }}
          className="w-56 rounded-xl border border-border bg-popover text-popover-foreground shadow-xl p-2 animate-fade-in"
        >
          <div className="px-2 pt-1 pb-1 text-[var(--text-xs)] font-semibold text-muted-foreground/80">
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
              <span className="text-[var(--text-xs)] font-semibold leading-none">A−</span>
            </button>
            <button
              type="button"
              onClick={() => setAnalysisFontScale(1)}
              disabled={Math.abs(analysisFontScale - 1) < 1e-6}
              className="flex-1 h-7 inline-flex items-center justify-center rounded-md border border-border hover:bg-accent disabled:opacity-40 disabled:pointer-events-none text-[var(--text-xs)] font-medium tabular-nums"
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
              <span className="text-[var(--text-md)] font-semibold leading-none">A+</span>
            </button>
          </div>
          <div className="px-2 pb-2 text-[var(--text-xs)] text-muted-foreground/70 leading-snug">
            Saved across every paper and reload.
          </div>

          <div className="h-px bg-border/70 mx-1 my-1" />

          <div className="px-2 pt-1 pb-1 text-[var(--text-xs)] font-semibold text-muted-foreground/80">
            Pane position
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => { onCyclePosition(); setMenuOpen(false); }}
            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-[var(--text-sm)] hover:bg-accent transition-colors"
          >
            <span className="flex items-center gap-2 text-foreground/90">
              <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={icon.path} />
              </svg>
              {POSITION_LABEL[position]}
            </span>
            <span className="text-[var(--text-xs)] text-muted-foreground/80">{icon.next}</span>
          </button>
          <div className="px-2 pt-1 text-[var(--text-xs)] text-muted-foreground/70 leading-snug">
            Saved across every paper and reload.
          </div>
        </div>,
        document.body,
      )}

      <div className="analysis-scroll-fade min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div
          className="analysis-pane-v2 mx-auto min-h-dvh w-full max-w-3xl px-4 py-4 md:px-6 md:py-6"
          style={{ ["--analysis-font-scale" as string]: analysisFontScale }}
        >
          {showSelectionTab && mountedTabs.has("selection") && (
            <TabsContent value="selection" className="mt-0">
              <SelectionResultPanel
                result={selectionResult}
                loading={selectionLoading}
                history={selectionHistory}
                onFollowUp={handleFollowUp}
              />
            </TabsContent>
          )}
          {mountedTabs.has("summary") && (
            <TabsContent value="summary" className="mt-0"><SummaryPanel paperId={paperId} /></TabsContent>
          )}
          {mountedTabs.has("preread") && (
            <TabsContent value="preread" className="mt-0"><PreReadingPanel paperId={paperId} /></TabsContent>
          )}
          {mountedTabs.has("assume") && (
            <TabsContent value="assume" className="mt-0"><AssumptionsPanel paperId={paperId} /></TabsContent>
          )}
          {mountedTabs.has("qa") && (
            <TabsContent value="qa" className="mt-0"><QAPanel paperId={paperId} /></TabsContent>
          )}
          {mountedTabs.has("figures") && (
            <TabsContent value="figures" className="mt-0"><FiguresPanel paperId={paperId} /></TabsContent>
          )}
          {mountedTabs.has("notes") && (
            <TabsContent value="notes" className="mt-0"><NotesPanel paperId={paperId} /></TabsContent>
          )}
          {hasMultiplePapers && canAccess(tier, "multi-qa") && mountedTabs.has("compare") && (
            <TabsContent value="compare" className="mt-0"><CrossPaperPanel /></TabsContent>
          )}
        </div>
      </div>
    </Tabs>
  );
}
