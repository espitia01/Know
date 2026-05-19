"use client";

import { useEffect, useState } from "react";
import { useUserSettings } from "@/lib/UserSettingsContext";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore } from "@/lib/store";
import { useSelectionThread } from "@/lib/useSelectionThread";
import { FEATURE_TOOLTIPS } from "@/lib/tooltips";
import { useUserTier, canAccess } from "@/lib/UserTierContext";
import { OverflowMenu } from "@/components/analysis/OverflowMenu";
import { FAMILY_TO_VAR } from "@/lib/analysisFont";
import type { AnalysisFontFamily } from "@/lib/store";
import { cn } from "@/lib/utils";
import { SelectionResultPanel } from "./SelectionResultPanel";
import { PreReadingPanel } from "../sidebar/PreReadingPanel";
import { RelatedWorkPanel } from "../sidebar/RelatedWorkPanel";
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
  "shrink-0 flex-none h-8 rounded-md px-2.5 text-[var(--text-sm)] tracking-[-0.012em] font-medium text-muted-foreground/85 hover:text-foreground data-active:text-foreground data-active:font-medium";

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
    analysisFontScale, bumpAnalysisFontScale, setAnalysisFontScale,
    analysisFontFamily, setAnalysisFontFamily,
  } = useStore();
  const selectionResult = useStore((s) => s.selectionResultByPaper[paperId] ?? null);
  const selectionLoading = useStore((s) => s.selectionLoadingByPaper[paperId] ?? false);
  const selectionHistory = useStore((s) => s.selectionHistoryByPaper[paperId] ?? []);
  const { user } = useUserTier();
  const tier = user?.tier || "free";
  // Cross-paper QA is a Researcher-only tab that appears once the
  // session has 2+ papers. Researcher tier owns the "multi-qa" feature.
  const sessionPapers = useStore((s) => s.sessionPapers);
  const showCrossPaperTab =
    canAccess(tier, "multi-qa") && sessionPapers.length >= 2;

  // Stage 2: follow-ups stream through the migrated Next.js +
  // AI SDK route via the same hook the selection toolbar uses.
  // Hook handles abort, history upsert, error formatting, and usage
  // refresh — `handleFollowUp` only has to call .start().
  const selectionThread = useSelectionThread(paperId);
  const { fastModel, allowedModels } = useUserSettings();
  const [followUpModelOverride, setFollowUpModelOverride] = useState<string | null>(null);

  // Keep the Selections tab pinned whenever the user has at least one
  // past selection for this paper. Previously it only appeared while a
  // result was actively displayed, which meant a hard refresh wiped the
  // tab even though the server still had the full history — users had to
  // make a fresh selection just to get back into their prior analyses.
  // The tab hides again only when history is empty AND nothing is
  // streaming.
  const showSelectionTab =
    selectionLoading || selectionResult !== null || selectionHistory.length > 0;
  const effectiveTab =
    activeTab === "compare" && !showCrossPaperTab
      ? "summary"
      : activeTab === "selection" && !showSelectionTab
        ? "summary"
        : activeTab;
  /** Mount core analysis tabs immediately so Prepare/Summary pipelines start without visiting each tab first. */
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(() => {
    const next = new Set<string>([effectiveTab]);
    next.add("summary");
    next.add("preread");
    next.add("assume");
    return next;
  });
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

  const handleFollowUp = async (question: string, context: string) => {
    // Pack the prior passage + analysis blob as the "selected text"
    // input — the prompt builder treats it as conversation history.
    const payloadText = `${context}\n\nFollow-up question: ${question}`;
    selectionThread.start({
      action: "followup",
      selectedText: payloadText,
      question,
      model: followUpModelOverride ?? undefined,
    });
    setFollowUpModelOverride(null);
  };

  return (
    <Tabs
      value={effectiveTab}
      onValueChange={setActiveTab}
      className="analysis-panel-tabs flex h-full flex-col"
    >
      <div className="flex h-10 min-w-0 shrink-0 items-center gap-1 border-b border-border/40 bg-muted/[0.06] px-3 dark:bg-muted/[0.08]">
        {/* min-w-0 + overflow-x-auto: side panels stay narrow; tab row scrolls
            horizontally. Tab triggers must stay flex-none (see TAB_STYLE) or
            labels collapse. Light scrollbar so the strip is discoverable. */}
        <div className="min-h-0 min-w-0 flex-1 touch-pan-x overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-gutter:stable] analysis-tab-strip-scroll">
          <TabsList
            variant="line"
            className="inline-flex h-9 w-max flex-nowrap justify-start gap-0.5 p-0"
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
            {showCrossPaperTab && (
              <TabsTrigger
                value="compare"
                className={TAB_STYLE}
                title={`Ask questions across all ${sessionPapers.length} papers in this session`}
              >
                Cross-paper
              </TabsTrigger>
            )}
            {([
              { value: "preread", feature: "prepare", label: "Prepare" },
              { value: "assume", feature: "assumptions", label: "Assumptions" },
              { value: "qa", feature: "qa", label: "Q&A" },
              { value: "figures", feature: "figures", label: "Figures" },
              { value: "notes", feature: "notes", label: "Notes" },
              { value: "sources", feature: "prepare", label: "Related" },
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
                      className="mr-0.5 h-2 w-2 shrink-0 opacity-30"
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
          </TabsList>
        </div>

        <OverflowMenu
          ariaLabel="Panel options"
          buttonProps={{
            className:
              "shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground data-[popup-open]:bg-accent/60 motion-safe:duration-150",
            title: "Panel options — text size, font, pane position",
            "aria-label": "Panel options",
          }}
          triggerInner={
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
          }
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
              <span className="text-[var(--text-xs)] font-semibold leading-none">A+</span>
            </button>
          </div>
          <div className="px-2 pb-2 text-[var(--text-xs)] text-muted-foreground/70 leading-snug">
            Saved across every paper and reload.
          </div>

          <div className="px-2 pt-1 pb-1 text-[var(--text-xs)] font-semibold text-muted-foreground/80">
            Font family
          </div>
          <div className="grid grid-cols-2 gap-1 px-1 pb-2">
            {(
              [
                { id: "sans", label: "Sans" },
                { id: "serif", label: "Serif" },
                { id: "times", label: "Times" },
                { id: "arial", label: "Arial" },
                { id: "mono", label: "Mono" },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setAnalysisFontFamily(f.id as AnalysisFontFamily)}
                className={cn(
                  "h-7 inline-flex items-center justify-center rounded-md border text-[var(--text-xs)] font-medium",
                  analysisFontFamily === f.id
                    ? "border-foreground/35 bg-accent/50 text-foreground"
                    : "border-border bg-transparent text-foreground/80 hover:bg-accent/40",
                )}
                style={{ fontFamily: FAMILY_TO_VAR[f.id as AnalysisFontFamily] }}
                aria-pressed={analysisFontFamily === f.id}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="my-1 mx-1 h-px bg-border/70" />

          <div className="px-2 pt-1 pb-1 text-[var(--text-xs)] font-semibold text-muted-foreground/80">
            Pane position
          </div>
          <button
            type="button"
            onClick={onCyclePosition}
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
        </OverflowMenu>
      </div>

      <div className="analysis-scroll-fade min-h-0 flex-1 overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]">
        <div
          className="analysis-pane-v2 mx-auto w-full max-w-3xl px-4 py-5 md:px-8 md:py-7"
          style={{
            ["--analysis-font-scale" as string]: analysisFontScale,
            ["--analysis-font-family" as string]: FAMILY_TO_VAR[analysisFontFamily],
          }}
        >
          {showSelectionTab && mountedTabs.has("selection") && (
            <TabsContent value="selection" className="mt-0">
              <SelectionResultPanel
                paperId={paperId}
                result={selectionResult}
                loading={selectionLoading}
                history={selectionHistory}
                onFollowUp={handleFollowUp}
                followUpModel={followUpModelOverride ?? fastModel}
                followUpAllowedModels={allowedModels}
                onFollowUpModelChange={setFollowUpModelOverride}
              />
            </TabsContent>
          )}
          {mountedTabs.has("summary") && (
            <TabsContent value="summary" className="mt-0"><SummaryPanel paperId={paperId} /></TabsContent>
          )}
          {showCrossPaperTab && mountedTabs.has("compare") && (
            <TabsContent value="compare" className="mt-0">
              <CrossPaperPanel />
            </TabsContent>
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
          {mountedTabs.has("sources") && (
            <TabsContent value="sources" className="mt-0"><RelatedWorkPanel paperId={paperId} /></TabsContent>
          )}
        </div>
      </div>
    </Tabs>
  );
}
