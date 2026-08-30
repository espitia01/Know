import { normalizeModelSlug } from "@/lib/modelLabels";

export type ProviderName = "anthropic" | "openai" | "mistral";

export function providerForSlug(slug: string): ProviderName {
  const id = normalizeModelSlug(slug);
  if (id.startsWith("claude-")) return "anthropic";
  if (id.startsWith("gpt-")) return "openai";
  if (
    id.startsWith("mistral-") ||
    id.startsWith("ministral-") ||
    id.startsWith("magistral-") ||
    id.startsWith("pixtral-")
  ) {
    return "mistral";
  }
  throw new Error(`Unknown model slug: ${slug}`);
}

/**
 * AI Gateway catalog IDs differ from first-party API IDs:
 * Claude 4.x uses dots (`claude-haiku-4.5`); Mistral drops `-latest`.
 * Direct SDKs still want the hyphen / `-latest` forms stored in Settings.
 */
export function toGatewayModelId(slug: string): string {
  const canonical = normalizeModelSlug(slug);
  const provider = providerForSlug(canonical);
  let id = canonical.replace(/-latest$/, "");
  id = id.replace(/^(claude-(?:haiku|sonnet|opus)-\d+)-(\d+)$/, "$1.$2");
  return `${provider}/${id}`;
}
