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
