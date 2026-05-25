import "server-only";

import type { streamObject } from "ai";

/**
 * Convert a `streamObject` result into a streaming HTTP Response while
 * surfacing lazy provider failures as typed JSON *before* returning the
 * Response. Without preflight, AI SDK lazy stream errors become a generic
 * Next.js 500 after headers would have been sent.
 *
 * Uses `fullStream.tee()` so preflight reads one branch while the client
 * body reads the other — never double-reads a single reader (which caused
 * "Cannot read from a reader that has a pending read" crashes).
 *
 * The outbound body matches `result.toTextStreamResponse()` (UTF-8 text
 * chunks of JSON deltas only) so `experimental_useObject` can parse it.
 */

const DEPLOY_SHA =
  (process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || "dev").slice(0, 12);

type ObjectStreamPart = {
  type: string;
  textDelta?: string;
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

function textDeltaFromPart(part: ObjectStreamPart | undefined): string {
  if (!part || part.type !== "text-delta") return "";
  return typeof part.textDelta === "string" ? part.textDelta : "";
}

async function preflightPeek(
  peek: ReadableStream<ObjectStreamPart>,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const reader = peek.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return { ok: false, error: new Error("Model returned no output") };
      }
      if (!value) continue;
      if (value.type === "error") {
        return { ok: false, error: value.error ?? new Error("Provider error") };
      }
      if (value.type === "text-delta" && textDeltaFromPart(value)) {
        return { ok: true };
      }
    }
  } catch (e) {
    return { ok: false, error: e };
  } finally {
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
  const [peekBranch, clientBranch] = full.tee();

  const peek = await preflightPeek(peekBranch);
  if (!peek.ok) {
    if (opts.releaseOnFailure) {
      try {
        await opts.releaseOnFailure();
      } catch {
        /* ignore */
      }
    }
    try {
      clientBranch.cancel();
    } catch {
      /* ignore */
    }
    const message =
      peek.error instanceof Error ? peek.error.message : String(peek.error);
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

  const textStream = textStreamFromObjectStream(clientBranch);

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

export function isStreamErrorPayload(
  value: Response | StreamObjectErrorPayload,
): value is StreamObjectErrorPayload {
  return !(value instanceof Response);
}
