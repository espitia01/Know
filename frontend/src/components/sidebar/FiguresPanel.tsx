"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { api, type FigureInfo, type FigureAnalysis, type ParsedPaper } from "@/lib/api";
import { beginFigureScreenshotFlow, captureScreenTabToPng, readClipboardImageBlob } from "@/lib/pdfSelectionCapture";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";

interface FiguresPanelProps {
  paperId: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
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
    out[fid].push({ role: "assistant", text: body });
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

function AuthImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [blobUrl, setBlobUrl] = useState<string>("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import("@/lib/api").then(({ getAuthHeadersSync }) => {
      const headers = getAuthHeadersSync();
      fetch(src, { headers })
        .then((res) => {
          if (!res.ok) throw new Error("fetch failed");
          return res.blob();
        })
        .then((blob) => {
          if (!cancelled) setBlobUrl(URL.createObjectURL(blob));
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    });
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [blobUrl]);

  if (failed) {
    return (
      <div className={`flex items-center justify-center text-muted-foreground/30 text-[var(--text-xs)] ${className || ""}`}>
        No preview
      </div>
    );
  }
  if (!blobUrl) {
    return (
      <div className={`flex items-center justify-center ${className || ""}`}>
        <div className="w-4 h-4 border-2 border-muted-foreground/20 border-t-muted-foreground/60 rounded-full animate-spin" />
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
  const figures = effectivePaper?.figures ?? [];
  const paperReady = Array.isArray(effectivePaper?.figures);
  const [selected, setSelected] = useState<FigureInfo | null>(null);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
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
  const [clipSaving, setClipSaving] = useState(false);
  const [clipError, setClipError] = useState<string | null>(null);

  useEffect(() => {
    setClipError(null);
  }, [paperId]);

  useEffect(() => {
    if (prevPaperIdRef.current !== paperId) {
      abortRef.current?.abort();
      setSelected(null);
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
    setConversations(chatsFromFigureAnalyses(list));
  }, [paperId, effectivePaper?.id, figureAnalysesSig]); // eslint-disable-line react-hooks/exhaustive-deps -- synced via compact figureAnalysesSig

  // Abort any in-flight figure stream when the panel unmounts so we don't
  // keep a dangling LLM request alive after navigation.
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversations, selected, loading]);

  const handleReextract = useCallback(async () => {
    // Capture the paper snapshot for *this* paperId at call time. We
    // pull from the in-memory cache rather than the global `paper`
    // slice so the re-extract works even if the user has already
    // switched to a different paper before this callback runs.
    const snapshot = useStore.getState().papersById[paperId] ?? paper;
    if (!snapshot) return;
    setFigureReextractInFlight(paperId, true);
    try {
      const result = await api.reextractFigures(paperId);
      const next = { ...snapshot, figures: result.figures };
      // Always refresh the cache — the user returning to this paper
      // must see the freshly-extracted figures, whether or not they
      // were watching when the request resolved.
      cachePaper(next);
      // Only mutate the global `paper` when this paper is still the
      // active one; otherwise we'd overwrite the paper the user is
      // currently reading with a different paper's data. This is the
      // "figures extraction stopped" bug reported after a mid-job
      // paper switch — the job wasn't stopping, it was quietly
      // clobbering the in-view paper on completion.
      if (useStore.getState().paper?.id === paperId) {
        setPaper(next);
      }
      setSelected(null);
      setConversations(chatsFromFigureAnalyses(next.cached_analysis?.figure_analyses));
    } catch (e) {
      console.error("Re-extraction failed:", e);
    } finally {
      setFigureReextractInFlight(paperId, false);
    }
  }, [paperId, paper, setPaper, cachePaper, setFigureReextractInFlight]);

  const handleAnalyze = useCallback(
    async (fig: FigureInfo, q: string = "") => {
      const figId = fig.id;
      const userMsg: ChatMessage = { role: "user", text: q || "Analyze this figure" };

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setConversations((prev) => ({
        ...prev,
        [figId]: [...(prev[figId] || []), userMsg],
      }));
      setLoading(true);

      try {
        const res = await api.analyzeFigureStream(paperId, figId, q, controller.signal);
        if (controller.signal.aborted) return;
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No stream");

        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";
        let chunkRaf: number | null = null;

        const flushFigureChunk = () => {
          chunkRaf = null;
          const current = accumulated;
          setConversations((prev) => {
            const msgs = [...(prev[figId] || [])];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
              msgs[lastIdx] = { ...msgs[lastIdx], text: current };
            }
            return { ...prev, [figId]: msgs };
          });
        };

        const scheduleFigureChunk = () => {
          if (typeof window === "undefined") {
            flushFigureChunk();
            return;
          }
          if (chunkRaf == null) {
            chunkRaf = window.requestAnimationFrame(flushFigureChunk);
          }
        };

        // Add a streaming assistant message
        setConversations((prev) => ({
          ...prev,
          [figId]: [...(prev[figId] || []), { role: "assistant", text: "", streaming: true }],
        }));

        while (true) {
          if (controller.signal.aborted) { reader.cancel(); break; }
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "chunk") {
                accumulated += event.text;
                scheduleFigureChunk();
              } else if (event.type === "done") {
                if (chunkRaf != null && typeof window !== "undefined") {
                  window.cancelAnimationFrame(chunkRaf);
                  chunkRaf = null;
                }
                const final = event.full_text || accumulated;
                appendFigureAnalysisToCaches(paperId, {
                  figure_id: figId,
                  question: q,
                  description: final,
                  key_observations: [],
                  relation_to_paper: "",
                });
                setConversations((prev) => {
                  const msgs = [...(prev[figId] || [])];
                  const lastIdx = msgs.length - 1;
                  if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
                    msgs[lastIdx] = { role: "assistant", text: final, streaming: false };
                  }
                  return { ...prev, [figId]: msgs };
                });
              } else if (event.type === "error") {
                if (chunkRaf != null && typeof window !== "undefined") {
                  window.cancelAnimationFrame(chunkRaf);
                  chunkRaf = null;
                }
                setConversations((prev) => {
                  const msgs = [...(prev[figId] || [])];
                  const lastIdx = msgs.length - 1;
                  if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
                    msgs[lastIdx] = { role: "assistant", text: `Error: ${event.message}`, streaming: false };
                  }
                  return { ...prev, [figId]: msgs };
                });
              }
            } catch {
              // ignore malformed events
            }
          }
        }

        /* Stream ended without a terminal SSE event — flush partial text once. */
        if (chunkRaf != null && typeof window !== "undefined") {
          window.cancelAnimationFrame(chunkRaf);
          chunkRaf = null;
        }
        if (accumulated.length > 0) {
          flushFigureChunk();
        }
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
    [paperId]
  );

  const ingestFigureBlob = useCallback(
    async (blob: Blob | null, cancelHint: string) => {
      setClipError(null);
      if (!blob) {
        setClipError(cancelHint);
        return;
      }
      try {
        setClipSaving(true);
        const { figure, figures } = await api.uploadFigureFromSelection(paperId, blob);
        const snap =
          useStore.getState().papersById[paperId] ??
          (useStore.getState().paper?.id === paperId ? useStore.getState().paper : null);
        if (!snap || snap.id !== paperId) {
          setClipError("Could not sync paper cache. Reload the library and try again.");
          return;
        }
        const next = { ...snap, figures };
        cachePaper(next);
        if (useStore.getState().paper?.id === paperId) {
          setPaper(next);
        }
        setSelected(figure);
        void handleAnalyze(figure, "");
      } catch (e) {
        setClipError(e instanceof Error ? e.message : "Could not save figure image.");
      } finally {
        setClipSaving(false);
      }
    },
    [paperId, cachePaper, setPaper, handleAnalyze],
  );

  const handleCaptureFromPdf = useCallback(async () => {
    await ingestFigureBlob(
      await beginFigureScreenshotFlow(),
      "Drag on the PDF to box the figure, then release—or press Esc to cancel.",
    );
  }, [ingestFigureBlob]);

  const handleScreenCapture = useCallback(async () => {
    await ingestFigureBlob(
      await captureScreenTabToPng(),
      "Screen capture was cancelled or not supported. Allow sharing when the browser asks, then try again.",
    );
  }, [ingestFigureBlob]);

  const handlePasteFromClipboard = useCallback(async () => {
    await ingestFigureBlob(
      await readClipboardImageBlob(),
      "No image on the clipboard. Take a system screenshot (e.g. ⌘⇧4 on Mac, Win+Shift+S on Windows), copy the image, then tap Paste again.",
    );
  }, [ingestFigureBlob]);

  const handleAsk = useCallback(() => {
    if (!selected || !question.trim()) return;
    handleAnalyze(selected, question.trim());
    setQuestion("");
  }, [selected, question, handleAnalyze]);

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

  if (figures.length === 0) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-5 rounded-xl border border-border/50 bg-card/25 px-6 py-10 text-center shadow-[var(--shadow-xs)] motion-safe:animate-fade-in">
        <div className="space-y-2">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-border/50 bg-muted/30 text-muted-foreground/55">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.25}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
          </div>
          <p className="text-[var(--text-md)] font-medium text-foreground/90">No figures yet</p>
          <p className="mx-auto max-w-md text-[var(--text-xs)] leading-relaxed text-muted-foreground/85">
            Crop inside the PDF, capture this tab/window when the browser asks, or paste a screenshot you took with the OS shortcut—then we analyze it.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
          <button
            type="button"
            onClick={handleCaptureFromPdf}
            disabled={clipSaving || reextracting}
            className="btn-primary-glass rounded-lg px-4 py-2.5 text-[var(--text-sm)] font-medium text-background transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            {clipSaving ? "Working…" : "Crop on PDF"}
          </button>
          <button
            type="button"
            onClick={handleScreenCapture}
            disabled={clipSaving || reextracting}
            className="rounded-lg border border-border/60 bg-background/60 px-4 py-2.5 text-[var(--text-sm)] font-medium text-foreground/90 backdrop-blur-sm transition-colors hover:bg-accent/45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            Screen capture
          </button>
          <button
            type="button"
            onClick={handlePasteFromClipboard}
            disabled={clipSaving || reextracting}
            className="rounded-lg border border-border/60 bg-background/60 px-4 py-2.5 text-[var(--text-sm)] font-medium text-foreground/90 backdrop-blur-sm transition-colors hover:bg-accent/45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            Paste screenshot
          </button>
        </div>
        <button
          type="button"
          onClick={handleReextract}
          disabled={reextracting || clipSaving}
          className="text-[var(--text-xs)] font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-40"
        >
          {reextracting ? "Re-extracting from PDF…" : "Re-run PDF figure extraction"}
        </button>
        {clipError && (
          <p className="text-left text-[var(--text-xs)] text-destructive/90" role="alert">
            {clipError}
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
            src={api.getFigureUrl(paperId, lightboxFig.id)}
            alt={lightboxFig.caption || lightboxFig.id}
            onClose={() => setLightboxFig(null)}
          />
        )}

        <div className="flex items-center gap-2 pb-3 border-b border-border/50 shrink-0">
          <button
            onClick={() => setSelected(null)}
            className="text-[var(--text-sm)] text-muted-foreground hover:text-foreground transition-colors font-medium"
          >
            &larr; All Figures
          </button>
          <span className="text-[var(--text-xs)] text-muted-foreground/40">Page {selected.page + 1}</span>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 py-3 space-y-3">
          <button
            type="button"
            onClick={() => setLightboxFig(selected)}
            className="block w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/60 bg-card/20 transition-colors hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            title="Click to expand"
            aria-label="Expand figure"
          >
            <AuthImage
              src={api.getFigureUrl(paperId, selected.id)}
              alt={selected.caption || selected.id}
              className="w-full object-contain max-h-[250px]"
            />
          </button>

          {selected.caption && (
            <p className="text-[var(--text-xs)] text-muted-foreground/60 italic leading-relaxed line-clamp-3">
              {selected.caption}
            </p>
          )}

          {chat.length === 0 && !loading && (
            <button
              onClick={() => handleAnalyze(selected)}
              className="btn-primary-glass w-full rounded-lg px-4 py-2 text-[var(--text-sm)] font-medium text-background transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Analyze This Figure
            </button>
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
                    <div className="w-full max-w-[95%] rounded-lg border border-border/60 bg-card/30 px-3 py-2.5">
                      {msg.streaming && !msg.text && (
                        <div className="space-y-2">
                          <div className="w-full max-w-xs">
                            <AnalysisProgress kind="search" />
                          </div>
                          <p className="text-[var(--text-xs)] text-muted-foreground motion-safe:animate-pulse">Analyzing figure…</p>
                        </div>
                      )}
                      {msg.text && (
                        <div className="text-[var(--text-sm)] leading-relaxed">
                          <Md>{msg.text}</Md>
                          {msg.streaming && (
                            <span className="inline-block w-1.5 h-4 bg-foreground/60 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
                          )}
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
      <div className="rounded-xl border border-border/50 bg-card/20 px-3.5 py-3 shadow-[var(--shadow-xs)]">
        <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground/80">
          Tap a card to analyze. Add more via crop, screen capture, paste, or re-extract from the PDF.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={handleCaptureFromPdf}
            disabled={clipSaving || reextracting || loading}
            className="rounded-md border border-border/55 bg-background/50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent/45 hover:text-foreground disabled:opacity-40"
          >
            {clipSaving ? "…" : "Crop"}
          </button>
          <button
            type="button"
            onClick={handleScreenCapture}
            disabled={clipSaving || reextracting || loading}
            className="rounded-md border border-border/55 bg-background/50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent/45 hover:text-foreground disabled:opacity-40"
          >
            Screen
          </button>
          <button
            type="button"
            onClick={handlePasteFromClipboard}
            disabled={clipSaving || reextracting || loading}
            className="rounded-md border border-border/55 bg-background/50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent/45 hover:text-foreground disabled:opacity-40"
          >
            Paste
          </button>
          <button
            type="button"
            onClick={handleReextract}
            disabled={reextracting || clipSaving || loading}
            className="rounded-md border border-transparent px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/85 transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-40"
          >
            {reextracting ? "…" : "Re-extract"}
          </button>
        </div>
      </div>

      {clipError && (
        <p className="text-[var(--text-xs)] text-destructive/90" role="alert">
          {clipError}
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
                  src={api.getFigureUrl(paperId, fig.id)}
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
