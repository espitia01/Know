"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUserSettings } from "@/lib/UserSettingsContext";
import { useReadingState } from "@/hooks/useReadingState";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore } from "@/lib/store";
import type { useSelectionThread } from "@/lib/useSelectionThread";
import { EMPTY_SELECTION_LIST } from "@/lib/store";
import { FEATURE_TOOLTIPS } from "@/lib/tooltips";
import { useUserTier, canAccess } from "@/lib/UserTierContext";
import { AnalysisPanelMenu } from "./AnalysisPanelMenu";
import { SelectionResultPanel } from "./SelectionResultPanel";
import { FAMILY_TO_VAR } from "@/lib/analysisFont";
import { PreReadingPanel } from "../sidebar/PreReadingPanel";
import { RelatedWorkPanel } from "../sidebar/RelatedWorkPanel";
import { QAPanel } from "../sidebar/QAPanel";
import { AssumptionsPanel } from "../sidebar/AssumptionsPanel";
import { NotesHost } from "../sidebar/NotesHost";
import { SummaryPanel } from "../sidebar/SummaryPanel";
import { FiguresPanel } from "../sidebar/FiguresPanel";
import { TablesPanel } from "../sidebar/TablesPanel";
import { CodePanel } from "../sidebar/CodePanel";
import { analysisFiguresFromPaper } from "@/lib/ocrFigures";
import { tablesFromPaper, codeBlocksFromPaper, paperWithOcrMarkdown } from "@/lib/ocrArtifacts";
import { usePaperOcrMarkdown } from "@/hooks/usePaperOcrMarkdown";
import { CrossPaperPanel } from "../sidebar/CrossPaperPanel";
import { ExportModal } from "../export/ExportModal";
import { ExportStatusBar } from "../export/ExportStatusBar";
import { api } from "@/lib/api";

export type PanelPosition = "right" | "left" | "bottom";

type SelectionThread = ReturnType<typeof useSelectionThread>;

interface AnalysisPanelProps {
  paperId: string;
  position: PanelPosition;
  onCyclePosition: () => void;
  selectionThread: SelectionThread;
}

// Tab labels: compact weight + tracking; active state from data-active.
// `::after` indicator is refined in globals.css under `.analysis-panel-tabs`.
// `flex-none shrink-0` overrides TabsTrigger’s default `flex-1` so many tabs
// don’t compress in a narrow right/left column — the row scrolls instead.
const TAB_STYLE =
  "shrink-0 flex-none h-8 rounded-md px-2.5 text-[var(--text-sm)] tracking-[-0.012em] font-medium text-muted-foreground/85 hover:text-foreground data-active:text-foreground data-active:font-medium";

export function AnalysisPanel({ paperId, position, onCyclePosition, selectionThread }: AnalysisPanelProps) {
  const {
    activeTab, setActiveTab,
    analysisFontScale, bumpAnalysisFontScale, setAnalysisFontScale,
    analysisFontFamily, setAnalysisFontFamily,
  } = useStore();
  const { saveProgress: saveReadingProgress } = useReadingState(paperId);
  const exportUnreadBadge = useStore((s) => s.exportUnreadBadge);
  const setExportUnreadBadge = useStore((s) => s.setExportUnreadBadge);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [hasOpenAiKey, setHasOpenAiKey] = useState(true);

  useEffect(() => {
    void api.getSettings().then((s) => setHasOpenAiKey(Boolean(s.has_openai_key ?? true)));
  }, []);
  // First tab value we observe is whatever the paper page restored (or the
  // store's default) — don't report it back, the server already knows.
  const lastReportedTabRef = useRef<string | null>(null);
  useEffect(() => {
    if (!paperId || !activeTab) return;
    if (lastReportedTabRef.current === null) {
      lastReportedTabRef.current = activeTab;
      return;
    }
    if (lastReportedTabRef.current === activeTab) return;
    lastReportedTabRef.current = activeTab;
    saveReadingProgress({ last_tab: activeTab });
  }, [activeTab, paperId, saveReadingProgress]);
  const selectionResult = useStore((s) => s.selectionResultByPaper[paperId] ?? null);
  const selectionLoading = useStore((s) => s.selectionLoadingByPaper[paperId] ?? false);
  const selectionHistory = useStore(
    (s) => s.selectionHistoryByPaper[paperId] ?? EMPTY_SELECTION_LIST,
  );
  const { user } = useUserTier();
  const tier = user?.tier || "free";
  // Cross-paper QA is a Researcher-only tab that appears once the
  // session has 2+ papers. Researcher tier owns the "multi-qa" feature.
  const sessionPapers = useStore((s) => s.sessionPapers);
  const showCrossPaperTab =
    canAccess(tier, "multi-qa") && sessionPapers.length >= 2;

  // Follow-ups use the page-level `useSelectionThread` instance so we
  // never mount two `useObject` hooks with the same stream id.
  const { fastModel, allowedModels } = useUserSettings();
  const [followUpModelOverride, setFollowUpModelOverride] = useState<string | null>(null);

  // Keep the Selections tab pinned whenever the user has at least one
  // past selection for this paper. Previously it only appeared while a
  // result was actively displayed, which meant a hard refresh wiped the
  // tab even though the server still had the full history — users had to
  // make a fresh selection just to get back into their prior analyses.
  // The tab hides again only when history is empty AND nothing is
  // streaming.
  const cachedForPanel = useStore(useCallback((s) => s.papersById[paperId], [paperId]));
  const panelPaper = useStore((s) => s.paper);
  const effectivePaper = panelPaper?.id === paperId ? panelPaper : cachedForPanel;
  const cachedSelections =
    (effectivePaper?.id === paperId
      ? effectivePaper?.cached_analysis?.selections?.length
      : 0) ?? 0;
  const showSelectionTab =
    selectionLoading ||
    selectionResult !== null ||
    selectionHistory.length > 0 ||
    cachedSelections > 0;

  const ocrMarkdown = usePaperOcrMarkdown(paperId);
  const paperForArtifacts = useMemo(
    () => paperWithOcrMarkdown(effectivePaper, ocrMarkdown),
    [effectivePaper, ocrMarkdown],
  );
  const showFiguresTab = analysisFiguresFromPaper(effectivePaper).length > 0;
  const showTablesTab = tablesFromPaper(paperForArtifacts).length > 0;
  const showCodeTab = codeBlocksFromPaper(paperForArtifacts).length > 0;

  const effectiveTab =
    activeTab === "compare" && !showCrossPaperTab
      ? "summary"
      : activeTab === "selection" && !showSelectionTab
        ? "summary"
        : activeTab === "figures" && !showFiguresTab
          ? "summary"
          : activeTab === "tables" && !showTablesTab
            ? "summary"
            : activeTab === "code" && !showCodeTab
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
  const handleTabChange = useCallback(
    (tab: string) => {
      if (tab === "compare" && !showCrossPaperTab) return;
      if (tab === "selection" && !showSelectionTab) return;
      if (tab === "figures" && !showFiguresTab) return;
      if (tab === "tables" && !showTablesTab) return;
      if (tab === "code" && !showCodeTab) return;
      setActiveTab(tab);
    },
    [
      showCrossPaperTab,
      showSelectionTab,
      showFiguresTab,
      showTablesTab,
      showCodeTab,
      setActiveTab,
    ],
  );

  useEffect(() => {
    if (activeTab === "compare" && !showCrossPaperTab) {
      setActiveTab("summary");
    } else if (activeTab === "selection" && !showSelectionTab) {
      setActiveTab("summary");
    } else if (activeTab === "figures" && !showFiguresTab) {
      setActiveTab("summary");
    } else if (activeTab === "tables" && !showTablesTab) {
      setActiveTab("summary");
    } else if (activeTab === "code" && !showCodeTab) {
      setActiveTab("summary");
    }
  }, [
    activeTab,
    showCrossPaperTab,
    showSelectionTab,
    showFiguresTab,
    showTablesTab,
    showCodeTab,
    setActiveTab,
  ]);

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
    // Keep the override across follow-ups in this thread — once the
    // user picks Haiku for follow-ups they expect the next one to
    // stay on Haiku, not snap back to the default fast model.
  };

  return (
    <>
    <Tabs
      value={effectiveTab}
      onValueChange={handleTabChange}
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
              ...(showFiguresTab
                ? [{ value: "figures" as const, feature: "figures" as const, label: "Figures" }]
                : []),
              ...(showTablesTab
                ? [{ value: "tables" as const, feature: "figures" as const, label: "Tables" }]
                : []),
              ...(showCodeTab
                ? [{ value: "code" as const, feature: "figures" as const, label: "Code" }]
                : []),
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

        <AnalysisPanelMenu
          open={panelMenuOpen}
          onOpenChange={setPanelMenuOpen}
          exportUnreadBadge={exportUnreadBadge}
          onExportBadgeClear={() => setExportUnreadBadge(false)}
          onExportOpen={() => setExportModalOpen(true)}
          analysisFontScale={analysisFontScale}
          bumpAnalysisFontScale={bumpAnalysisFontScale}
          setAnalysisFontScale={setAnalysisFontScale}
          analysisFontFamily={analysisFontFamily}
          setAnalysisFontFamily={setAnalysisFontFamily}
          position={position}
          onCyclePosition={onCyclePosition}
        />
      </div>

      <ExportStatusBar paperId={paperId} />

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
          {showFiguresTab && mountedTabs.has("figures") && (
            <TabsContent value="figures" className="mt-0"><FiguresPanel paperId={paperId} /></TabsContent>
          )}
          {showTablesTab && mountedTabs.has("tables") && (
            <TabsContent value="tables" className="mt-0"><TablesPanel paperId={paperId} /></TabsContent>
          )}
          {showCodeTab && mountedTabs.has("code") && (
            <TabsContent value="code" className="mt-0"><CodePanel paperId={paperId} /></TabsContent>
          )}
          {mountedTabs.has("notes") && (
            <TabsContent value="notes" className="mt-0"><NotesHost paperId={paperId} /></TabsContent>
          )}
          {mountedTabs.has("sources") && (
            <TabsContent value="sources" className="mt-0"><RelatedWorkPanel paperId={paperId} /></TabsContent>
          )}
        </div>
      </div>
    </Tabs>
      <ExportModal
        paperId={paperId}
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        hasOpenAiKey={hasOpenAiKey}
      />
    </>
  );
}
