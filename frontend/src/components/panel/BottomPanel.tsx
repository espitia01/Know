"use client";

import { useCallback } from "react";
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

const TAB_STYLE =
  "text-[11px] h-7 px-3 rounded-lg font-medium transition-all data-active:bg-foreground data-active:text-background data-active:shadow-sm";

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
  const { activeTab, setActiveTab, selectionResult, selectionLoading, selectionHistory, setSelectionResult, setSelectionLoading, addSelectionToHistory, sessionPapers, bumpUsageRefresh } = useStore();
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
      <div className="shrink-0 flex items-center gap-1 px-2 pt-2 pb-1.5 border-b border-border glass-subtle min-w-0">
        <div className="overflow-x-auto scrollbar-hide min-w-0 flex-1">
          <TabsList className="h-8 gap-0.5 bg-transparent p-0 flex-nowrap inline-flex w-max">
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

        <button
          onClick={onCyclePosition}
          className="p-1.5 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-colors shrink-0"
          title={icon.next}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d={icon.path} />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-4 py-4">
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
