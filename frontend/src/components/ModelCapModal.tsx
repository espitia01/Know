"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  registerModelCapPrompter,
  ModelCapPromptInput,
  ModelCapPromptResult,
} from "@/lib/modelCapPrompt";

const MODEL_LABEL: Record<string, string> = {
  "claude-haiku-4-5": "Haiku",
  "claude-sonnet-4-6": "Sonnet",
  "claude-opus-4-7": "Opus",
  "claude-opus-4": "Opus",
};

type PendingPrompt = ModelCapPromptInput & {
  fallback: string | null;
  resolve: (r: ModelCapPromptResult) => void;
};

export function ModelCapModal() {
  const router = useRouter();
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const pendingRef = useRef<PendingPrompt | null>(null);
  pendingRef.current = pending;

  useEffect(() => {
    const prompter = async (
      input: ModelCapPromptInput
    ): Promise<ModelCapPromptResult> => {
      // Lazy import to avoid pulling api.ts into the registry module cycle.
      const { api } = await import("@/lib/api");
      let allowed: string[] = [];
      try {
        allowed = (await api.getModels()).models || [];
      } catch {
        allowed = [];
      }
      const { pickFallback } = await import("@/lib/modelCapPrompt");
      const fallback = pickFallback(input.cappedModel, allowed);

      return new Promise<ModelCapPromptResult>((resolve) => {
        setPending({ ...input, fallback, resolve });
      });
    };

    registerModelCapPrompter(prompter);
    return () => registerModelCapPrompter(null);
  }, []);

  const finish = useCallback(
    (result: ModelCapPromptResult) => {
      const current = pendingRef.current;
      if (!current) return;
      current.resolve(result);
      setPending(null);
    },
    []
  );

  useEffect(() => {
    if (!pending) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [pending, finish]);

  if (!pending) return null;

  const cappedLabel = MODEL_LABEL[pending.cappedModel] || pending.cappedModel;
  const fallbackLabel = pending.fallback
    ? MODEL_LABEL[pending.fallback] || pending.fallback
    : null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`${cappedLabel} daily limit reached`}
    >
      <div
        className="absolute inset-0 bg-foreground/25 backdrop-blur-md"
        onClick={() => finish(null)}
      />
      <div className="relative glass-strong rounded-2xl shadow-xl max-w-md w-full mx-4 overflow-hidden animate-fade-in">
        <div className="px-6 pt-6 pb-5 border-b border-border">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-warning/15 flex items-center justify-center shrink-0">
              <svg
                className="w-5 h-5 text-warning"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.75}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                />
              </svg>
            </div>
            <div className="flex-1">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
                {cappedLabel} daily limit reached
              </h2>
              <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed text-pretty">
                You&apos;ve used all {pending.limit} {cappedLabel} calls for today on
                the <span className="capitalize">{pending.tier}</span> plan.
                {fallbackLabel
                  ? ` Switch to ${fallbackLabel} to keep going, or wait until midnight UTC.`
                  : " Try again after midnight UTC."}
              </p>
            </div>
          </div>
        </div>

        <div className="px-6 py-5 space-y-2">
          {pending.fallback && fallbackLabel && (
            <button
              onClick={() => finish({ fallback: pending.fallback! })}
              className="w-full text-[13px] font-semibold py-3 rounded-xl btn-primary-glass"
            >
              Switch to {fallbackLabel} and retry
            </button>
          )}
          <button
            onClick={() => {
              finish(null);
              router.push("/settings");
            }}
            className="w-full text-[13px] font-medium py-3 rounded-xl glass glass-hover text-foreground ring-focus"
          >
            Open settings
          </button>
          <button
            onClick={() => finish(null)}
            className="w-full text-[12px] font-medium py-2 text-muted-foreground hover:text-foreground transition-colors ring-focus rounded"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
