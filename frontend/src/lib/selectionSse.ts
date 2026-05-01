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

  while (true) {
    if (signal?.aborted) {
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
          handlers.onChunk(accumulated);
        } else if (event.type === "done") {
          finished = true;
          handlers.onDone(typeof event.full_text === "string" ? event.full_text : accumulated);
          return;
        } else if (event.type === "error") {
          finished = true;
          handlers.onError(typeof event.message === "string" ? event.message : "Unknown error");
          return;
        }
      } catch {
        /* ignore malformed SSE payload */
      }
    }
  }

  if (!finished && accumulated.length > 0) {
    handlers.onDone(accumulated);
  }
}
