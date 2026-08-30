import "server-only";

import type { streamObject } from "ai";

/**
 * Convert a `streamObject` result into a streaming HTTP Response while
 * surfacing lazy provider failures as typed JSON before returning the
 * Response.
 *
 * Preflight tees `result.fullStream` and waits for the first `object` or
 * `text-delta` event. Timeout uses `reader.cancel()` — never `Promise.race`
 * on `reader.read()`, which leaves a pending read and can crash the
 * route with "Cannot read from a reader that has a pending read".
 *
 * The client branch is filtered to text deltas only (same as
 * `result.toTextStreamResponse()` for `experimental_useObject`).
 */

const DEPLOY_SHA =
  (process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || "dev").slice(0, 12);

const PREFLIGHT_TIMEOUT_MS = 90_000;

type ObjectStreamPart = {
  type: string;
  textDelta?: string;
  object?: unknown;
  error?: unknown;
};

export type StreamObjectResponseOptions = {
  model: string;
  releaseOnFailure?: () => Promise<void> | void;
  logTag?: string;
  logContext?: Record<string, unknown>;
};

export type StreamObjectErrorPayload = {
  status: number;
  body: { detail: { code: string; message: string; deploy: string; model?: string } };
};

function errorPayload(
  opts: StreamObjectResponseOptions,
  message: string,
  code = "provider_error",
): StreamObjectErrorPayload {
  return {
    status: 502,
    body: {
      detail: {
        code,
        message,
        deploy: DEPLOY_SHA,
        model: opts.model,
      },
    },
  };
}

function textDeltaFromPart(part: ObjectStreamPart | undefined): string {
  if (!part || part.type !== "text-delta") return "";
  return typeof part.textDelta === "string" ? part.textDelta : "";
}

function isProgressPart(part: ObjectStreamPart | undefined): boolean {
  if (!part) return false;
  if (part.type === "object") return true;
  return part.type === "text-delta" && !!textDeltaFromPart(part);
}

function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const name = (e as { name?: string }).name;
  return name === "AbortError";
}

async function preflightPeek(
  peek: ReadableStream<ObjectStreamPart>,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const reader = peek.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel("preflight_timeout");
  }, PREFLIGHT_TIMEOUT_MS);

  try {
    while (true) {
      let next: ReadableStreamReadResult<ObjectStreamPart>;
      try {
        next = await reader.read();
      } catch (e) {
        if (timedOut || isAbortError(e)) {
          return {
            ok: false,
            error: new Error(
              "Timed out waiting for the model to start streaming. Try again or pick a faster model in Settings.",
            ),
          };
        }
        return { ok: false, error: e };
      }
      if (next.done) {
        return { ok: false, error: new Error("Model returned no output") };
      }
      const part = next.value;
      if (!part) continue;
      if (part.type === "error") {
        return { ok: false, error: part.error ?? new Error("Provider error") };
      }
      if (isProgressPart(part)) {
        return { ok: true };
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function textStreamFromObjectStream(
  source: ReadableStream<ObjectStreamPart>,
): ReadableStream<string> {
  return source.pipeThrough(
    new TransformStream<ObjectStreamPart, string>({
      transform(part, controller) {
        const delta = textDeltaFromPart(part);
        if (delta) controller.enqueue(delta);
      },
    }),
  );
}

export async function buildStreamObjectResponse(
  result: ReturnType<typeof streamObject>,
  opts: StreamObjectResponseOptions,
): Promise<Response | StreamObjectErrorPayload> {
  const full = result.fullStream as ReadableStream<ObjectStreamPart>;
  if (typeof full.tee !== "function") {
    return errorPayload(
      opts,
      "Streaming is unavailable in this runtime. Please retry.",
      "stream_unavailable",
    );
  }

  let peek: ReadableStream<ObjectStreamPart>;
  let client: ReadableStream<ObjectStreamPart>;
  try {
    [peek, client] = full.tee();
  } catch (e) {
    if (opts.releaseOnFailure) {
      try {
        await opts.releaseOnFailure();
      } catch {
        /* ignore */
      }
    }
    const message = e instanceof Error ? e.message : String(e);
    if (opts.logTag) {
      console.error(
        JSON.stringify({
          tag: opts.logTag,
          stage: "tee",
          model: opts.model,
          error: message.slice(0, 800),
          ...opts.logContext,
        }),
      );
    }
    return errorPayload(opts, message);
  }

  const peeked = await preflightPeek(peek);
  if (!peeked.ok) {
    if (opts.releaseOnFailure) {
      try {
        await opts.releaseOnFailure();
      } catch {
        /* ignore */
      }
    }
    try {
      await client.cancel();
    } catch {
      /* ignore */
    }
    const message =
      peeked.error instanceof Error ? peeked.error.message : String(peeked.error);
    if (opts.logTag) {
      console.error(
        JSON.stringify({
          tag: opts.logTag,
          stage: "preflight",
          model: opts.model,
          error: message.slice(0, 800),
          ...opts.logContext,
        }),
      );
    }
    return errorPayload(opts, message);
  }

  const textStream = textStreamFromObjectStream(client);

  return new Response(textStream.pipeThrough(new TextEncoderStream()), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Know-Model": opts.model,
      "X-Know-Deploy": DEPLOY_SHA,
    },
  });
}

/**
 * Wrap an AI SDK text body as the Know SSE envelope (`chunk` / `done` /
 * `error`) that `consumeSelectionSse` already understands.
 */
export function knowSseFromTextBody(
  body: ReadableStream<Uint8Array>,
  extraHeaders: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let accumulated = "";
  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const delta = decoder.decode(value, { stream: true });
          if (!delta) continue;
          accumulated += delta;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "chunk", text: delta })}\n\n`),
          );
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "done", full_text: accumulated })}\n\n`),
        );
        controller.close();
      } catch (e) {
        const message = e instanceof Error ? e.message : "stream error";
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "error", message })}\n\n`),
          );
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(sse, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      ...extraHeaders,
    },
  });
}

/** Same headers as `buildStreamObjectResponse` for `toTextStreamResponse` fallbacks. */
export function streamResponseHeaders(model: string): Record<string, string> {
  return {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
    "X-Know-Model": model,
    "X-Know-Deploy": DEPLOY_SHA,
  };
}

export function isStreamErrorPayload(
  value: Response | StreamObjectErrorPayload,
): value is StreamObjectErrorPayload {
  return !(value instanceof Response);
}
