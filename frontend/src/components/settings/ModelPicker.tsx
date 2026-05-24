"use client";

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

const PROVIDER_ORDER: ProviderName[] = ["mistral", "openai", "anthropic"];

const PROVIDER_TONE: Record<ProviderName, "warm" | "cool"> = {
  mistral: "warm",
  openai: "cool",
  anthropic: "cool",
};

const TIER_BADGE: Record<ModelInfo["tier"], string> = {
  fast: "fast",
  balanced: "balanced",
  top: "top",
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
  const allowed = new Set(allowedIds);
  const visible = MODEL_CATALOG.filter((m) => allowed.has(m.id));

  return (
    <div className="space-y-3">
      <label className="text-[12px] text-muted-foreground font-medium">
        {label}
        <span className="text-muted-foreground/60 ml-1 font-normal">{hint}</span>
      </label>
      <div className="space-y-4">
        {PROVIDER_ORDER.map((provider) => {
          const models = visible.filter((m) => m.provider === provider);
          if (models.length === 0) return null;
          const configured = providerConfigured(provider, keys);
          return (
            <div key={provider} className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <ProviderLogo provider={provider} size={16} tone={PROVIDER_TONE[provider]} />
                <span className="text-[12px] font-medium text-foreground/90">
                  {PROVIDER_LABEL[provider]}
                </span>
              </div>
              <div className="space-y-1.5">
                {models.map((m) => {
                  const disabled = !configured;
                  return (
                    <label
                      key={m.id}
                      title={
                        disabled
                          ? `Server is not configured for ${PROVIDER_LABEL[provider]} yet — ask your admin to set ${providerKeyHint(provider)}`
                          : undefined
                      }
                      className={`flex items-start gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
                        disabled
                          ? "opacity-45 cursor-not-allowed glass-subtle"
                          : "cursor-pointer"
                      } ${
                        !disabled && selected === m.id
                          ? "glass-strong shadow-sm"
                          : !disabled
                            ? "glass-subtle hover:bg-accent"
                            : ""
                      }`}
                    >
                      <input
                        type="radio"
                        name={name}
                        value={m.id}
                        checked={selected === m.id}
                        disabled={disabled}
                        onChange={() => onChange(m.id)}
                        className="accent-foreground mt-1"
                      />
                      <ProviderLogo provider={provider} size={16} tone="none" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-[13px] font-medium text-foreground">{m.name}</p>
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground glass-subtle px-1.5 py-0.5 rounded">
                            {TIER_BADGE[m.tier]}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground/80 mt-0.5 leading-relaxed">
                          {m.description}
                        </p>
                      </div>
                    </label>
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
