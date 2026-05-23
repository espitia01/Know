"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle } from "@/components/ThemeToggle";
import { FEATURE_TOOLTIPS } from "@/lib/tooltips";
import type { PaperSummary, SelectionAnalysisResult } from "@/lib/api";
import { api } from "@/lib/api";
import { consumeSelectionSse } from "@/lib/selectionSse";
import { SelectionToolbar, type SelectionAction } from "@/components/pdf/SelectionToolbar";
import { SelectionResultPanel } from "@/components/panel/SelectionResultPanel";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const StreamingMarkdownDynamic = dynamic(
  () =>
    import("@/components/analysis/StreamingMarkdown").then(
      (m) => m.StreamingMarkdown,
    ),
  { ssr: false, loading: () => <span className="opacity-60">…</span> },
);

const PdfViewer = dynamic(
  () => import("@/components/pdf/PdfViewer").then((m) => m.PdfViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
      </div>
    ),
  },
);

const MarkdownReader = dynamic(
  () => import("@/components/reader/MarkdownReader").then((m) => m.MarkdownReader),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-[var(--text-sm)] text-muted-foreground">
        Preparing readable view…
      </div>
    ),
  },
);

/**
 * Local alias kept named `Md` so the existing JSX in this trial page
 * (`<Md>{...}</Md>`) didn't have to be churned during the migration.
 * Renders via Streamdown so the trial summary gets the same KaTeX +
 * streaming-safe rendering as the authenticated path.
 */
function Md({ children }: { children: string }) {
  return <StreamingMarkdownDynamic>{children}</StreamingMarkdownDynamic>;
}

const TAB_STYLE =
  "shrink-0 flex-none h-8 rounded-md px-2.5 text-[var(--text-sm)] tracking-[-0.012em] font-medium text-muted-foreground hover:text-foreground data-active:text-foreground data-active:font-semibold";

const MIN_PANEL = 300;
const MAX_PANEL = 560;

function TrialSummary({ paperId }: { paperId: string }) {
  const [summary, setSummary] = useState<PaperSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/trial/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paper_id: paperId }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setSummary(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [paperId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
          <div className="h-full w-[60%] animate-pulse rounded-full bg-foreground/40" />
        </div>
        <p className="text-[13px] text-muted-foreground">Generating detailed summary…</p>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="py-8 text-center">
        <p className="text-[13px] text-muted-foreground">Summary not available.</p>
      </div>
    );
  }

  const sectionLabel =
    "mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground";

  return (
    <div className="space-y-5">
      {summary.overview && (
        <section>
          <h3 className={sectionLabel}>Overview</h3>
          <Md>{summary.overview}</Md>
        </section>
      )}
      {summary.motivation && (
        <section>
          <h3 className={sectionLabel}>Motivation</h3>
          <Md>{summary.motivation}</Md>
        </section>
      )}
      {summary.key_contributions && summary.key_contributions.length > 0 && (
        <section>
          <h3 className={sectionLabel}>Key Contributions</h3>
          <ul className="space-y-1.5">
            {summary.key_contributions.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-0.5 shrink-0 text-[12px] text-muted-foreground/70">{i + 1}.</span>
                <Md>{c}</Md>
              </li>
            ))}
          </ul>
        </section>
      )}
      {summary.methodology && (
        <section>
          <h3 className={sectionLabel}>Methodology</h3>
          <Md>{summary.methodology}</Md>
        </section>
      )}
      {summary.main_results && (
        <section>
          <h3 className={sectionLabel}>Main Results</h3>
          <Md>{summary.main_results}</Md>
        </section>
      )}
      {summary.limitations && summary.limitations.length > 0 && (
        <section>
          <h3 className={sectionLabel}>Limitations</h3>
          <ul className="space-y-1">
            {summary.limitations.map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 text-[12px] text-muted-foreground/70">•</span>
                <Md>{l}</Md>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function upsertHistoryEntry(
  setHistory: React.Dispatch<React.SetStateAction<SelectionAnalysisResult[]>>,
  clientKey: string,
  entry: SelectionAnalysisResult,
) {
  setHistory((prev) => {
    const i = prev.findIndex((x) => x.clientKey === clientKey);
    if (i === -1) return [...prev, entry];
    const next = [...prev];
    next[i] = entry;
    return next;
  });
}

export default function TrialPaperView() {
  const { id } = useParams<{ id: string }>();
  const idRef = useRef(id);
  idRef.current = id;

  const [title, setTitle] = useState("");
  const [ocrStatus, setOcrStatus] = useState("");
  const [trialMeta, setTrialMeta] = useState({ used: 0, limit: 2 });

  const [activeTab, setActiveTab] = useState("summary");
  const [panelW, setPanelW] = useState(430);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const [selection, setSelection] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [selectionResult, setSelectionResult] = useState<SelectionAnalysisResult | null>(null);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionHistory, setSelectionHistory] = useState<SelectionAnalysisResult[]>([]);
  const sseAbortRef = useRef<AbortController | null>(null);

  const refreshTrialMeta = useCallback(() => {
    fetch(`${API_BASE}/api/trial/paper/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.trial_selections_used === "number") {
          setTrialMeta({
            used: data.trial_selections_used,
            limit: data.trial_selections_limit ?? 2,
          });
        }
      })
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    fetch(`${API_BASE}/api/trial/paper/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.title) setTitle(data.title);
        if (data?.ocr_status) setOcrStatus(data.ocr_status);
        if (data && typeof data.trial_selections_used === "number") {
          setTrialMeta({
            used: data.trial_selections_used,
            limit: data.trial_selections_limit ?? 2,
          });
        }
      })
      .catch(() => {});
  }, [id]);

  const showSelectionTab =
    selectionLoading || selectionResult !== null || selectionHistory.length > 0;
  const effectiveTab = activeTab === "selection" && !showSelectionTab ? "summary" : activeTab;

  const handleTextSelected = useCallback((text: string, rect: DOMRect) => {
    setSelection({ text, rect });
  }, []);

  const handleSelectionClear = useCallback(() => {
    setSelection(null);
  }, []);

  const handleSelectionAction = useCallback(
    async (action: SelectionAction, text: string) => {
      if (action === "note") return;

      setSelection(null);
      window.getSelection()?.removeAllRanges();

      const startedId = idRef.current;
      const stillHere = () => idRef.current === startedId;

      sseAbortRef.current?.abort();
      const controller = new AbortController();
      sseAbortRef.current = controller;

      setActiveTab("selection");

      const clientKey =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `sel-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const provisional: SelectionAnalysisResult = {
        action,
        selected_text: text,
        explanation: "",
        streaming: true,
        clientKey,
      };

      upsertHistoryEntry(setSelectionHistory, clientKey, provisional);
      setSelectionResult(provisional);
      setSelectionLoading(false);

      try {
        const res = await api.trialAnalyzeSelectionStream(startedId, text, action, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          const detail = await res.text();
          let msg = `HTTP ${res.status}`;
          try {
            msg = JSON.parse(detail).detail || msg;
          } catch {
            /* ignore */
          }
          const errBody: SelectionAnalysisResult = {
            action,
            selected_text: text,
            explanation:
              res.status === 403 || res.status === 429
                ? `**Demo limit.** ${msg}\n\nCreate a free account for full access.`
                : msg,
            streaming: false,
            clientKey,
          };
          if (stillHere()) {
            upsertHistoryEntry(setSelectionHistory, clientKey, errBody);
            setSelectionResult(errBody);
          }
          void refreshTrialMeta();
          return;
        }
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No stream");

        let sawTerminalEvent = false;
        await consumeSelectionSse(reader, controller.signal, {
          onChunk: (accumulated) => {
            const chunkBody: SelectionAnalysisResult = {
              action,
              selected_text: text,
              explanation: accumulated,
              streaming: true,
              clientKey,
            };
            if (stillHere()) {
              upsertHistoryEntry(setSelectionHistory, clientKey, chunkBody);
              setSelectionResult(chunkBody);
            }
          },
          onDone: (finalText) => {
            sawTerminalEvent = true;
            const finalResult: SelectionAnalysisResult = {
              action,
              selected_text: text,
              explanation: finalText,
              streaming: false,
              clientKey,
            };
            if (stillHere()) {
              upsertHistoryEntry(setSelectionHistory, clientKey, finalResult);
              setSelectionResult(finalResult);
            }
            void refreshTrialMeta();
          },
          onError: (message) => {
            sawTerminalEvent = true;
            const errResult: SelectionAnalysisResult = {
              action,
              selected_text: text,
              explanation: `Error: ${message}`,
              streaming: false,
              clientKey,
            };
            if (stillHere()) {
              upsertHistoryEntry(setSelectionHistory, clientKey, errResult);
              setSelectionResult(errResult);
            }
            void refreshTrialMeta();
          },
        });

        if (!sawTerminalEvent && !controller.signal.aborted && stillHere()) {
          const errResult: SelectionAnalysisResult = {
            action,
            selected_text: text,
            explanation: "Analysis ended unexpectedly.",
            streaming: false,
            clientKey,
          };
          upsertHistoryEntry(setSelectionHistory, clientKey, errResult);
          setSelectionResult(errResult);
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        const errResult: SelectionAnalysisResult = {
          action,
          selected_text: text,
          explanation: `Analysis failed: ${e instanceof Error ? e.message : "Unknown error"}`,
          streaming: false,
          clientKey,
        };
        if (stillHere()) {
          upsertHistoryEntry(setSelectionHistory, clientKey, errResult);
          setSelectionResult(errResult);
        }
        void refreshTrialMeta();
      }
    },
    [refreshTrialMeta],
  );

  const onSepPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: panelW };
  }, [panelW]);

  const onSepPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const delta = dragRef.current.startX - e.clientX;
    const next = Math.min(MAX_PANEL, Math.max(MIN_PANEL, dragRef.current.startW + delta));
    setPanelW(next);
  }, []);

  const onSepPointerEnd = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  const selectionQuota = { used: trialMeta.used, limit: trialMeta.limit };

  const noopFollowUp = useCallback(async () => {}, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="shrink-0 bg-foreground px-4 py-2.5 text-center text-background">
        <p className="text-[12px] leading-snug opacity-90 sm:text-[13px]">
          Demo — structured summary plus{" "}
          <span className="font-medium">{trialMeta.limit} grounded selections</span> (Explain / Derive) on this paper.{" "}
          <Link href="/sign-up" className="font-medium underline underline-offset-2">
            Sign up free
          </Link>{" "}
          for prep, Q&amp;A, figures, and notes.
        </p>
      </div>

      <header className="glass-nav flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3 shadow-sm sm:px-4">
        <Link
          href="/try"
          className="ring-focus rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Back to demo upload"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
        </Link>
        <div className="h-3.5 w-px shrink-0 bg-border/70" />
        <Image src="/logo.png" alt="Know" width={18} height={18} className="shrink-0 rounded-md opacity-90" />
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight text-foreground">
          {title || "Paper"}
        </p>
        <div className="hidden tabular-nums sm:flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/10 px-2.5 py-0.5 text-[10.5px] font-medium text-muted-foreground/85">
          <span>Demo selections</span>
          <span className="text-muted-foreground/50">·</span>
          <span>
            {trialMeta.used}/{trialMeta.limit}
          </span>
        </div>
        <Link
          href="/#pricing"
          className="text-[12px] font-semibold text-foreground/90 border border-border/70 rounded-full px-3 py-1.5 hover:bg-accent transition-colors"
        >
          Plans
        </Link>
        <ThemeToggle />
        <Link
          href="/sign-up"
          className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-[12px] font-medium text-background transition-opacity hover:opacity-90"
        >
          Sign up
        </Link>
        {ocrStatus === "ready" && (
          <a
            href={`${API_BASE}/api/trial/paper/${id}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            View original PDF
          </a>
        )}
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/30">
          {ocrStatus === "ready" ? (
            <MarkdownReader
              paperId={id}
              trial
              onTextSelected={handleTextSelected}
              onSelectionClear={handleSelectionClear}
            />
          ) : (
            <PdfViewer
              url={`${API_BASE}/api/trial/paper/${id}/pdf`}
              paperId={id}
              onTextSelected={handleTextSelected}
              onSelectionClear={handleSelectionClear}
            />
          )}
          {selection && (
            <SelectionToolbar
              text={selection.text}
              rect={selection.rect}
              onAction={handleSelectionAction}
              onDismiss={handleSelectionClear}
              selectionQuota={selectionQuota}
            />
          )}
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          className="hidden w-2 shrink-0 cursor-col-resize touch-none select-none items-center justify-center border-l border-border bg-muted/20 hover:bg-accent/40 sm:flex"
          onPointerDown={onSepPointerDown}
          onPointerMove={onSepPointerMove}
          onPointerUp={onSepPointerEnd}
          onPointerCancel={onSepPointerEnd}
        >
          <div className="h-10 w-0.5 rounded-full bg-foreground/10" />
        </div>

        <div
          className="flex shrink-0 flex-col overflow-hidden border-l border-border bg-background"
          style={{ width: panelW, maxWidth: "100vw" }}
        >
          <Tabs value={effectiveTab} onValueChange={setActiveTab} className="flex h-full min-h-0 flex-col">
            <div className="flex h-10 min-w-0 shrink-0 items-center gap-1 border-b border-border/40 bg-muted/[0.11] px-2 dark:bg-muted/[0.08]">
              <div className="min-h-0 min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-gutter:stable]">
                <TabsList variant="line" className="inline-flex h-9 w-max flex-nowrap justify-start gap-0.5 p-0">
                  {showSelectionTab && (
                    <TabsTrigger value="selection" className={TAB_STYLE} title={FEATURE_TOOLTIPS.Selection}>
                      Selection
                      {selectionLoading && (
                        <span className="ml-1 h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                      )}
                    </TabsTrigger>
                  )}
                  <TabsTrigger value="summary" className={TAB_STYLE} title={FEATURE_TOOLTIPS.Summary}>
                    Summary
                  </TabsTrigger>
                  {(
                    [
                      { value: "preread", label: "Prepare" },
                      { value: "assume", label: "Assumptions" },
                      { value: "qa", label: "Q&A" },
                      { value: "figures", label: "Figures" },
                      { value: "notes", label: "Notes" },
                    ] as const
                  ).map((tab) => (
                    <TabsTrigger
                      key={tab.value}
                      value={tab.value}
                      className={`${TAB_STYLE} cursor-not-allowed opacity-70`}
                      title={`${FEATURE_TOOLTIPS[tab.label]} — sign up to unlock`}
                      disabled
                    >
                      <svg
                        className="mr-0.5 h-2.5 w-2.5 shrink-0 opacity-45"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        aria-hidden
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
                        />
                      </svg>
                      <span className="opacity-80">{tab.label}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
            </div>

            <TabsContent value="summary" className="mt-0 min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
              <div className="p-4 pb-10">
                <TrialSummary paperId={id} />
              </div>
            </TabsContent>

            <TabsContent value="selection" className="mt-0 min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
              <div className="p-4 pb-10">
                <SelectionResultPanel
                  result={selectionResult}
                  loading={selectionLoading}
                  history={selectionHistory}
                  onFollowUp={noopFollowUp}
                  allowFollowUp={false}
                  onFocusHistoryRoot={(r) => {
                    setSelectionResult(r);
                    setActiveTab("selection");
                  }}
                />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
