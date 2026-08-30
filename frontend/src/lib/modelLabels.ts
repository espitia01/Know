import type { ProviderName } from "@/components/ProviderLogo";

export type ModelTone = "amber" | "violet" | "blue";

export const MODEL_LABEL: Record<
  string,
  { short: string; tone: ModelTone; provider: ProviderName }
> = {
  "claude-haiku-4-5": { short: "Haiku", tone: "blue", provider: "anthropic" },
  "claude-sonnet-5": { short: "Sonnet", tone: "violet", provider: "anthropic" },
  "claude-sonnet-4-6": { short: "Sonnet", tone: "violet", provider: "anthropic" },
  "claude-fable-5": { short: "Fable", tone: "amber", provider: "anthropic" },
  "claude-opus-5": { short: "Fable", tone: "amber", provider: "anthropic" },
  "claude-opus-4-7": { short: "Fable", tone: "amber", provider: "anthropic" },
  "gpt-5.4-mini": { short: "GPT-5.4 mini", tone: "blue", provider: "openai" },
  "gpt-5-mini": { short: "GPT-5.4 mini", tone: "blue", provider: "openai" },
  "gpt-5.6-terra": { short: "GPT-5.6 Terra", tone: "violet", provider: "openai" },
  "gpt-5": { short: "GPT-5.6 Terra", tone: "violet", provider: "openai" },
  "gpt-5.6-sol": { short: "GPT-5.6 Sol", tone: "amber", provider: "openai" },
  "gpt-5.4": { short: "GPT-5.6 Sol", tone: "amber", provider: "openai" },
  "mistral-small-latest": { short: "Mistral Small 4", tone: "blue", provider: "mistral" },
  "mistral-medium-latest": { short: "Mistral Medium 3.5", tone: "violet", provider: "mistral" },
  "mistral-large-latest": { short: "Mistral Large 3", tone: "amber", provider: "mistral" },
};

export function modelLabel(slug?: string | null): {
  short: string;
  tone: ModelTone;
  provider?: ProviderName;
} {
  if (!slug) return { short: "Model", tone: "blue" };
  return (
    MODEL_LABEL[slug] ?? {
      short: slug.replace(/^(claude-|gpt-|mistral-)/, "").replace(/-latest$/, ""),
      tone: "blue" as ModelTone,
    }
  );
}

/** Keep in sync with `MODEL_ALIASES` in `backend/app/gating.py`. */
const MODEL_ALIASES: Record<string, string> = {
  "claude-opus-4": "claude-fable-5",
  "claude-opus-4-0": "claude-fable-5",
  "claude-opus-4-1": "claude-fable-5",
  "claude-opus-4-5": "claude-fable-5",
  "claude-opus-4-6": "claude-fable-5",
  "claude-opus-4-7": "claude-fable-5",
  "claude-opus-4-8": "claude-fable-5",
  "claude-opus-5": "claude-fable-5",
  "claude-sonnet-4-0": "claude-sonnet-5",
  "claude-sonnet-4-5": "claude-sonnet-5",
  "claude-sonnet-4-6": "claude-sonnet-5",
  "claude-haiku-4": "claude-haiku-4-5",
  "gpt-4.1": "gpt-5.6-terra",
  "gpt-4.1-mini": "gpt-5.4-mini",
  "gpt-5-mini": "gpt-5.4-mini",
  "gpt-5": "gpt-5.6-terra",
  "gpt-5.4": "gpt-5.6-sol",
  "mistral-large": "mistral-large-latest",
  "mistral-medium": "mistral-medium-latest",
  "mistral-small": "mistral-small-latest",
  "mistral-tiny": "mistral-small-latest",
};

export function normalizeModelSlug(slug?: string | null): string {
  if (!slug) return "";
  const trimmed = slug.trim();
  return MODEL_ALIASES[trimmed] ?? trimmed;
}

export function modelsMatch(a?: string | null, b?: string | null): boolean {
  const left = normalizeModelSlug(a);
  const right = normalizeModelSlug(b);
  if (!left || !right) return false;
  return left === right;
}

export function promptDepthForModel(slug: string): "concise" | "standard" | "deep" {
  if (
    slug.includes("fable") ||
    slug.includes("opus") ||
    slug.includes("gpt-5.6-sol") ||
    (slug.includes("gpt-5.4") && !slug.includes("mini")) ||
    slug.includes("mistral-large")
  ) {
    return "deep";
  }
  if (
    slug.includes("sonnet") ||
    slug.includes("gpt-5.6-terra") ||
    slug === "gpt-5" ||
    slug.includes("mistral-medium")
  ) {
    return "standard";
  }
  return "concise";
}
