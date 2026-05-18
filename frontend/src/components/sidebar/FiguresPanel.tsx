"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { parsePartialJson } from "ai";
import { api, type FigureInfo, type FigureAnalysis, type ParsedPaper } from "@/lib/api";
import { captureScreenTabToPng, readClipboardImageBlob } from "@/lib/pdfSelectionCapture";
import { useStore } from "@/lib/store";
// Stage 3: figure analysis streams from the migrated AI SDK route and
// renders via Streamdown.
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
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

  const marqueeMode = useStore((s) => s.marqueeMode);
  const setMarqueeMode = useStore((s) => s.setMarqueeMode);
  const pendingFigureBlob = useStore((s) => s.pendingFigureBlob);
  const setPendingFigureBlob = useStore((s) => s.setPendingFigureBlob);
  const pendingFigureCaption = useStore((s) => s.pendingFigureCaption);
  const setPendingFigureCaption = useStore((s) => s.setPendingFigureCaption);

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
        // Stage 3: hit the migrated Next.js + AI SDK route on the same
        // origin. The response body is a streaming JSON document
        // (incremental text output of `streamObject(FigureAnalysis)`).
        // We parse the partial JSON on each frame and pull `answer` or
        // `description` for the streaming assistant message.
        const streamFigure = async (attempt: number): Promise<Response> => {
          const res = await fetch(`/api/papers/${paperId}/figure-qa-stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ figure_id: figId, question: q }),
            signal: controller.signal,
          });
          if (controller.signal.aborted) return res;
          if (!res.ok && res.status === 404 && attempt === 0) {
            await new Promise((r) => setTimeout(r, 750));
            return streamFigure(1);
          }
          return res;
        };

        const res = await streamFigure(0);
        if (controller.signal.aborted) return;
        if (!res.ok) {
          let detailMessage = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.detail?.message) detailMessage = body.detail.message;
          } catch { /* not JSON */ }
          if (detailMessage === "Figure 404" || detailMessage.includes("404")) {
            detailMessage = "Figure image is not available yet. Wait a moment and try again.";
          }
          throw new Error(detailMessage);
        }
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No stream");

        const decoder = new TextDecoder();
        let jsonAccum = "";
        let lastDisplay = "";
        let chunkRaf: number | null = null;

        // Add a streaming assistant message that we'll update in place.
        setConversations((prev) => ({
          ...prev,
          [figId]: [...(prev[figId] || []), { role: "assistant", text: "", streaming: true }],
        }));

        const flushDisplay = () => {
          chunkRaf = null;
          const current = lastDisplay;
          setConversations((prev) => {
            const msgs = [...(prev[figId] || [])];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
              msgs[lastIdx] = { ...msgs[lastIdx], text: current };
            }
            return { ...prev, [figId]: msgs };
          });
        };

        const scheduleDisplay = () => {
          if (typeof window === "undefined") { flushDisplay(); return; }
          if (chunkRaf == null) {
            chunkRaf = window.requestAnimationFrame(flushDisplay);
          }
        };

        while (true) {
          if (controller.signal.aborted) { await reader.cancel(); break; }
          const { done, value } = await reader.read();
          if (done) break;
          jsonAccum += decoder.decode(value, { stream: true });
          // Try to parse the partial JSON document; pull the most-
          // useful narrative field for the visible assistant bubble.
          const partial = await parsePartialJson(jsonAccum);
          const obj = (partial.value as Partial<FigureAnalysis> | undefined) ?? null;
          if (obj) {
            const next = (obj.answer ?? obj.description ?? "") as string;
            if (next && next !== lastDisplay) {
              lastDisplay = next;
              scheduleDisplay();
            }
          }
        }

        if (chunkRaf != null && typeof window !== "undefined") {
          window.cancelAnimationFrame(chunkRaf);
          chunkRaf = null;
        }

        // Final parse — same logic, but commit a non-streaming row and
        // hydrate the rest of the structured fields into the local
        // cache so the panel's history row matches what the server
        // persisted in cached_analysis.figure_analyses.
        const finalParsed = await parsePartialJson(jsonAccum);
        const finalObj = (finalParsed.value as Partial<FigureAnalysis> | undefined) ?? {};
        const finalText = (finalObj.answer ?? finalObj.description ?? lastDisplay ?? "") as string;
        const cacheEntry: FigureAnalysis = {
          figure_id: figId,
          question: q,
          description: (finalObj.description ?? finalText) as string,
          key_observations: (finalObj.key_observations as string[] | undefined) ?? [],
          relation_to_paper: (finalObj.relation_to_paper as string | undefined) ?? "",
          methodology_shown: finalObj.methodology_shown as string | undefined,
          takeaway: finalObj.takeaway as string | undefined,
          answer: finalObj.answer as string | undefined,
        };
        appendFigureAnalysisToCaches(paperId, cacheEntry);
        setConversations((prev) => {
          const msgs = [...(prev[figId] || [])];
          const lastIdx = msgs.length - 1;
          if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
            msgs[lastIdx] = { role: "assistant", text: finalText, streaming: false };
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
        const { figure: uploaded, figures: uploadedFigures } = await api.uploadFigureFromSelection(paperId, blob);
        const caption = useStore.getState().pendingFigureCaption;
        const figure = caption ? { ...uploaded, caption } : uploaded;
        const figures = uploadedFigures.map((f) => (f.id === figure.id ? figure : f));
        if (caption) useStore.getState().setPendingFigureCaption(null);
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

  useEffect(() => {
    if (!pendingFigureBlob) return;
    const blob = pendingFigureBlob;
    setPendingFigureBlob(null);
    void ingestFigureBlob(blob, "Region capture failed.");
  }, [pendingFigureBlob, setPendingFigureBlob, ingestFigureBlob, pendingFigureCaption, setPendingFigureCaption]);

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
      <div className="mx-auto flex max-w-lg flex-col gap-6 rounded-2xl border border-border/45 bg-gradient-to-b from-card/35 to-card/[0.08] px-6 py-9 text-center shadow-[var(--shadow-sm)] backdrop-blur-[2px] motion-safe:animate-fade-in dark:from-card/20 dark:to-transparent">
        <div className="space-y-2.5">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-border/40 bg-background/50 text-muted-foreground/60 shadow-inner">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.25}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
          </div>
          <p className="text-[var(--text-md)] font-semibold tracking-tight text-foreground/95">No figures detected</p>
          <p className="mx-auto max-w-sm text-[var(--text-xs)] leading-snug text-muted-foreground/88">
            Nothing was extracted from the PDF. Capture a region, paste an image, or re-run extraction.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleScreenCapture}
            disabled={clipSaving || reextracting}
            className="btn-primary-glass inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[var(--text-sm)] font-semibold text-background shadow-md transition-[opacity,transform] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg className="h-4 w-4 shrink-0 opacity-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z" />
            </svg>
            {clipSaving ? "Saving…" : "Capture screen or window…"}
          </button>
          <button
            type="button"
            title="Draw a rectangle on the PDF to capture a region"
            onClick={() => setMarqueeMode(true)}
            disabled={marqueeMode || clipSaving || reextracting}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border/65 bg-background/70 px-4 py-2.5 text-[var(--text-sm)] font-medium text-foreground/90 backdrop-blur-sm transition-colors hover:border-border-strong hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg className="h-4 w-4 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3.75H6A2.25 2.25 0 0 0 3.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0 1 20.25 6v1.5M20.25 16.5V18A2.25 2.25 0 0 1 18 20.25h-1.5M3.75 16.5V18A2.25 2.25 0 0 0 6 20.25h1.5" />
            </svg>
            {marqueeMode ? "Drawing…" : "Select region"}
          </button>
          <button
            type="button"
            onClick={handlePasteFromClipboard}
            disabled={clipSaving || reextracting}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border/65 bg-background/70 px-4 py-2.5 text-[var(--text-sm)] font-medium text-foreground/90 backdrop-blur-sm transition-colors hover:border-border-strong hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg className="h-4 w-4 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.65}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.398.084.612v9.75c0 .414-.336.75-.75.75H4.5a.75.75 0 0 1-.75-.75v-9.75c0-.214.03-.418.084-.612m7.336 0c.653.734 1.693 1.164 2.744 1.323.31.067.627.097.956.097h3.073a2.25 2.25 0 0 0 2.227-1.932m-11.964-11.962L4.744 15.058A75.846 75.846 0 0 1 12 21.75a75.837 75.837 0 0 1-7.893-11.962Z" />
            </svg>
            Paste from clipboard
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
                        <StreamingMarkdown streaming={msg.streaming}>
                          {msg.text}
                        </StreamingMarkdown>
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
      <div className="rounded-xl border border-border/50 bg-muted/25 px-3.5 py-3 shadow-[var(--shadow-xs)] backdrop-blur-[2px] dark:bg-muted/15">
        <p className="text-[11px] font-medium text-foreground/90 tracking-tight">Add or capture</p>
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground/90">
          Marquee on the PDF, browser capture, paste an image, or re-run extraction.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5 rounded-[10px] border border-border/40 bg-background/35 p-1 dark:bg-background/25">
          <button
            type="button"
            title="Opens your browser's screen / window picker"
            onClick={handleScreenCapture}
            disabled={clipSaving || reextracting || loading}
            className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-border/55 bg-background/80 px-2.5 py-1.5 text-[11px] font-semibold text-foreground/92 shadow-sm shadow-black/[0.02] transition-colors hover:border-border-strong hover:bg-accent/35 disabled:opacity-40 dark:shadow-black/20"
          >
            <svg className="h-3.5 w-3.5 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z" />
            </svg>
            {clipSaving ? "…" : "Capture"}
          </button>
          <button
            type="button"
            title="Draw a rectangle on the PDF to capture a region"
            onClick={() => setMarqueeMode(true)}
            disabled={marqueeMode || clipSaving || reextracting || loading}
            className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-border/55 bg-background/80 px-2.5 py-1.5 text-[11px] font-semibold text-foreground/92 shadow-sm shadow-black/[0.02] transition-colors hover:border-border-strong hover:bg-accent/35 disabled:opacity-40 dark:shadow-black/20"
          >
            <svg className="h-3.5 w-3.5 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3.75H6A2.25 2.25 0 0 0 3.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0 1 20.25 6v1.5M20.25 16.5V18A2.25 2.25 0 0 1 18 20.25h-1.5M3.75 16.5V18A2.25 2.25 0 0 0 6 20.25h1.5" />
            </svg>
            {marqueeMode ? "Drawing…" : "Select region"}
          </button>
          <button
            type="button"
            title="Clipboard image after system screenshot"
            onClick={handlePasteFromClipboard}
            disabled={clipSaving || reextracting || loading}
            className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-border/55 bg-background/80 px-2.5 py-1.5 text-[11px] font-semibold text-foreground/92 shadow-sm shadow-black/[0.02] transition-colors hover:border-border-strong hover:bg-accent/35 disabled:opacity-40 dark:shadow-black/20"
          >
            <svg className="h-3.5 w-3.5 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.65}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.398.084.612v9.75c0 .414-.336.75-.75.75H4.5a.75.75 0 0 1-.75-.75v-9.75c0-.214.03-.418.084-.612m7.336 0c.653.734 1.693 1.164 2.744 1.323.31.067.627.097.956.097h3.073a2.25 2.25 0 0 0 2.227-1.932m-11.964-11.962L4.744 15.058A75.846 75.846 0 0 1 12 21.75a75.837 75.837 0 0 1-7.893-11.962Z" />
            </svg>
            Paste
          </button>
          <button
            type="button"
            title="Try built-in detection again after changing the PDF"
            onClick={handleReextract}
            disabled={reextracting || clipSaving || loading}
            className="inline-flex min-h-8 items-center rounded-md px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground/95 transition-colors hover:bg-accent/45 hover:text-foreground disabled:opacity-40"
          >
            {reextracting ? "…" : "Re-extract PDF"}
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
