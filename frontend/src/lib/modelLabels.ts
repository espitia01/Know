export type ModelTone = "amber" | "violet" | "blue";

export const MODEL_LABEL: Record<string, { short: string; tone: ModelTone }> = {
  "claude-haiku-4-5": { short: "Haiku", tone: "blue" },
  "claude-sonnet-4-6": { short: "Sonnet", tone: "violet" },
  "claude-opus-4-7": { short: "Opus", tone: "amber" },
};

export function modelLabel(slug?: string | null): { short: string; tone: ModelTone } {
  if (!slug) return { short: "Model", tone: "blue" };
  return (
    MODEL_LABEL[slug] ?? {
      short: slug.replace(/^claude-/, "").replace(/-\d.*$/, ""),
      tone: "blue",
    }
  );
}

export function promptDepthForModel(slug: string): "concise" | "standard" | "deep" {
  if (slug.includes("opus")) return "deep";
  if (slug.includes("sonnet")) return "standard";
  return "concise";
}
