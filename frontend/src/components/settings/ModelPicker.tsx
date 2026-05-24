"use client";

import { Check } from "lucide-react";
import {
  ProviderLogo,
  PROVIDER_LABEL,
  type ProviderName,
} from "@/components/ProviderLogo";

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
    name: "Mistral Small",
    provider: "mistral",
    tier: "fast",
    description:
      "Fast and inexpensive multilingual model. Great default for Explain, Derive, and quick Q&A on short papers.",
  },
  {
    id: "mistral-medium-latest",
    name: "Mistral Medium",
    provider: "mistral",
    tier: "balanced",
    description:
      "Mistral's balanced workhorse. Recommended for Summary on longer papers when you want depth without the cost of a frontier model.",
  },
  {
    id: "mistral-large-latest",
    name: "Mistral Large",
    provider: "mistral",
    tier: "top",
    description:
      "Mistral's frontier multimodal model. Use for the most demanding Summary and Derive runs.",
  },
  {
    id: "gpt-5-mini",
    name: "GPT-5 mini",
    provider: "openai",
    tier: "fast",
    description:
      "OpenAI's fastest current model. Snappy for selection-level explanations; concise prose.",
  },
  {
    id: "gpt-5",
    name: "GPT-5",
    provider: "openai",
    tier: "balanced",
    description:
      "OpenAI's general-purpose flagship. Strong at structured outputs, math, and code.",
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    tier: "top",
    description:
      "OpenAI's premium reasoning model. Use for the most complex derivations and long-context summaries.",
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku",
    provider: "anthropic",
    tier: "fast",
    description:
      "Anthropic's fast, low-cost model. Excellent for selection Q&A and follow-ups; strong writing voice.",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet",
    provider: "anthropic",
    tier: "balanced",
    description:
      "Anthropic's balanced model. Reliable for Summary and Assumptions across most paper lengths.",
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus",
    provider: "anthropic",
    tier: "top",
    description:
      "Anthropic's deepest analysis model. Reserve for hard derivations and dense theory papers.",
  },
];

const CAPABILITY_ORDER: ModelInfo["tier"][] = ["fast", "balanced", "top"];

const CAPABILITY_LABEL: Record<ModelInfo["tier"], string> = {
  fast: "Fast",
  balanced: "Balanced",
  top: "Top",
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

function providerKeyHint(provider: ProviderName): string {
  if (provider === "openai") return "KNOW_OPENAI_API_KEY";
  if (provider === "mistral") return "KNOW_MISTRAL_API_KEY";
  return "KNOW_ANTHROPIC_API_KEY";
}

function tierAllows(modelId: string, allowedIds: string[]): boolean {
  return allowedIds.includes(modelId);
}

function requiredPlanBadge(model: ModelInfo): "Scholar" | "Researcher" {
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
  const selected = value || "mistral-small-latest";

  return (
    <div className="space-y-3">
      <label className="text-[12px] text-muted-foreground font-medium">
        {label}
        <span className="text-muted-foreground/60 ml-1 font-normal">{hint}</span>
      </label>
      <div
        className="max-h-[280px] overflow-y-auto space-y-4 pr-1"
        role="radiogroup"
        aria-label={label}
      >
        {CAPABILITY_ORDER.map((capTier) => {
          const models = MODEL_CATALOG.filter((m) => m.tier === capTier);
          if (models.length === 0) return null;
          return (
            <div key={capTier} className="space-y-1.5">
              <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {CAPABILITY_LABEL[capTier]}
              </p>
              <div className="space-y-1">
                {models.map((m) => {
                  const configured = providerConfigured(m.provider, keys);
                  const allowed = tierAllows(m.id, allowedIds);
                  const disabled = !configured || !allowed;
                  const planBadge = !allowed ? requiredPlanBadge(m) : null;
                  const isSelected = selected === m.id;
                  const title = disabled
                    ? !configured
                      ? `Server is not configured for ${PROVIDER_LABEL[m.provider]} yet — ask your admin to set ${providerKeyHint(m.provider)}`
                      : `Available on the ${planBadge} plan.`
                    : undefined;

                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      aria-disabled={disabled}
                      name={name}
                      title={title}
                      disabled={disabled}
                      onClick={() => {
                        if (!disabled) onChange(m.id);
                      }}
                      className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-all duration-200 ${
                        disabled
                          ? "cursor-not-allowed opacity-45 glass-subtle"
                          : "cursor-pointer"
                      } ${
                        !disabled && isSelected
                          ? "glass-strong shadow-sm"
                          : !disabled
                            ? "glass-subtle hover:bg-accent"
                            : ""
                      }`}
                    >
                      <ProviderLogo provider={m.provider} size={16} tone="none" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-[13px] font-medium text-foreground">{m.name}</p>
                          {planBadge && (
                            <span className="text-[10px] font-medium text-muted-foreground glass-subtle px-1.5 py-0.5 rounded">
                              {planBadge}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground/80 mt-0.5 leading-relaxed line-clamp-2">
                          {m.description}
                        </p>
                      </div>
                      {isSelected && !disabled && (
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground/80" aria-hidden />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ProviderStatusPills({ keys }: { keys: ProviderKeys }) {
  const items: { provider: ProviderName; configured: boolean }[] = [
    { provider: "anthropic", configured: keys.anthropic },
    { provider: "openai", configured: keys.openai },
    { provider: "mistral", configured: keys.mistral },
  ];
  return (
    <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
      {items.map(({ provider, configured }) => (
        <span
          key={provider}
          className="inline-flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground glass-subtle px-2 py-1 rounded-full"
        >
          <ProviderLogo provider={provider} size={12} tone="none" />
          {PROVIDER_LABEL[provider]}: {configured ? "configured" : "not configured"}
        </span>
      ))}
    </div>
  );
}
