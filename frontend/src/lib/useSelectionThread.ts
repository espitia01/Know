"use client";

/**
 * Selection explain / derive / follow-up — Python batch on Railway.
 * Vercel `selection-stream` + `streamObject` OOMs on production (~1.8 GB heap).
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { api, type SelectionAnalysisResult } from "@/lib/api";
import { normalizeSelectionResult } from "@/lib/normalizeSelectionResult";
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
  model?: string;
  regions?: SelectionAnalysisResult["regions"];
};

function newClientKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function describeApiError(e: unknown): string {
  if (e instanceof Error) {
    const msg = e.message;
    if (msg.includes("tier_locked") || msg.includes("Limit reached")) {
      return `**Limit reached.** ${msg}\n\nUpgrade your plan to continue.`;
    }
    return msg || "Selection failed.";
  }
  return "Selection failed.";
}

function mapApiResult(
  started: StartedState,
  raw: SelectionAnalysisResult,
): SelectionAnalysisResult {
  return normalizeSelectionResult(raw, {
    action: started.action,
    selected_text: started.selectedText,
    question: started.question,
    streaming: false,
    clientKey: started.clientKey,
    model: started.model,
    created_at: Date.now(),
    regions: started.regions,
  });
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
      if (!trimmed) return;

      inflightRef.current?.abort();
      const controller = new AbortController();
      inflightRef.current = controller;

      const clientKey = newClientKey();
      const started: StartedState = {
        clientKey,
        action: args.action,
        selectedText: trimmed,
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

      void (async () => {
        try {
          const raw = await api.analyzeSelection(paperId, trimmed, args.action, {
            question: args.question,
            signal: controller.signal,
            model: started.model,
            imageBase64: args.imageBase64,
            regions: args.regions,
          });
          if (controller.signal.aborted) return;

          const result = mapApiResult(started, raw);
          if (
            !result.explanation?.trim() &&
            !result.steps?.length &&
            !result.final_result?.trim()
          ) {
            throw new Error("The model didn't return a complete answer. Please try again.");
          }

          upsertSelectionInHistoryForPaper(paperId, result);
          setSelectionResultForPaper(paperId, result);
          bumpUsageRefresh();
        } catch (e) {
          if (controller.signal.aborted) return;
          const message = describeApiError(e);
          const errResult: SelectionAnalysisResult = {
            action: started.action,
            selected_text: started.selectedText,
            question: started.question,
            explanation: message,
            streaming: false,
            clientKey: started.clientKey,
            model: started.model,
            regions: started.regions,
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
