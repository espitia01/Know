import "server-only";

import type { streamObject } from "ai";

/**
 * Convert a `streamObject` result into a streaming HTTP Response while
 * surfacing lazy provider failures as a typed JSON error BEFORE handing
 * any Response to Next.js. Without this, AI SDK's lazy stream errors
 * (missing API key, AI Gateway rejection, structured-output mismatch)
 * happen after the Response is returned — and Next.js converts them to
 * a generic 500.
 *
 * The peek reads `result.fullStream` until either:
 *   - the first `text-delta` event arrives (model is producing output;
 *     start streaming) — buffered deltas are re-emitted at the head of
 *     the body so the client sees the same byte sequence AI SDK's own
 *     `toTextStreamResponse` would produce; or
 *   - an `error` event fires (return JSON 502 directly).
 *
 * Vercel's `maxDuration` on the route is the only timeout we need —
 * a custom `Promise.race` against `setTimeout` would leave the
 * underlying `fullReader.read()` pending, which then throws
 * "Cannot read from a reader that has a pending read" the first time
 * the passthrough tries to read again.
 */

const DEPLOY_SHA =
  (process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || "dev").slice(0, 12);

type ObjectStreamPart<T> =
  | { type: "text-delta"; textDelta: string }
  | { type: "object"; object: T }
  | { type: "finish"; [key: string]: unknown }
  | { type: "error"; error: unknown };

export type StreamObjectResponseOptions = {
  /** Slug of the model that's actually serving — emitted as `X-Know-Model`. */
  model: string;
  /** Best-effort rollback of the prior usage reservation. */
  releaseOnFailure?: () => Promise<void> | void;
  /** Optional structured tag passed to console.error logging. */
  logTag?: string;
  /** Optional context for log lines. */
  logContext?: Record<string, unknown>;
};

export type StreamObjectErrorPayload = {
  status: number;
  body: { detail: { code: string; message: string; deploy: string; model?: string } };
};

export async function buildStreamObjectResponse<T>(
  result: ReturnType<typeof streamObject>,
  opts: StreamObjectResponseOptions,
): Promise<Response | StreamObjectErrorPayload> {
  const fullReader = (
    result.fullStream as unknown as ReadableStream<ObjectStreamPart<T>>
  ).getReader();
  const bufferedDeltas: string[] = [];
  let preflightError: unknown = null;
  let sawTextDelta = false;
  let streamExhausted = false;

  try {
    while (!sawTextDelta && preflightError === null) {
      const peeked = await fullReader.read();
      if (peeked.done) {
        streamExhausted = true;
        break;
      }
      const evt = peeked.value;
      if (!evt) continue;
      if (evt.type === "text-delta") {
        bufferedDeltas.push(evt.textDelta);
        sawTextDelta = true;
        break;
      }
      if (evt.type === "error") {
        preflightError = evt.error;
        break;
      }
    }
  } catch (e) {
    preflightError = e;
  }

  if (preflightError !== null) {
    try {
      fullReader.releaseLock();
    } catch {
      /* ignore */
    }
    if (opts.releaseOnFailure) {
      try {
        await opts.releaseOnFailure();
      } catch {
        /* ignore */
      }
    }
    const message =
      preflightError instanceof Error
        ? preflightError.message
        : String(preflightError);
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
    return {
      status: 502,
      body: {
        detail: {
          code: "provider_error",
          message,
          deploy: DEPLOY_SHA,
          model: opts.model,
        },
      },
    };
  }

  const encoder = new TextEncoder();
  const passthrough = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const delta of bufferedDeltas) {
          if (delta) controller.enqueue(encoder.encode(delta));
        }
        if (!streamExhausted) {
          while (true) {
            const { done, value } = await fullReader.read();
            if (done) break;
            if (!value) continue;
            if (value.type === "text-delta") {
              if (value.textDelta) controller.enqueue(encoder.encode(value.textDelta));
            } else if (value.type === "error") {
              // streamObject's onError already logged + released.
              break;
            }
          }
        }
        try {
          fullReader.releaseLock();
        } catch {
          /* already released */
        }
        controller.close();
      } catch (err) {
        if (opts.logTag) {
          console.error(
            JSON.stringify({
              tag: opts.logTag,
              stage: "passthrough",
              model: opts.model,
              error: err instanceof Error ? err.message : String(err),
              ...opts.logContext,
            }),
          );
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(passthrough, {
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

export function isStreamErrorPayload(
  value: Response | StreamObjectErrorPayload,
): value is StreamObjectErrorPayload {
  return !(value instanceof Response);
}
