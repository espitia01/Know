/** Anthropic prompt caching — ephemeral 5m TTL per AI SDK provider options. */
export const ANTHROPIC_CACHE_EPHEMERAL = {
  anthropic: {
    cacheControl: { type: "ephemeral" as const, ttl: "5m" as const },
  },
} as const;

export function cachedUserMessages(paperContextText: string, taskText: string) {
  return [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: paperContextText,
          providerOptions: ANTHROPIC_CACHE_EPHEMERAL,
        },
        { type: "text" as const, text: taskText },
      ],
    },
  ];
}
