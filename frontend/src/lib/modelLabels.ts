import type { ProviderName } from "@/components/ProviderLogo";

export type ModelTone = "amber" | "violet" | "blue";

export const MODEL_LABEL: Record<
  string,
  { short: string; tone: ModelTone; provider: ProviderName }
> = {
  "claude-haiku-4-5": { short: "Haiku", tone: "blue", provider: "anthropic" },
  "claude-sonnet-4-6": { short: "Sonnet", tone: "violet", provider: "anthropic" },
  "claude-opus-4-7": { short: "Opus", tone: "amber", provider: "anthropic" },
  "gpt-5-mini": { short: "GPT-5 mini", tone: "blue", provider: "openai" },
  "gpt-5": { short: "GPT-5", tone: "violet", provider: "openai" },
  "gpt-5.4": { short: "GPT-5.4", tone: "amber", provider: "openai" },
  "mistral-small-latest": { short: "Mistral Small", tone: "blue", provider: "mistral" },
  "mistral-medium-latest": { short: "Mistral Medium", tone: "violet", provider: "mistral" },
  "mistral-large-latest": { short: "Mistral Large", tone: "amber", provider: "mistral" },
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
  "claude-opus-4": "claude-opus-4-7",
  "claude-sonnet-4-5": "claude-sonnet-4-6",
  "claude-haiku-4": "claude-haiku-4-5",
  "gpt-4.1": "gpt-5",
  "gpt-4.1-mini": "gpt-5-mini",
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
    slug.includes("opus") ||
    slug.includes("gpt-5.4") ||
    slug.includes("mistral-large")
  ) {
    return "deep";
  }
  if (
    slug.includes("sonnet") ||
    slug === "gpt-5" ||
    slug.includes("mistral-medium")
  ) {
    return "standard";
  }
  return "concise";
}
