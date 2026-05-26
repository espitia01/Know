"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ParsedPaper, type TableAnalysis } from "@/lib/api";
import { consumeSelectionSse } from "@/lib/selectionSse";
import { tablesFromPaper, paperWithOcrMarkdown, type OcrTable } from "@/lib/ocrArtifacts";
import { usePaperOcrMarkdown } from "@/hooks/usePaperOcrMarkdown";
import { formatTableAnalysisText } from "@/lib/artifactAnalysis";
import { useStore } from "@/lib/store";
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import { CardMeta } from "@/components/analysis/CardMeta";
import { ModelPill } from "@/components/analysis/ModelPill";
import { ModelOverridePill } from "@/components/analysis/ModelOverridePill";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { useUserSettings } from "@/lib/UserSettingsContext";

interface TablesPanelProps {
  paperId: string;
}

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  model?: string;
};

function chatsFromAnalyses(analyses: TableAnalysis[] | undefined): Record<string, ChatMessage[]> {
  const out: Record<string, ChatMessage[]> = {};
  for (const a of analyses ?? []) {
    const id = a.table_id;
    if (!out[id]) out[id] = [];
    const q = (a.question || "").trim();
    out[id].push({ role: "user", text: q || "Analyze this table" });
    const body = formatTableAnalysisText(
      JSON.stringify({ answer: a.answer, summary: a.summary }),
    );
    out[id].push({ role: "assistant", text: body, model: a.model });
  }
  return out;
}

function appendTableAnalysis(paperId: string, entry: TableAnalysis) {
  const bump = (p: ParsedPaper | null): ParsedPaper | null => {
    if (!p || p.id !== paperId) return p;
    const prev = p.cached_analysis?.table_analyses ?? [];
    return {
      ...p,
      cached_analysis: { ...p.cached_analysis, table_analyses: [...prev, entry] },
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

export function TablesPanel({ paperId }: TablesPanelProps) {
  const { fastModel, allowedModels } = useUserSettings();
  const paper = useStore((s) => s.paper);
  const cachedForPanel = useStore(useCallback((s) => s.papersById[paperId], [paperId]));
  const effectivePaper = paper?.id === paperId ? paper : cachedForPanel;
  const ocrMarkdown = usePaperOcrMarkdown(paperId);
  const paperForArtifacts = useMemo(
    () => paperWithOcrMarkdown(effectivePaper, ocrMarkdown),
    [effectivePaper, ocrMarkdown],
  );

  const tables = useMemo(() => tablesFromPaper(paperForArtifacts), [paperForArtifacts]);
  const [selected, setSelected] = useState<OcrTable | null>(null);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>({});
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const analysesSig = useMemo(() => {
    const list =
      effectivePaper?.id === paperId ? effectivePaper.cached_analysis?.table_analyses : undefined;
    if (!list?.length) return "0";
    const tail = list[list.length - 1];
    return `${list.length}:${tail.table_id}:${(tail.answer || "").length}`;
  }, [paperId, effectivePaper?.id, effectivePaper?.cached_analysis?.table_analyses]);

  useEffect(() => {
    if (!paperId || effectivePaper?.id !== paperId) return;
    setConversations(chatsFromAnalyses(effectivePaper.cached_analysis?.table_analyses));
  }, [paperId, effectivePaper?.id, analysesSig]);

  useEffect(() => () => { abortRef.current?.abort(); }, []);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversations, selected, loading]);

  const runAnalyze = useCallback(
    async (table: OcrTable, q: string = "") => {
      const resolvedModel = modelOverride ?? fastModel;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const userMsg: ChatMessage = { role: "user", text: q || "Analyze this table" };
      setConversations((prev) => ({
        ...prev,
        [table.id]: [...(prev[table.id] || []), userMsg],
      }));
      setLoading(true);
      setConversations((prev) => ({
        ...prev,
        [table.id]: [
          ...(prev[table.id] || []),
          { role: "assistant", text: "", streaming: true, model: resolvedModel },
        ],
      }));

      const updateAssistant = (text: string, streaming: boolean) => {
        setConversations((prev) => {
          const msgs = [...(prev[table.id] || [])];
          const lastIdx = msgs.length - 1;
          if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
            msgs[lastIdx] = { role: "assistant", text, streaming, model: resolvedModel };
          }
          return { ...prev, [table.id]: msgs };
        });
      };

      try {
        const res = await api.analyzeTableStream(
          paperId,
          table.id,
          table.markdown,
          table.label,
          q,
          { signal: controller.signal, model: resolvedModel },
        );
        if (!res.ok || !res.body) {
          throw new Error(`Table analysis failed (${res.status})`);
        }
        let rawJson = "";
        let finalText = "";
        await consumeSelectionSse(res.body.getReader(), controller.signal, {
          onChunk: (acc) => updateAssistant(formatTableAnalysisText(acc), true),
          onDone: (full) => {
            rawJson = full;
            finalText = formatTableAnalysisText(full);
          },
          onError: (m) => { throw new Error(m); },
        });
        if (!finalText.trim()) throw new Error("No table analysis was returned.");
        let answer = finalText;
        let summary: string | null = null;
        try {
          const parsed = JSON.parse(rawJson) as { answer?: string; summary?: string | null };
          if (parsed.answer?.trim()) answer = parsed.answer.trim();
          summary = parsed.summary ?? null;
        } catch {
          /* use formatted text */
        }
        appendTableAnalysis(paperId, {
          table_id: table.id,
          table_label: table.label,
          question: q,
          answer,
          summary,
          model: resolvedModel,
          created_at: Date.now(),
        });
        updateAssistant(finalText, false);
      } catch (e) {
        if (controller.signal.aborted) return;
        const msg = e instanceof Error ? e.message : "Table analysis failed";
        setConversations((prev) => ({
          ...prev,
          [table.id]: (prev[table.id] || []).filter((m) => !m.streaming).concat({
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

  if (!tables.length) {
    return (
      <p className="text-[var(--text-sm)] text-muted-foreground/85">
        No tables detected in this paper&apos;s OCR markdown.
      </p>
    );
  }

  if (selected) {
    const chat = conversations[selected.id] || [];
    return (
      <div className="flex min-h-0 flex-col gap-4">
        <button
          type="button"
          onClick={() => setSelected(null)}
          className="text-[var(--text-xs)] font-medium text-muted-foreground/90 hover:text-foreground w-fit"
        >
          ← All tables
        </button>
        <h3 className="font-display text-[var(--text-sm)] font-medium tracking-[-0.02em] text-foreground/90">
          {selected.label}
        </h3>
        <CardMeta extra={<span className="text-muted-foreground/75">Table</span>} />
        <div className="rounded-lg border border-border/50 bg-card/30 px-3 py-2.5 overflow-x-auto">
          <StreamingMarkdown copyableCode>{selected.markdown}</StreamingMarkdown>
        </div>
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
        <div className="flex gap-2 border-t border-border/50 pt-2">
          <ModelOverridePill model={modelOverride ?? fastModel} allowed={allowedModels} onChange={setModelOverride} />
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
            placeholder="Ask about this table…"
            disabled={loading}
            className="know-non-credential-input flex-1 min-h-[2.25rem] rounded-[var(--radius-md)] border border-input bg-muted/30 px-3 py-2 text-[var(--text-sm)]"
          />
          <button
            type="button"
            disabled={loading}
            onClick={() => void runAnalyze(selected, question.trim())}
            className="btn-primary-glass h-9 shrink-0 rounded-lg px-3 text-[var(--text-xs)] font-medium text-background disabled:opacity-40"
          >
            Ask
          </button>
        </div>
        {chat.length === 0 && !loading ? (
          <button
            type="button"
            onClick={() => void runAnalyze(selected)}
            className="btn-primary-glass w-full rounded-lg px-4 py-2 text-[var(--text-sm)] font-medium text-background"
          >
            Analyze This Table
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {tables.map((t) => {
        const count = conversations[t.id]?.length ?? 0;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setSelected(t)}
            className="rounded-xl border border-border/50 bg-card/15 px-3 py-3 text-left hover:border-border-strong hover:shadow-[var(--shadow-sm)]"
          >
            <p className="text-[var(--text-sm)] font-medium text-foreground/90">{t.label}</p>
            <p className="mt-1 line-clamp-2 text-[var(--text-xs)] text-muted-foreground/80 font-mono">
              {t.markdown.split("\n").find((l) => l.includes("|")) || t.markdown.slice(0, 80)}
            </p>
            {count > 0 ? (
              <span className="mt-2 inline-block text-[var(--text-xs)] text-muted-foreground">
                {Math.floor(count / 2)} conversation{count > 2 ? "s" : ""}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
