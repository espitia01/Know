"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type CodeAnalysis, type ParsedPaper } from "@/lib/api";
import { consumeSelectionSse } from "@/lib/selectionSse";
import { codeBlocksFromPaper, paperWithOcrMarkdown, type OcrCodeBlock } from "@/lib/ocrArtifacts";
import { usePaperOcrMarkdown } from "@/hooks/usePaperOcrMarkdown";
import { formatCodeAnalysisText } from "@/lib/artifactAnalysis";
import { useStore } from "@/lib/store";
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import { CardMeta } from "@/components/analysis/CardMeta";
import { ModelPill } from "@/components/analysis/ModelPill";
import { ModelOverridePill } from "@/components/analysis/ModelOverridePill";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { useUserSettings } from "@/lib/UserSettingsContext";

interface CodePanelProps {
  paperId: string;
}

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  model?: string;
};

function chatsFromAnalyses(analyses: CodeAnalysis[] | undefined): Record<string, ChatMessage[]> {
  const out: Record<string, ChatMessage[]> = {};
  for (const a of analyses ?? []) {
    const id = a.block_id;
    if (!out[id]) out[id] = [];
    const q = (a.question || "").trim();
    out[id].push({ role: "user", text: q || "Explain and implement this code" });
    const body = formatCodeAnalysisText(
      JSON.stringify({
        algorithm_explanation: a.algorithm_explanation,
        implementation: a.implementation,
        sketch_note: a.sketch_note,
      }),
    );
    out[id].push({ role: "assistant", text: body, model: a.model });
  }
  return out;
}

function appendCodeAnalysis(paperId: string, entry: CodeAnalysis) {
  const bump = (p: ParsedPaper | null): ParsedPaper | null => {
    if (!p || p.id !== paperId) return p;
    const prev = p.cached_analysis?.code_analyses ?? [];
    return {
      ...p,
      cached_analysis: { ...p.cached_analysis, code_analyses: [...prev, entry] },
    };
  };
  const s = useStore.getState();
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

function codeDisplayMarkdown(block: OcrCodeBlock): string {
  const lang = block.language === "text" ? "" : block.language;
  return `\`\`\`${lang}\n${block.code}\n\`\`\``;
}

function blockTitle(block: OcrCodeBlock): string {
  return block.title || block.context || (block.id.startsWith("algorithm-") ? "Algorithm" : "Code excerpt");
}

export function CodePanel({ paperId }: CodePanelProps) {
  const { fastModel, allowedModels } = useUserSettings();
  const paper = useStore((s) => s.paper);
  const cachedForPanel = useStore(useCallback((s) => s.papersById[paperId], [paperId]));
  const effectivePaper = paper?.id === paperId ? paper : cachedForPanel;
  const ocrMarkdown = usePaperOcrMarkdown(paperId);
  const paperForArtifacts = useMemo(
    () => paperWithOcrMarkdown(effectivePaper, ocrMarkdown),
    [effectivePaper, ocrMarkdown],
  );

  const blocks = useMemo(() => codeBlocksFromPaper(paperForArtifacts), [paperForArtifacts]);
  const [selected, setSelected] = useState<OcrCodeBlock | null>(null);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>({});
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const analysesSig = useMemo(() => {
    const list =
      effectivePaper?.id === paperId ? effectivePaper.cached_analysis?.code_analyses : undefined;
    if (!list?.length) return "0";
    const tail = list[list.length - 1];
    return `${list.length}:${tail.block_id}:${(tail.algorithm_explanation || "").length}`;
  }, [paperId, effectivePaper?.id, effectivePaper?.cached_analysis?.code_analyses]);

  useEffect(() => {
    if (!paperId || effectivePaper?.id !== paperId) return;
    setConversations(chatsFromAnalyses(effectivePaper.cached_analysis?.code_analyses));
  }, [paperId, effectivePaper?.id, analysesSig]);

  useEffect(() => () => { abortRef.current?.abort(); }, []);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversations, selected, loading]);

  const runAnalyze = useCallback(
    async (block: OcrCodeBlock, q: string = "") => {
      const resolvedModel = modelOverride ?? fastModel;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const userMsg: ChatMessage = {
        role: "user",
        text: q || "Explain the algorithm and provide an implementation",
      };
      setConversations((prev) => ({
        ...prev,
        [block.id]: [...(prev[block.id] || []), userMsg],
      }));
      setLoading(true);
      setConversations((prev) => ({
        ...prev,
        [block.id]: [
          ...(prev[block.id] || []),
          { role: "assistant", text: "", streaming: true, model: resolvedModel },
        ],
      }));

      const updateAssistant = (text: string, streaming: boolean) => {
        setConversations((prev) => {
          const msgs = [...(prev[block.id] || [])];
          const lastIdx = msgs.length - 1;
          if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
            msgs[lastIdx] = { role: "assistant", text, streaming, model: resolvedModel };
          }
          return { ...prev, [block.id]: msgs };
        });
      };

      try {
        const res = await api.analyzeCodeStream(
          paperId,
          block.id,
          block.code,
          block.language,
          block.context,
          q,
          { signal: controller.signal, model: resolvedModel },
        );
        if (!res.ok || !res.body) {
          throw new Error(`Code analysis failed (${res.status})`);
        }
        let rawJson = "";
        let finalText = "";
        await consumeSelectionSse(res.body.getReader(), controller.signal, {
          onChunk: (acc) => updateAssistant(formatCodeAnalysisText(acc), true),
          onDone: (full) => {
            rawJson = full;
            finalText = formatCodeAnalysisText(full);
          },
          onError: (m) => { throw new Error(m); },
        });
        if (!finalText.trim()) throw new Error("No code analysis was returned.");
        let parsed: Partial<CodeAnalysis> = {};
        try {
          parsed = JSON.parse(rawJson) as Partial<CodeAnalysis>;
        } catch {
          parsed = { algorithm_explanation: finalText, implementation: "" };
        }
        appendCodeAnalysis(paperId, {
          block_id: block.id,
          language: block.language,
          question: q,
          algorithm_explanation: (parsed.algorithm_explanation || finalText).trim(),
          implementation: (parsed.implementation || "").trim(),
          sketch_note: parsed.sketch_note ?? null,
          model: resolvedModel,
          created_at: Date.now(),
        });
        updateAssistant(finalText, false);
      } catch (e) {
        if (controller.signal.aborted) return;
        const msg = e instanceof Error ? e.message : "Code analysis failed";
        setConversations((prev) => ({
          ...prev,
          [block.id]: (prev[block.id] || []).filter((m) => !m.streaming).concat({
            role: "assistant",
            text: msg,
          }),
        }));
      } finally {
        setLoading(false);
      }
    },
    [paperId, fastModel, modelOverride],
  );

  if (!blocks.length) {
    return (
      <p className="text-[var(--text-sm)] text-muted-foreground/85">
        No algorithms or code blocks detected in this paper&apos;s OCR markdown.
      </p>
    );
  }

  if (selected) {
    const chat = conversations[selected.id] || [];
    const cached = effectivePaper?.cached_analysis?.code_analyses?.find(
      (a) => a.block_id === selected.id,
    );
    const analyzeLabel = selected.id.startsWith("algorithm-")
      ? "Analyze This Algorithm"
      : "Explain & Implement";

    return (
      <div className="flex min-h-0 flex-col h-full">
        <div className="flex items-center gap-2 pb-3 border-b border-border/50 shrink-0">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="text-[var(--text-sm)] text-muted-foreground hover:text-foreground transition-colors font-medium"
          >
            &larr; All Algorithms &amp; Code
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 py-3 space-y-3">
          <h3 className="font-display text-[var(--text-sm)] font-medium tracking-[-0.02em] text-foreground/90 leading-snug">
            {blockTitle(selected)}
          </h3>
          <CardMeta
            model={cached?.model ?? fastModel}
            pending={loading}
            createdAt={cached?.created_at}
            extra={
              <span className="text-muted-foreground/75 font-mono text-[var(--text-xs)]">
                {selected.language}
              </span>
            }
          />
          <div className="overflow-x-auto rounded-lg border border-border/50 bg-card/30 px-3 py-2.5">
            <StreamingMarkdown copyableCode>{codeDisplayMarkdown(selected)}</StreamingMarkdown>
          </div>

          {chat.length === 0 && !loading && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[var(--text-xs)] text-muted-foreground/85">
                <span>Model</span>
                <ModelOverridePill
                  model={modelOverride ?? fastModel}
                  allowed={allowedModels}
                  onChange={setModelOverride}
                />
              </div>
              <button
                type="button"
                onClick={() => void runAnalyze(selected)}
                className="btn-primary-glass w-full rounded-lg px-4 py-2 text-[var(--text-sm)] font-medium text-background transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {analyzeLabel}
              </button>
            </div>
          )}

          {chat.map((msg, i) =>
            msg.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="bg-foreground text-background rounded-xl rounded-br-sm px-3 py-2 max-w-[85%]">
                  <p className="text-[var(--text-sm)]">{msg.text}</p>
                </div>
              </div>
            ) : (
              <div key={i} className="rounded-lg border border-border/60 bg-card/30 px-3 py-2.5">
                {msg.streaming && !msg.text ? <AnalysisProgress kind="search" /> : null}
                {msg.text ? (
                  <StreamingMarkdown streaming={msg.streaming} copyableCode>
                    {msg.text}
                  </StreamingMarkdown>
                ) : null}
                {msg.model ? (
                  <div className="mt-2 flex justify-end">
                    <ModelPill slug={msg.model} pending={msg.streaming} />
                  </div>
                ) : null}
              </div>
            ),
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="shrink-0 pt-2 border-t border-border/50">
          <div className="flex gap-2">
            {allowedModels.length > 0 && (
              <ModelOverridePill
                model={modelOverride ?? fastModel}
                allowed={allowedModels}
                onChange={setModelOverride}
              />
            )}
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const q = question.trim();
                  if (!q || loading) return;
                  setQuestion("");
                  void runAnalyze(selected, q);
                }
              }}
              placeholder="Ask about this algorithm…"
              disabled={loading}
              className="know-non-credential-input flex-1 min-h-[2.25rem] rounded-[var(--radius-md)] border border-input bg-muted/30 px-3 py-2 text-[var(--text-sm)]"
            />
            <button
              type="button"
              disabled={!question.trim() || loading}
              onClick={() => {
                const q = question.trim();
                if (!q) return;
                setQuestion("");
                void runAnalyze(selected, q);
              }}
              className="btn-primary-glass h-9 shrink-0 rounded-lg px-3 text-[var(--text-xs)] font-medium text-background disabled:opacity-40"
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
      {blocks.map((b) => {
        const convoCount = conversations[b.id]?.length ?? 0;
        const preview = b.code.split("\n").find((l) => l.trim())?.trim().slice(0, 80) || b.language;
        return (
          <article
            key={b.id}
            className="overflow-hidden rounded-xl border border-border/50 bg-card/15 ring-focus transition-[border-color] motion-safe:duration-150 hover:border-border-strong hover:shadow-[var(--shadow-sm)]"
          >
            <button
              type="button"
              onClick={() => setSelected(b)}
              className="w-full px-3 pt-3 pb-2 text-left"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-display text-[var(--text-sm)] font-medium tracking-[-0.02em] text-foreground/90 line-clamp-2">
                  {blockTitle(b)}
                </p>
                {convoCount > 0 ? (
                  <span className="shrink-0 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-foreground px-1 text-[9px] font-semibold leading-none text-background">
                    {Math.floor(convoCount / 2)}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 line-clamp-2 font-mono text-[var(--text-xs)] text-muted-foreground/80">
                {preview}
              </p>
            </button>
            <div className="px-3 pb-2 max-h-40 overflow-hidden">
              <StreamingMarkdown copyableCode>{codeDisplayMarkdown(b)}</StreamingMarkdown>
            </div>
            <div className="flex gap-2 border-t border-border/40 px-3 py-2.5">
              <button
                type="button"
                onClick={() => setSelected(b)}
                className="flex-1 rounded-lg border border-border/50 px-3 py-1.5 text-[var(--text-xs)] font-medium text-foreground/90 hover:bg-muted/[0.12]"
              >
                Open
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(b);
                  void runAnalyze(b);
                }}
                className="btn-primary-glass flex-1 rounded-lg px-3 py-1.5 text-[var(--text-xs)] font-medium text-background disabled:opacity-40"
              >
                Analyze
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
