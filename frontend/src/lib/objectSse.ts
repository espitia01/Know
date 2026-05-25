/**
 * SSE parser for endpoints that emit progressive JSON objects.
 *
 * Each event is `data: { "type": "start" | "object" | "done" | "error", ... }\n\n`.
 * `object` events carry a partial dict the caller merges into UI state;
 * `done` carries the final dict (or echoes the latest `object`).
 */

export type ObjectSseHandlers<T> = {
  onObject: (partial: T) => void;
  onDone: (final: T) => void;
  onError: (message: string) => void;
};

export async function consumeObjectSse<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  handlers: ObjectSseHandlers<T>,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let lastObject: T | null = null;
  let chunkRaf: number | null = null;
  let pendingObject: T | null = null;

  const cancelChunkRaf = () => {
    if (chunkRaf != null && typeof window !== "undefined") {
      window.cancelAnimationFrame(chunkRaf);
      chunkRaf = null;
    }
  };

  const flushPending = () => {
    if (pendingObject == null) return;
    handlers.onObject(pendingObject);
    pendingObject = null;
  };

  while (true) {
    if (signal?.aborted) {
      cancelChunkRaf();
      await reader.cancel();
      return;
    }
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6)) as {
          type?: string;
          object?: T;
          message?: string;
        };
        if (event.type === "object" && event.object) {
          lastObject = event.object;
          pendingObject = event.object;
          if (typeof window === "undefined") {
            flushPending();
          } else if (chunkRaf == null) {
            chunkRaf = window.requestAnimationFrame(() => {
              chunkRaf = null;
              flushPending();
            });
          }
        } else if (event.type === "done") {
          cancelChunkRaf();
          flushPending();
          handlers.onDone((event.object ?? lastObject) as T);
          return;
        } else if (event.type === "error") {
          cancelChunkRaf();
          flushPending();
          handlers.onError(event.message || "Unknown error");
          return;
        }
      } catch {
        /* ignore malformed payload */
      }
    }
  }

  cancelChunkRaf();
  flushPending();
  if (lastObject) handlers.onDone(lastObject);
}
