/** Anthropic prompt caching — ephemeral 5m TTL per AI SDK provider options. */
import { providerForSlug } from "@/lib/modelGateway";

export const ANTHROPIC_CACHE_EPHEMERAL = {
  anthropic: {
    cacheControl: { type: "ephemeral" as const, ttl: "5m" as const },
  },
} as const;

/** Apply Anthropic prompt caching only for Claude slugs. */
export function providerOptionsForSlug(slug: string) {
  try {
    if (providerForSlug(slug) === "anthropic") {
      return ANTHROPIC_CACHE_EPHEMERAL;
    }
  } catch {
    return undefined;
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
