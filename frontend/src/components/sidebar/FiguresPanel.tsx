"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { api, type FigureInfo, type FigureAnalysis, type ParsedPaper } from "@/lib/api";
import {
  analysisFiguresFromPaper,
  figurePreviewUrl,
  ocrFiguresPending,
} from "@/lib/ocrFigures";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "@/lib/store";
// Stage 3: figure analysis streams from the migrated AI SDK route and
// renders via Streamdown.
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import { CardMeta } from "@/components/analysis/CardMeta";
import { ModelPill } from "@/components/analysis/ModelPill";
import { ModelOverridePill } from "@/components/analysis/ModelOverridePill";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { useUserSettings } from "@/lib/UserSettingsContext";

interface FiguresPanelProps {
  paperId: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  model?: string;
}

function chatsFromFigureAnalyses(analyses: FigureAnalysis[] | undefined): Record<string, ChatMessage[]> {
  if (!analyses?.length) return {};
  const out: Record<string, ChatMessage[]> = {};
  for (const a of analyses) {
    const fid = a.figure_id;
    if (!out[fid]) out[fid] = [];
    const q = (a.question || "").trim();
    out[fid].push({ role: "user", text: q || "Analyze this figure" });
    const body = ((a.description || a.answer) || "").trim();
    out[fid].push({ role: "assistant", text: body, model: a.model });
  }
  return out;
}

function appendFigureAnalysisToCaches(paperId: string, entry: FigureAnalysis) {
  const s = useStore.getState();
  const bump = (p: ParsedPaper | null): ParsedPaper | null => {
    if (!p || p.id !== paperId) return p;
    const prev = p.cached_analysis?.figure_analyses ?? [];
    return {
      ...p,
      cached_analysis: {
        ...p.cached_analysis,
        figure_analyses: [...prev, entry],
      },
    };
  };
  const cached = s.papersById[paperId];
  if (cached) {
    const n = bump(cached);
    if (n) s.cachePaper(n);
  }
  if (s.paper?.id === paperId) {
    const n = bump(s.paper);
    if (n) s.setPaper(n);
  }
}

const FIG_BLOB_CACHE_SIZE = 64;
const figureBlobCache = new Map<string, string>();

function rememberFigureBlob(src: string, blobUrl: string) {
  if (figureBlobCache.has(src)) return;
  figureBlobCache.set(src, blobUrl);
  if (figureBlobCache.size > FIG_BLOB_CACHE_SIZE) {
    const firstKey = figureBlobCache.keys().next().value;
    if (firstKey) {
      const stale = figureBlobCache.get(firstKey);
      if (stale && stale !== blobUrl) URL.revokeObjectURL(stale);
      figureBlobCache.delete(firstKey);
    }
  }
}

async function fetchFigureBlobWithRetry(src: string, headers: Record<string, string>) {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(src, { headers, cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return await res.blob();
    } catch (e) {
      if (i === 1) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("unreachable");
}

function AuthImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const cached = figureBlobCache.get(src);
  const [blobUrl, setBlobUrl] = useState<string>(cached ?? "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const hit = figureBlobCache.get(src);
    if (hit) {
      setBlobUrl(hit);
      setFailed(false);
      return;
    }

    let cancelled = false;
    import("@/lib/api").then(({ getAuthHeadersSync }) => {
      const headers = getAuthHeadersSync();
      fetchFigureBlobWithRetry(src, headers)
        .then((blob) => {
          if (cancelled) return;
          const objUrl = URL.createObjectURL(blob);
          rememberFigureBlob(src, objUrl);
          setBlobUrl(objUrl);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    });
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    return () => {
      if (blobUrl && !Array.from(figureBlobCache.values()).includes(blobUrl)) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  if (failed) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-1 bg-muted/[0.10] text-muted-foreground/70 ${className || ""}`}
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5h18v15H3zM7 10l3 3 5-6 4 6" />
        </svg>
        <span className="text-[var(--text-xs)] font-medium">Preview unavailable</span>
      </div>
    );
  }
  if (!blobUrl) {
    return (
      <div className={`flex h-full w-full items-center justify-center bg-muted/[0.12] ${className || ""}`}>
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground/70" />
      </div>
    );
  }
  // Authenticated figure blobs are fetched with bearer headers above and
  // materialized as object URLs, so Next/Image cannot optimize them.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={blobUrl} alt={alt} className={className} />;
}

function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-foreground/85 backdrop-blur-sm flex items-center justify-center p-8 animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Expanded view of ${alt}`}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors z-10"
        aria-label="Close lightbox"
      >
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <div onClick={(e) => e.stopPropagation()}>
        <AuthImage
          src={src}
          alt={alt}
          className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl"
        />
      </div>
    </div>
  );
}

export function FiguresPanel({ paperId }: FiguresPanelProps) {
  const { fastModel, allowedModels } = useUserSettings();
  const { paper, setPaper } = useStore();
  // Keep the in-memory "instant switch" cache (`papersById`) in sync
  // whenever we mutate figures on the current paper. Without this,
  // switching to another paper and back would briefly show stale
  // (pre-reextract) figures from cache before the background
  // `getPaper` call refreshes them.
  const cachePaper = useStore((s) => s.cachePaper);
  // `paper` is driven by a global store: it may be stale (another paper)
  // or `null` on a fresh mount before the API call resolves. Only trust
  // it when it actually matches the panel's paperId. Tracking the
  // matched/unmatched states separately lets us show a spinner during
  // hydration instead of immediately flashing "No figures detected."
  //
  // If the store is momentarily stale (very common during a paper
  // switch), fall back to the in-memory `papersById` cache so the
  // panel does not wipe its figures grid while waiting for the next
  // setPaper() tick. The grid can always refine once `paper` updates.
  const cachedForPanel = useStore(
    useCallback((s) => s.papersById[paperId], [paperId]),
  );
  const paperMatches = paper?.id === paperId;
  const effectivePaper = paperMatches ? paper : cachedForPanel;
  const ocrStatus = effectivePaper?.ocr_status;
  const ocrImagesSig = useMemo(() => {
    if (effectivePaper?.id !== paperId || effectivePaper.ocr_status !== "ready") return "";
    const images = effectivePaper.ocr_images;
    if (!images?.length) return "0";
    return images.map((img) => img.id).join("\x1f");
  }, [paperId, effectivePaper?.id, effectivePaper?.ocr_status, effectivePaper?.ocr_images]);
  const figures = useMemo(
    () => analysisFiguresFromPaper(effectivePaper),
    [effectivePaper, ocrImagesSig],
  );
  const paperReady = Boolean(effectivePaper?.id);
  const ocrPending = ocrFiguresPending(effectivePaper);
  const figureSrc = useCallback(
    (figId: string) => figurePreviewUrl(paperId, figId, ocrStatus),
    [paperId, ocrStatus],
  );
  const [selected, setSelected] = useState<FigureInfo | null>(null);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamModel, setStreamModel] = useState<string | null>(null);
  const [figureModelOverride, setFigureModelOverride] = useState<string | null>(null);
  // "Re-extracting" spinner state lives in the store so a paper
  // switch doesn't hide the running indicator. If the user triggers
  // re-extraction, switches papers, then comes back, the spinner
  // reappears immediately and the result lands whenever the request
  // completes — even if that happens while they're on a different
  // paper (see `handleReextract` below).
  const reextracting = useStore((s) =>
    Boolean(s.figureReextractInFlight[paperId]),
  );
  const setFigureReextractInFlight = useStore((s) => s.setFigureReextractInFlight);
  const [lightboxFig, setLightboxFig] = useState<FigureInfo | null>(null);

  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>({});
  const chatEndRef = useRef<HTMLDivElement>(null);
  const prevPaperIdRef = useRef(paperId);
  const abortRef = useRef<AbortController | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);

  useEffect(() => {
    setOcrError(null);
  }, [paperId]);

  useEffect(() => {
    if (prevPaperIdRef.current !== paperId) {
      abortRef.current?.abort();
      setSelected(null);
      setStreamModel(null);
      setFigureModelOverride(null);
      prevPaperIdRef.current = paperId;
    }
  }, [paperId]);

  const figureAnalysesSig = useMemo(() => {
    const list =
      effectivePaper?.id === paperId ? effectivePaper.cached_analysis?.figure_analyses : undefined;
    if (!list?.length) return "0";
    const tail = list[list.length - 1];
    return `${list.length}:${tail.figure_id}:${(tail.question || "").length}:${(tail.description || tail.answer || "").length}`;
  }, [paperId, effectivePaper?.id, effectivePaper?.cached_analysis?.figure_analyses]);

  useEffect(() => {
    if (!paperId || effectivePaper?.id !== paperId) return;
    const list = effectivePaper.cached_analysis?.figure_analyses;
    const next = chatsFromFigureAnalyses(list);
    setConversations((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (
        prevKeys.length === nextKeys.length &&
        prevKeys.every((k) => {
          const a = prev[k];
          const b = next[k];
          return (
            a?.length === b?.length &&
            a.every((msg, i) => msg.role === b[i]?.role && msg.text === b[i]?.text)
          );
        })
      ) {
        return prev;
      }
      return next;
    });
  }, [paperId, effectivePaper?.id, figureAnalysesSig]); // eslint-disable-line react-hooks/exhaustive-deps -- synced via compact figureAnalysesSig

  // Abort any in-flight figure stream when the panel unmounts so we don't
  // keep a dangling LLM request alive after navigation.
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversations, selected, loading]);

  const handleRerunOcr = useCallback(async () => {
    setOcrError(null);
    setFigureReextractInFlight(paperId, true);
    try {
      const res = await api.runPaperOcr(paperId);
      if (res.ocr_status !== "ready") {
        setOcrError("OCR did not complete. Check that Mistral OCR is configured on the server.");
        return;
      }
      const refreshed = await api.getPaper(paperId);
      cachePaper(refreshed);
      if (useStore.getState().paper?.id === paperId) {
        setPaper(refreshed);
      }
      setSelected(null);
      setConversations(chatsFromFigureAnalyses(refreshed.cached_analysis?.figure_analyses));
    } catch (e) {
      console.error("OCR rerun failed:", e);
      setOcrError(e instanceof Error ? e.message : "OCR failed");
    } finally {
      setFigureReextractInFlight(paperId, false);
    }
  }, [paperId, setPaper, cachePaper, setFigureReextractInFlight]);

  const handleAnalyze = useCallback(
    async (fig: FigureInfo, q: string = "", model?: string) => {
      const figId = fig.id;
      const userMsg: ChatMessage = { role: "user", text: q || "Analyze this figure" };
      const resolvedModel = model ?? figureModelOverride ?? fastModel;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStreamModel(resolvedModel);
      setConversations((prev) => ({
        ...prev,
        [figId]: [...(prev[figId] || []), userMsg],
      }));
      setLoading(true);

      try {
        setConversations((prev) => ({
          ...prev,
          [figId]: [
            ...(prev[figId] || []),
            { role: "assistant", text: "", streaming: true, model: resolvedModel },
          ],
        }));

        const result = await api.analyzeFigure(paperId, figId, q);
        if (controller.signal.aborted) return;

        const finalText = (
          q ? (result.answer ?? result.description) : (result.description ?? result.answer)
        )?.trim();
        if (!finalText) {
          throw new Error(
            "The model didn't return a complete figure analysis. Please try again.",
          );
        }

        const cacheEntry: FigureAnalysis = {
          figure_id: figId,
          question: q,
          description: result.description ?? finalText,
          key_observations: result.key_observations ?? [],
          relation_to_paper: result.relation_to_paper ?? "",
          methodology_shown: result.methodology_shown,
          takeaway: result.takeaway,
          answer: result.answer,
          model: result.model ?? resolvedModel,
          created_at: Date.now(),
        };
        appendFigureAnalysisToCaches(paperId, cacheEntry);
        setFigureModelOverride(null);
        setStreamModel(cacheEntry.model ?? resolvedModel);
        setConversations((prev) => {
          const msgs = [...(prev[figId] || [])];
          const lastIdx = msgs.length - 1;
          if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
            msgs[lastIdx] = {
              role: "assistant",
              text: finalText,
              streaming: false,
              model: cacheEntry.model ?? resolvedModel,
            };
          }
          return { ...prev, [figId]: msgs };
        });
      } catch (e) {
        if (controller.signal.aborted) return;
        setConversations((prev) => {
          const msgs = [...(prev[figId] || [])];
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant" && last.streaming) {
            msgs[msgs.length - 1] = {
              role: "assistant",
              text: `Analysis failed: ${e instanceof Error ? e.message : "Unknown error"}`,
              streaming: false,
            };
          } else {
            msgs.push({
              role: "assistant",
              text: `Analysis failed: ${e instanceof Error ? e.message : "Unknown error"}`,
            });
          }
          return { ...prev, [figId]: msgs };
        });
      } finally {
        setLoading(false);
      }
    },
    [paperId, fastModel, figureModelOverride]
  );

  const handleAsk = useCallback(() => {
    if (!selected || !question.trim()) return;
    const model = figureModelOverride ?? fastModel;
    handleAnalyze(selected, question.trim(), model);
    setQuestion("");
  }, [selected, question, handleAnalyze, figureModelOverride, fastModel]);

  // Paper metadata hasn't arrived yet — show a spinner instead of a
  // misleading "no figures" message. This covers both the initial mount
  // (paper=null while /api/papers/:id is in flight) and the brief window
  // during a paper switch where `paper` still points at the previous one.
  if (!paperReady) {
    return (
      <div className="flex min-h-[30vh] flex-col items-center justify-center gap-3 py-10">
        <div className="w-full max-w-xs">
          <AnalysisProgress kind="search" />
        </div>
        <p className="text-[var(--text-sm)] text-muted-foreground/80">Loading figures…</p>
      </div>
    );
  }

  if (ocrPending || reextracting) {
    return (
      <div className="flex min-h-[30vh] flex-col items-center justify-center gap-3 py-10">
        <div className="w-full max-w-xs">
          <AnalysisProgress kind="search" />
        </div>
        <p className="text-[var(--text-sm)] text-muted-foreground/80">
          {reextracting ? "Running Mistral OCR…" : "Preparing figures from OCR…"}
        </p>
      </div>
    );
  }

  if (figures.length === 0) {
    const unsupported = ocrStatus === "unsupported";
    const failed = ocrStatus === "failed";
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-5 rounded-2xl border border-border/45 bg-gradient-to-b from-card/35 to-card/[0.08] px-6 py-9 text-center shadow-[var(--shadow-sm)] backdrop-blur-[2px] motion-safe:animate-fade-in dark:from-card/20 dark:to-transparent">
        <div className="space-y-2.5">
          <p className="text-[var(--text-md)] font-semibold tracking-tight text-foreground/95">
            {unsupported ? "OCR unavailable" : failed ? "OCR failed" : "No figures in OCR output"}
          </p>
          <p className="mx-auto max-w-sm text-[var(--text-xs)] leading-snug text-muted-foreground/88">
            {unsupported
              ? "This deployment does not have Mistral OCR configured. Figures and analysis use OCR markdown when available."
              : failed
                ? "Mistral OCR did not complete for this paper. Retry after checking the API key on the server."
                : "Mistral OCR finished but did not extract any figure images from this PDF."}
          </p>
        </div>
        {!unsupported && (
          <button
            type="button"
            onClick={handleRerunOcr}
            disabled={reextracting}
            className="btn-primary-glass inline-flex min-h-10 items-center justify-center rounded-xl px-4 py-2 text-[var(--text-sm)] font-semibold text-background disabled:opacity-40"
          >
            {reextracting ? "Running OCR…" : "Re-run Mistral OCR"}
          </button>
        )}
        {ocrError && (
          <p className="text-left text-[var(--text-xs)] text-destructive/90" role="alert">
            {ocrError}
          </p>
        )}
      </div>
    );
  }

  const chat = selected ? conversations[selected.id] || [] : [];

  if (selected) {
    return (
      <div className="flex flex-col h-full">
        {lightboxFig && (
          <Lightbox
            src={figureSrc(lightboxFig.id)}
            alt={lightboxFig.caption || lightboxFig.id}
            onClose={() => setLightboxFig(null)}
          />
        )}

        <div className="flex items-center gap-2 pb-3 border-b border-border/50 shrink-0">
          <button
            onClick={() => {
              setSelected(null);
              setStreamModel(null);
              setFigureModelOverride(null);
            }}
            className="text-[var(--text-sm)] text-muted-foreground hover:text-foreground transition-colors font-medium"
          >
            &larr; All Figures
          </button>
          <span className="text-[var(--text-xs)] text-muted-foreground/40">Page {selected.page + 1}</span>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 py-3 space-y-3">
          <div className="relative group">
            <button
              type="button"
              onClick={() => setLightboxFig(selected)}
              className="block w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/60 bg-card/20 transition-colors hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              title="Click to expand"
              aria-label="Expand figure"
            >
              <AuthImage
                src={figureSrc(selected.id)}
                alt={selected.caption || selected.id}
                className="w-full object-contain max-h-[250px]"
              />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxFig(selected);
              }}
              className="absolute top-2 right-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-border/60 bg-card/85 px-2.5 text-[var(--text-xs)] font-medium text-foreground/90 shadow-[var(--shadow-xs)] backdrop-blur-sm transition-colors hover:bg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              aria-label="Expand figure"
              title="Expand figure"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M15 3h6v6" />
                <path d="M9 21H3v-6" />
                <path d="M21 3l-7 7" />
                <path d="M3 21l7-7" />
              </svg>
              Expand
            </button>
          </div>

          {selected.caption && (
            <p className="text-[var(--text-xs)] text-muted-foreground/75 italic leading-relaxed whitespace-pre-line">
              {selected.caption}
            </p>
          )}

          <CardMeta
            model={
              streamModel ??
              effectivePaper?.cached_analysis?.figure_analyses?.find(
                (a) => a.figure_id === selected.id,
              )?.model ??
              fastModel
            }
            pending={loading}
            createdAt={
              effectivePaper?.cached_analysis?.figure_analyses?.find(
                (a) => a.figure_id === selected.id,
              )?.created_at
            }
            extra={
              <span className="text-muted-foreground/75">
                {selected.caption ? `Fig. · page ${selected.page + 1}` : `Page ${selected.page + 1}`}
              </span>
            }
          />

          {chat.length === 0 && !loading && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[var(--text-xs)] text-muted-foreground/85">
                <span>Model</span>
                <ModelOverridePill
                  model={figureModelOverride ?? fastModel}
                  allowed={allowedModels}
                  onChange={setFigureModelOverride}
                />
              </div>
              <button
                onClick={() =>
                  handleAnalyze(selected, "", figureModelOverride ?? fastModel)
                }
                className="btn-primary-glass w-full rounded-lg px-4 py-2 text-[var(--text-sm)] font-medium text-background transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Analyze This Figure
              </button>
            </div>
          )}

          {/* Conversation thread */}
          {chat.length > 0 && (
            <div className="space-y-3">
              {chat.map((msg, i) =>
                msg.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="bg-foreground text-background rounded-xl rounded-br-sm px-3 py-2 max-w-[85%]">
                      <p className="text-[var(--text-sm)] leading-relaxed">{msg.text}</p>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex justify-start w-full">
                    <div className="w-full max-w-[95%] rounded-lg border border-border/60 bg-card/30 px-3 py-2.5 space-y-2">
                      {msg.streaming && !msg.text && (
                        <div className="space-y-2">
                          <div className="w-full max-w-xs">
                            <AnalysisProgress kind="search" />
                          </div>
                          <p className="text-[var(--text-xs)] text-muted-foreground motion-safe:animate-pulse">Analyzing figure…</p>
                        </div>
                      )}
                      {msg.text && (
                        <StreamingMarkdown streaming={msg.streaming}>
                          {msg.text}
                        </StreamingMarkdown>
                      )}
                      {msg.model && (
                        <div className="flex justify-end">
                          <ModelPill slug={msg.model} pending={msg.streaming} />
                        </div>
                      )}
                    </div>
                  </div>
                )
              )}
            </div>
          )}

          {/* Loading indicator for initial send before stream starts */}
          {loading && chat.length > 0 && chat[chat.length - 1].role === "user" && (
            <div className="flex w-full justify-start">
              <div className="w-full max-w-sm space-y-2 rounded-lg border border-border/60 bg-card/30 px-3 py-2.5">
                <AnalysisProgress kind="search" />
                <p className="text-[var(--text-xs)] text-muted-foreground motion-safe:animate-pulse">Sending to AI…</p>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        <div className="shrink-0 pt-2 border-t border-border/50">
          <div className="flex gap-2">
            {allowedModels.length > 0 && (
              <ModelOverridePill
                model={figureModelOverride ?? fastModel}
                allowed={allowedModels}
                onChange={setFigureModelOverride}
              />
            )}
            <input
              type="search"
              name="know_figure_followup"
              autoComplete="off"
              autoCorrect="on"
              spellCheck
              enterKeyHint="send"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAsk(); }
              }}
              placeholder="Ask about this figure..."
              disabled={loading}
              className="know-non-credential-input flex-1 text-[var(--text-sm)] min-h-[2.25rem] rounded-[var(--radius-md)] px-3 py-2 border border-input bg-muted/30 placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 shadow-none disabled:opacity-50 dark:bg-muted/20"
            />
            <button
              onClick={handleAsk}
              disabled={!question.trim() || loading}
              className="btn-primary-glass h-9 shrink-0 rounded-lg px-3 text-[var(--text-xs)] font-medium text-background transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
            >
              Ask
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {ocrError && (
        <p className="text-[var(--text-xs)] text-destructive/90" role="alert">
          {ocrError}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2.5 md:gap-3">
        {figures.map((fig) => {
          const convoCount = conversations[fig.id]?.length ?? 0;
          const captionShort = fig.caption
            ? fig.caption.slice(0, 48) + (fig.caption.length > 48 ? "…" : "")
            : `Page ${fig.page + 1}`;
          return (
            <button
              key={fig.id}
              onClick={() => setSelected(fig)}
              className="group relative overflow-hidden rounded-xl border border-border/50 bg-card/15 text-left ring-focus transition-[border-color,transform] motion-safe:duration-150 hover:-translate-y-px hover:border-border-strong hover:shadow-[var(--shadow-sm)]"
            >
              <div className="relative aspect-[4/3] overflow-hidden bg-muted/25">
                <AuthImage
                  src={figureSrc(fig.id)}
                  alt={fig.caption || fig.id}
                  className="h-full w-full object-cover"
                />
                {convoCount > 0 && (
                  <div className="absolute top-1.5 right-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-foreground px-1 text-[9px] font-semibold leading-none text-background shadow-sm">
                    {Math.floor(convoCount / 2)}
                  </div>
                )}
              </div>
              <div className="px-2.5 py-2">
                <p className="truncate text-[var(--text-xs)] font-medium text-foreground/90">{captionShort}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
