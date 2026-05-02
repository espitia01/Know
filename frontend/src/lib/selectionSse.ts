/**
 * Shared SSE parser for `/selection-stream` (same envelope as figure QA stream).
 */

export type SelectionSseHandlers = {
  onChunk: (accumulated: string) => void;
  onDone: (fullText: string) => void;
  onError: (message: string) => void;
};

export async function consumeSelectionSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  handlers: SelectionSseHandlers,
): Promise<void> {
  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";
  let finished = false;
  /** Coalesce ultra-frequent SSE chunk events → one UI update per frame (avoids main-thread stalls). */
  let chunkRaf: number | null = null;

  const cancelChunkRaf = () => {
    if (chunkRaf != null && typeof window !== "undefined") {
      window.cancelAnimationFrame(chunkRaf);
      chunkRaf = null;
    }
  };

  const emitAccumulatedChunk = () => {
    handlers.onChunk(accumulated);
  };

  while (true) {
    if (signal?.aborted) {
      cancelChunkRaf();
      await reader.cancel();
      break;
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
          text?: string;
          full_text?: string;
          message?: string;
        };
        if (event.type === "chunk" && typeof event.text === "string") {
          accumulated += event.text;
          if (typeof window === "undefined") {
            emitAccumulatedChunk();
          } else if (chunkRaf == null) {
            chunkRaf = window.requestAnimationFrame(() => {
              chunkRaf = null;
              emitAccumulatedChunk();
            });
          }
        } else if (event.type === "done") {
          finished = true;
          cancelChunkRaf();
          emitAccumulatedChunk();
          handlers.onDone(typeof event.full_text === "string" ? event.full_text : accumulated);
          return;
        } else if (event.type === "error") {
          finished = true;
          cancelChunkRaf();
          emitAccumulatedChunk();
          handlers.onError(typeof event.message === "string" ? event.message : "Unknown error");
          return;
        }
      } catch {
        /* ignore malformed SSE payload */
      }
    }
  }

  if (!finished && accumulated.length > 0) {
    cancelChunkRaf();
    emitAccumulatedChunk();
    handlers.onDone(accumulated);
  }
}
