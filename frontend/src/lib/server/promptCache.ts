/** Anthropic prompt caching — ephemeral 5m TTL per AI SDK provider options. */
import { providerForSlug } from "@/lib/server/llm";

export const ANTHROPIC_CACHE_EPHEMERAL = {
  anthropic: {
    cacheControl: { type: "ephemeral" as const, ttl: "5m" as const },
  },
} as const;

/** Apply Anthropic prompt caching only for Claude slugs. */
export function providerOptionsForSlug(slug: string) {
  if (providerForSlug(slug) === "anthropic") {
    return ANTHROPIC_CACHE_EPHEMERAL;
  }
  return undefined;
}

export function cachedUserMessages(
  slug: string,
  paperContextText: string,
  taskText: string
) {
  const cacheOpts = providerOptionsForSlug(slug);
  return [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: paperContextText,
          ...(cacheOpts ? { providerOptions: cacheOpts } : {}),
        },
        { type: "text" as const, text: taskText },
      ],
    },
  ];
}
