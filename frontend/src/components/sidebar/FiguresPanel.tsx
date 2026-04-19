"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type FigureInfo } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";

interface FiguresPanelProps {
  paperId: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
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
      <div className={`flex items-center justify-center text-muted-foreground/30 text-[11px] ${className || ""}`}>
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
      className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-8 animate-fade-in"
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

function ProgressBar({ running }: { running: boolean }) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!running) { setWidth(100); return; }
    setWidth(0);
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      // Asymptotic: approaches 90% over ~30s, never reaches 100 until done
      setWidth(Math.min(90, 90 * (1 - Math.exp(-elapsed / 12))));
    }, 200);
    return () => clearInterval(interval);
  }, [running]);

  return (
    <div className="w-full h-1 bg-accent rounded-full overflow-hidden">
      <div
        className="h-full bg-foreground/60 rounded-full transition-all duration-300 ease-out"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

export function FiguresPanel({ paperId }: FiguresPanelProps) {
  const { paper, setPaper } = useStore();
  const figures = (paper?.id === paperId ? paper?.figures : null) ?? [];
  const [selected, setSelected] = useState<FigureInfo | null>(null);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [reextracting, setReextracting] = useState(false);
  const [lightboxFig, setLightboxFig] = useState<FigureInfo | null>(null);

  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>({});
  const chatEndRef = useRef<HTMLDivElement>(null);
  const prevPaperIdRef = useRef(paperId);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (prevPaperIdRef.current !== paperId) {
      abortRef.current?.abort();
      setSelected(null);
      setConversations({});
      prevPaperIdRef.current = paperId;
    }
  }, [paperId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversations, selected, loading]);

  const handleReextract = useCallback(async () => {
    if (!paper) return;
    setReextracting(true);
    try {
      const result = await api.reextractFigures(paperId);
      setPaper({ ...paper, figures: result.figures });
      setSelected(null);
      setConversations({});
    } catch (e) {
      console.error("Re-extraction failed:", e);
    } finally {
      setReextracting(false);
    }
  }, [paperId, paper, setPaper]);

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
        const res = await api.analyzeFigureStream(paperId, figId, q);
        if (controller.signal.aborted) return;
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No stream");

        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";

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
                const current = accumulated;
                setConversations((prev) => {
                  const msgs = [...(prev[figId] || [])];
                  const lastIdx = msgs.length - 1;
                  if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
                    msgs[lastIdx] = { ...msgs[lastIdx], text: current };
                  }
                  return { ...prev, [figId]: msgs };
                });
              } else if (event.type === "done") {
                const final = event.full_text || accumulated;
                setConversations((prev) => {
                  const msgs = [...(prev[figId] || [])];
                  const lastIdx = msgs.length - 1;
                  if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
                    msgs[lastIdx] = { role: "assistant", text: final, streaming: false };
                  }
                  return { ...prev, [figId]: msgs };
                });
              } else if (event.type === "error") {
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

  const handleAsk = useCallback(() => {
    if (!selected || !question.trim()) return;
    handleAnalyze(selected, question.trim());
    setQuestion("");
  }, [selected, question, handleAnalyze]);

  if (figures.length === 0) {
    return (
      <div className="text-center py-8">
        <svg className="w-10 h-10 mx-auto text-muted-foreground/20 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
        </svg>
        <p className="text-[13px] text-muted-foreground/60">No figures detected in this paper.</p>
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
            className="text-[12px] text-muted-foreground hover:text-foreground transition-colors font-medium"
          >
            &larr; All Figures
          </button>
          <span className="text-[11px] text-muted-foreground/40">Page {selected.page + 1}</span>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 py-3 space-y-3">
          <div
            className="rounded-xl glass-subtle overflow-hidden cursor-zoom-in hover:bg-white/60 transition-colors"
            onClick={() => setLightboxFig(selected)}
            title="Click to expand"
          >
            <AuthImage
              src={api.getFigureUrl(paperId, selected.id)}
              alt={selected.caption || selected.id}
              className="w-full object-contain max-h-[250px]"
            />
          </div>

          {selected.caption && (
            <p className="text-[11px] text-muted-foreground/60 italic leading-relaxed line-clamp-3">
              {selected.caption}
            </p>
          )}

          {chat.length === 0 && !loading && (
            <button
              onClick={() => handleAnalyze(selected)}
              className="w-full text-[12px] font-medium btn-primary-glass text-background px-4 py-2 rounded-xl transition-opacity"
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
                      <p className="text-[12px] leading-relaxed">{msg.text}</p>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex justify-start w-full">
                    <div className="glass-subtle rounded-xl rounded-bl-sm px-3 py-2.5 max-w-[95%] w-full">
                      {msg.streaming && !msg.text && (
                        <div className="space-y-2">
                          <ProgressBar running={true} />
                          <p className="text-[11px] text-muted-foreground animate-pulse">Analyzing figure...</p>
                        </div>
                      )}
                      {msg.text && (
                        <div className="text-[12.5px] leading-relaxed">
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
            <div className="flex justify-start w-full">
              <div className="glass-subtle rounded-xl rounded-bl-sm px-3 py-2.5 w-full space-y-2">
                <ProgressBar running={true} />
                <p className="text-[11px] text-muted-foreground animate-pulse">Sending to AI...</p>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        <div className="shrink-0 pt-2 border-t border-border/50">
          <div className="flex gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAsk(); }
              }}
              placeholder="Ask about this figure..."
              disabled={loading}
              className="flex-1 text-[12px] px-3 py-2 rounded-xl border border-white/20 glass-subtle placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            />
            <button
              onClick={handleAsk}
              disabled={!question.trim() || loading}
              className="text-[11px] font-medium px-3 py-2 rounded-xl btn-primary-glass text-background transition-opacity disabled:opacity-30 shrink-0"
            >
              Ask
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-muted-foreground/60">
        Click a figure to analyze it and ask questions. Click the image to expand.
      </p>

      <div className="grid grid-cols-2 gap-2">
        {figures.map((fig) => (
          <button
            key={fig.id}
            onClick={() => setSelected(fig)}
            className="group rounded-xl glass-subtle overflow-hidden hover:bg-white/60 transition-colors"
          >
            <div className="aspect-[4/3] overflow-hidden relative">
              <AuthImage
                src={api.getFigureUrl(paperId, fig.id)}
                alt={fig.caption || fig.id}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
              />
              {conversations[fig.id]?.length > 0 && (
                <div className="absolute top-1 right-1 bg-foreground text-background text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                  {Math.floor(conversations[fig.id].length / 2)}
                </div>
              )}
            </div>
            <div className="px-2 py-1.5 text-left">
              <p className="text-[11px] font-medium truncate">
                {fig.caption
                  ? fig.caption.slice(0, 40) + (fig.caption.length > 40 ? "..." : "")
                  : `Page ${fig.page + 1}`}
              </p>
            </div>
          </button>
        ))}
      </div>

      <div className="pt-2 border-t border-border/30">
        <button
          onClick={handleReextract}
          disabled={reextracting}
          className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors disabled:opacity-40"
        >
          {reextracting ? "Re-extracting..." : "Re-extract figures"}
        </button>
      </div>
    </div>
  );
}
