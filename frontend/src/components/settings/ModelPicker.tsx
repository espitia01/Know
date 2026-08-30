"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  ProviderLogo,
  PROVIDER_LABEL,
  type ProviderName,
} from "@/components/ProviderLogo";
import { normalizeModelSlug } from "@/lib/modelLabels";

export type ModelInfo = {
  id: string;
  name: string;
  provider: ProviderName;
  tier: "fast" | "balanced" | "top";
  description: string;
};

export const MODEL_CATALOG: ModelInfo[] = [
  {
    id: "mistral-small-latest",
    name: "Mistral Small 4",
    provider: "mistral",
    tier: "fast",
    description: "Fast default for Explain, Derive, and short Q&A.",
  },
  {
    id: "mistral-medium-latest",
    name: "Mistral Medium 3.5",
    provider: "mistral",
    tier: "balanced",
    description: "Balanced depth for Summary without frontier cost.",
  },
  {
    id: "mistral-large-latest",
    name: "Mistral Large 3",
    provider: "mistral",
    tier: "top",
    description: "Frontier Mistral. Use for dense Summary and Derive runs.",
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 mini",
    provider: "openai",
    tier: "fast",
    description: "Snappy selection-level explanations.",
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "openai",
    tier: "balanced",
    description: "Strong at structured output, math, and code.",
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai",
    tier: "top",
    description: "Flagship reasoning for hard derivations and long papers.",
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    tier: "fast",
    description: "Fast Q&A and follow-ups with a strong writing voice.",
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "anthropic",
    tier: "balanced",
    description: "Reliable for Summary and Assumptions on most papers.",
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    provider: "anthropic",
    tier: "top",
    description: "Deepest analysis. Reserve for dense theory papers.",
  },
];

const PROVIDER_ORDER: ProviderName[] = ["anthropic", "openai", "mistral"];

const CAPABILITY_LABEL: Record<ModelInfo["tier"], string> = {
  fast: "Fast",
  balanced: "Standard",
  top: "Advanced",
};

type ProviderKeys = {
  anthropic: boolean;
  openai: boolean;
  mistral: boolean;
};

function providerConfigured(provider: ProviderName, keys: ProviderKeys): boolean {
  if (provider === "anthropic") return keys.anthropic;
  if (provider === "openai") return keys.openai;
  return keys.mistral;
}

function requiredPlan(model: ModelInfo): "Scholar" | "Researcher" {
  if (model.tier === "top") return "Researcher";
  return "Scholar";
}

interface ModelPickerProps {
  label: string;
  hint: string;
  name: string;
  value: string;
  allowedIds: string[];
  keys: ProviderKeys;
  onChange: (id: string) => void;
}

export function ModelPicker({
  label,
  hint,
  name,
  value,
  allowedIds,
  keys,
  onChange,
}: ModelPickerProps) {
  const selectedId = normalizeModelSlug(value) || "mistral-small-latest";
  const selected =
    MODEL_CATALOG.find((m) => m.id === selectedId) ?? MODEL_CATALOG[0];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="space-y-1.5">
      <div className="space-y-0.5">
        <label className="text-[13px] font-medium text-foreground" htmlFor={name}>
          {label}
        </label>
        <p className="text-[12px] text-muted-foreground">{hint}</p>
      </div>
      <button
        id={name}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-full items-center gap-2.5 rounded-lg border border-border/50 bg-background px-3 text-left motion-safe:duration-150 hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ProviderLogo provider={selected.provider} size={14} tone="none" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {selected.name}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {CAPABILITY_LABEL[selected.tier]}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground motion-safe:duration-150 ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className="overflow-hidden rounded-lg border border-border/50 bg-background shadow-[var(--shadow-sm)]"
        >
          {PROVIDER_ORDER.map((provider) => {
            const models = MODEL_CATALOG.filter((m) => m.provider === provider);
            if (models.length === 0) return null;
            return (
              <div key={provider} className="border-b border-border/40 last:border-b-0">
                <p className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <ProviderLogo provider={provider} size={10} tone="none" />
                  {PROVIDER_LABEL[provider]}
                </p>
                {models.map((m) => {
                  const configured = providerConfigured(m.provider, keys);
                  const allowed = allowedIds.includes(m.id);
                  const disabled = !configured || !allowed;
                  const isSelected = selectedId === m.id;
                  const lockLabel = !allowed
                    ? requiredPlan(m)
                    : !configured
                      ? "Unavailable"
                      : null;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={disabled}
                      onClick={() => {
                        onChange(m.id);
                        setOpen(false);
                      }}
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left motion-safe:duration-150 ${
                        disabled
                          ? "cursor-not-allowed opacity-45"
                          : "hover:bg-accent/50"
                      } ${isSelected && !disabled ? "bg-muted/[0.08]" : ""}`}
                    >
                      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                        {m.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {lockLabel ?? CAPABILITY_LABEL[m.tier]}
                      </span>
                      {isSelected && !disabled && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-foreground/80" aria-hidden />
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {selected.description}
      </p>
    </div>
  );
}
