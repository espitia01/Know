"use client";

/**
 * Selection explain / derive / follow-up — Railway SSE streaming.
 *
 * The model returns markdown chunks; we append them onto the live
 * `explanation` field so users see tokens render in real time
 * (ChatGPT-style). On `done`, the final markdown is persisted.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { api, type SelectionAnalysisResult } from "@/lib/api";
import { consumeSelectionSse } from "@/lib/selectionSse";
import { useStore } from "@/lib/store";
import { useUserSettings } from "@/lib/UserSettingsContext";

export type SelectionAction = "explain" | "derive" | "followup";

export type StartArgs = {
  action: SelectionAction;
  selectedText: string;
  question?: string;
  model?: string;
  regions?: SelectionAnalysisResult["regions"];
  imageBase64?: string;
};

type StartedState = {
  clientKey: string;
  action: SelectionAction;
  selectedText: string;
  question?: string;
  model: string;
  regions?: SelectionAnalysisResult["regions"];
};

function newClientKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function useSelectionThread(paperId: string) {
  const { fastModel } = useUserSettings();
  const setSelectionResultForPaper = useStore((s) => s.setSelectionResultForPaper);
  const setSelectionLoadingForPaper = useStore((s) => s.setSelectionLoadingForPaper);
  const upsertSelectionInHistoryForPaper = useStore((s) => s.upsertSelectionInHistoryForPaper);
  const bumpUsageRefresh = useStore((s) => s.bumpUsageRefresh);

  const inflightRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<Error | undefined>();
  const [isLoading, setIsLoading] = useState(false);

  const abort = useCallback(() => {
    inflightRef.current?.abort();
    inflightRef.current = null;
    setIsLoading(false);
    setSelectionLoadingForPaper(paperId, false);
  }, [paperId, setSelectionLoadingForPaper]);

  const start = useCallback(
    (args: StartArgs) => {
      const trimmed = args.selectedText.trim();
      if (!trimmed && !args.imageBase64) return;
      const textForApi = trimmed || "Equation selected from PDF (see attached image).";

      inflightRef.current?.abort();
      const controller = new AbortController();
      inflightRef.current = controller;

      const clientKey = newClientKey();
      const started: StartedState = {
        clientKey,
        action: args.action,
        selectedText: textForApi,
        question: args.question,
        model: args.model ?? fastModel,
        regions: args.regions,
      };

      const provisional: SelectionAnalysisResult = {
        action: args.action,
        selected_text: trimmed,
        question: args.question,
        explanation: "",
        streaming: true,
        clientKey,
        model: started.model,
        regions: args.regions,
      };

      setError(undefined);
      setIsLoading(true);
      setSelectionLoadingForPaper(paperId, true);
      upsertSelectionInHistoryForPaper(paperId, provisional);
      setSelectionResultForPaper(paperId, provisional);

      const updateExplanation = (text: string, streaming: boolean) => {
        const next: SelectionAnalysisResult = {
          ...provisional,
          explanation: text,
          streaming,
          created_at: streaming ? provisional.created_at : Date.now(),
        };
        upsertSelectionInHistoryForPaper(paperId, next);
        setSelectionResultForPaper(paperId, next);
      };

      void (async () => {
        let streamError: string | null = null;
        let finalText = "";
        try {
          const res = await api.analyzeSelectionStream(paperId, textForApi, args.action, {
            signal: controller.signal,
            question: args.question,
            model: started.model,
            imageBase64: args.imageBase64,
          });
          if (!res.ok || !res.body) {
            const detail = await res.text().catch(() => "");
            // FastAPI error bodies are JSON: pull out the structured detail
            // before throwing so the UI shows a real reason.
            try {
              const parsed = JSON.parse(detail) as { detail?: { message?: string } | string };
              const msg =
                typeof parsed.detail === "string"
                  ? parsed.detail
                  : parsed.detail?.message;
              throw new Error(msg || `Selection stream failed (${res.status})`);
            } catch {
              throw new Error(detail || `Selection stream failed (${res.status})`);
            }
          }
          await consumeSelectionSse(
            res.body.getReader(),
            controller.signal,
            {
              onChunk: (accumulated) => updateExplanation(accumulated, true),
              onDone: (full) => {
                finalText = full;
              },
              onError: (message) => {
                streamError = message;
              },
            },
          );
          if (controller.signal.aborted) return;
          if (streamError) throw new Error(streamError);
          if (!finalText.trim()) {
            throw new Error("The model didn't return a complete answer. Please try again.");
          }
          updateExplanation(finalText, false);
          bumpUsageRefresh();
        } catch (e) {
          if (controller.signal.aborted) return;
          const message = e instanceof Error ? e.message : "Selection failed.";
          const errResult: SelectionAnalysisResult = {
            ...provisional,
            explanation: message,
            streaming: false,
          };
          upsertSelectionInHistoryForPaper(paperId, errResult);
          setSelectionResultForPaper(paperId, errResult);
          setError(e instanceof Error ? e : new Error(message));
        } finally {
          if (inflightRef.current === controller) {
            inflightRef.current = null;
          }
          setIsLoading(false);
          setSelectionLoadingForPaper(paperId, false);
        }
      })();
    },
    [
      bumpUsageRefresh,
      fastModel,
      paperId,
      setSelectionLoadingForPaper,
      setSelectionResultForPaper,
      upsertSelectionInHistoryForPaper,
    ],
  );

  return useMemo(
    () => ({ start, abort, error, isLoading }),
    [start, abort, error, isLoading],
  );
}
