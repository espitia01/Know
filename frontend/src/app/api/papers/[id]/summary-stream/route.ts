/**
 * Migrated summary-stream route (Stage 3 — replaces Python's
 * /api/papers/{id}/summary-stream for authenticated callers).
 *
 * Uses the user's Settings analysis model (via internal model prefs):
 * pull paper context → reserve usage → streamObject(PaperSummary). On
 * finish, persist the assembled summary into cached_analysis.summary
 * via the internal upsert (replaces the old `event.type === "done"`
 * branch that wrote it from Python).
 */

import { NextResponse } from "next/server";
import { streamObject } from "ai";
import { zodSchema } from "@ai-sdk/provider-utils";

import { getModelFromSlug, maxOutputTokensFor, defaultSlugFor } from "@/lib/server/llm";
import { promptDepthForModel } from "@/lib/modelLabels";
import { requireUser, AuthError } from "@/lib/server/auth";
import {
  fetchPaperContext,
  resolveStreamModelOverride,
  reserveUsage,
  releaseUsage,
  upsertCachedAnalysis,
  InternalApiError,
  type UsageToken,
} from "@/lib/server/internalApi";
import { fetchUserPrefs } from "@/lib/server/userPrefs";
import {
  PaperSummaryDeepSchema,
  type PaperSummaryDeep,
} from "@/lib/server/schemas";
import { buildSummaryDeepPrompt } from "@/lib/server/prompts/summary";
import {
  cachedUserMessages,
  providerOptionsForSlug,
} from "@/lib/server/promptCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Vercel kills at 60s without this; summary can run 90–120s on long papers. */
export const maxDuration = 300;

const PAPER_ID_RE = /^[a-zA-Z0-9_-]+$/;

const DEPLOY_SHA =
  (process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || "dev").slice(0, 12);

function withDeployHeader(res: Response): Response {
  try {
    res.headers.set("X-Know-Deploy", DEPLOY_SHA);
  } catch {
    /* immutable headers — best-effort */
  }
  return res;
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return withDeployHeader(
    NextResponse.json({ detail: { code, message, deploy: DEPLOY_SHA, ...extra } }, { status }),
  );
}

function parseInternalDetail(detail: unknown): Record<string, unknown> {
  if (detail && typeof detail === "object") {
    const outer = detail as Record<string, unknown>;
    if (outer.detail && typeof outer.detail === "object") {
      return outer.detail as Record<string, unknown>;
    }
    return outer;
  }
  if (typeof detail === "string" && detail.trim()) {
    return { message: detail };
  }
  return {};
}

function mapInternalStatus(status: number): number {
  if (status === 404 || status === 409) return status;
  if (status === 403 || status === 429) return status;
  if (status >= 500) return 502;
  if (status >= 400) return status;
  return 502;
}

function internalErrorResponse(
  e: InternalApiError,
  fallbackCode: string,
  fallbackMessage: string,
): Response {
  const inner = parseInternalDetail(e.detail);
  const code = (inner.code as string) || fallbackCode;
  const message = (inner.message as string) || e.message || fallbackMessage;
  const status = mapInternalStatus(e.status);
  return jsonError(status, code, message, { ...inner, upstream_status: e.status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let usageToken: UsageToken | null = null;
  let analysisModel = defaultSlugFor("analysis");
  let releasedOnError = false;

  const releaseOnFailure = async () => {
    if (releasedOnError) return;
    releasedOnError = true;
    try {
      if (usageToken) await releaseUsage(usageToken);
    } catch {
      /* best-effort */
    }
  };

  try {
    const { id: paperId } = await params;
    if (!paperId || !PAPER_ID_RE.test(paperId)) {
      return jsonError(400, "bad_paper_id", "Invalid paper id");
    }

    let user: { userId: string; tier: string };
    try {
      user = await requireUser();
    } catch (e) {
      if (e instanceof AuthError) return jsonError(e.status, e.code, e.message);
      return jsonError(401, "unauthorized", "Unauthorized");
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    let paper: { title: string; raw_text: string };
    let deepAnalysis = false;
    try {
      const [ctx, prefs] = await Promise.all([
        fetchPaperContext(paperId, user.userId),
        fetchUserPrefs(user.userId),
      ]);
      paper = {
        title: ctx.title ?? "Untitled paper",
        raw_text: ctx.raw_text ?? "",
      };
      if (!paper.raw_text.trim()) {
        return jsonError(
          409,
          "paper_text_unavailable",
          "Paper text is not ready yet. Try again in a few seconds once parsing finishes.",
        );
      }
      deepAnalysis = prefs.deep_analysis;
      analysisModel = await resolveStreamModelOverride(
        user.userId,
        body,
        prefs.analysis_model,
      );
      if (!analysisModel?.trim()) {
        analysisModel = defaultSlugFor("analysis");
      }
    } catch (e) {
      if (e instanceof InternalApiError) {
        return internalErrorResponse(
          e,
          e.status === 409 ? "paper_text_unavailable" : "internal_unavailable",
          e.status === 404
            ? "Paper not found"
            : "Could not load paper context",
        );
      }
      return jsonError(502, "paper_fetch_failed", "Could not load paper context");
    }

    try {
      const reserve = await reserveUsage({
        userId: user.userId,
        paperId,
        kind: "summary",
        model: analysisModel,
      });
      usageToken = reserve.token;
      if (reserve.model?.trim()) {
        analysisModel = reserve.model;
      }
    } catch (e) {
      if (e instanceof InternalApiError) {
        return internalErrorResponse(
          e,
          e.status === 403 ? "tier_locked" : "usage_unavailable",
          "Usage tracking unavailable",
        );
      }
      return jsonError(503, "usage_unavailable", "Usage tracking unavailable");
    }

    let system: string;
    let paperContextText: string;
    let taskText: string;
    try {
      const depth = promptDepthForModel(analysisModel);
      ({ system, paperContextText, taskText } = buildSummaryDeepPrompt({
        paperTitle: paper.title,
        paperContext: paper.raw_text,
        depth,
        deepAnalysis,
      }));
    } catch (e) {
      await releaseOnFailure();
      const message = e instanceof Error ? e.message : "Prompt build failed";
      return jsonError(502, "prompt_build_failed", message, { model: analysisModel });
    }

    let result: ReturnType<typeof streamObject>;
    try {
      result = streamObject({
        model: getModelFromSlug(analysisModel),
        schema: zodSchema(PaperSummaryDeepSchema),
        schemaName: "PaperSummaryDeep",
        schemaDescription:
          "Comprehensive structured summary of an academic paper, including overview, key contributions, methodology, results, discussion, limitations, future work, key equations (with per-variable glossary), and key figures/tables.",
        system,
        messages: cachedUserMessages(analysisModel, paperContextText, taskText),
        ...(providerOptionsForSlug(analysisModel)
          ? { providerOptions: providerOptionsForSlug(analysisModel) }
          : {}),
        temperature: 0.3,
        maxOutputTokens: maxOutputTokensFor(analysisModel, "analysis"),
        onFinish: async (event) => {
          try {
            if (event.error) {
              console.error(
                JSON.stringify({
                  tag: "summary-stream.finish",
                  paperId,
                  userId: user.userId,
                  hasObject: false,
                  hasError: true,
                  errorMessage: String(event.error).slice(0, 500),
                }),
              );
              await releaseOnFailure();
              return;
            }
            const raw = event.object as PaperSummaryDeep | undefined;
            const parsed = PaperSummaryDeepSchema.safeParse(raw);
            const finalObject = parsed.success ? parsed.data : raw;
            const methodology =
              typeof finalObject?.methodology === "string"
                ? finalObject.methodology.trim()
                : "";
            if (!methodology) {
              await releaseOnFailure();
              return;
            }
            console.log(
              JSON.stringify({
                tag: "summary-stream.finish",
                paperId,
                userId: user.userId,
                hasObject: true,
                hasError: false,
                usage: event.usage,
              }),
            );
            try {
              await upsertCachedAnalysis({
                userId: user.userId,
                paperId,
                key: "summary_deep",
                value: { ...finalObject, model: analysisModel } as PaperSummaryDeep,
              });
            } catch (err) {
              console.error(
                JSON.stringify({
                  tag: "summary-stream.persist",
                  paperId,
                  userId: user.userId,
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          } catch (err) {
            console.error(
              JSON.stringify({
                tag: "summary-stream.finish",
                paperId,
                userId: user.userId,
                hasObject: false,
                hasError: true,
                errorMessage: err instanceof Error ? err.message : String(err),
              }),
            );
            await releaseOnFailure();
          }
        },
        onError: async ({ error }) => {
          try {
            console.error(
              JSON.stringify({
                tag: "summary-stream.error",
                paperId,
                userId: user.userId,
                model: analysisModel,
                error: String(error).slice(0, 800),
              }),
            );
            await releaseOnFailure();
          } catch (err) {
            console.error(
              JSON.stringify({
                tag: "summary-stream.error",
                paperId,
                userId: user.userId,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        },
      });
    } catch (e) {
      await releaseOnFailure();
      const message = e instanceof Error ? e.message : "Provider error";
      return jsonError(502, "provider_error", message, { model: analysisModel });
    }

    // Pre-flight using the full event stream. Read events until either a
    // text-delta arrives (model is producing output — safe to start the
    // streaming Response) or an error event fires (return typed JSON 502
    // BEFORE we hand any Response to Next.js, which would otherwise turn
    // the lazy error into a generic 500). Buffered text-deltas seen during
    // the peek are re-emitted at the start of the streaming body so the
    // client's useObject sees the same byte sequence AI SDK's own
    // `toTextStreamResponse` would have produced.
    type ObjectStreamPart =
      | { type: "text-delta"; textDelta: string }
      | { type: "object"; object: Partial<PaperSummaryDeep> }
      | { type: "finish"; [key: string]: unknown }
      | { type: "error"; error: unknown };

    const fullReader = (
      result.fullStream as ReadableStream<ObjectStreamPart>
    ).getReader();
    const bufferedDeltas: string[] = [];
    let preflightError: unknown = null;
    let sawTextDelta = false;
    const PEEK_TIMEOUT_MS = 25_000;
    const deadline = Date.now() + PEEK_TIMEOUT_MS;

    try {
      while (!sawTextDelta && preflightError === null) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const peeked = await Promise.race([
          fullReader.read(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), remaining),
          ),
        ]);
        if (peeked.done) break;
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
        // 'object' / 'finish' events carry no bytes for the text stream;
        // skip and keep peeking.
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
      await releaseOnFailure();
      const message =
        preflightError instanceof Error
          ? preflightError.message
          : String(preflightError);
      console.error(
        JSON.stringify({
          tag: "summary-stream.preflight",
          paperId,
          userId: user.userId,
          model: analysisModel,
          error: message.slice(0, 800),
        }),
      );
      return jsonError(502, "provider_error", message, { model: analysisModel });
    }

    const encoder = new TextEncoder();
    const passthrough = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (const delta of bufferedDeltas) {
            if (delta) controller.enqueue(encoder.encode(delta));
          }
          while (true) {
            const { done, value } = await fullReader.read();
            if (done) break;
            if (!value) continue;
            if (value.type === "text-delta") {
              if (value.textDelta) {
                controller.enqueue(encoder.encode(value.textDelta));
              }
            } else if (value.type === "error") {
              // onError on streamObject already logged + released.
              break;
            }
            // 'object' / 'finish' events: no bytes for text stream.
          }
          try {
            fullReader.releaseLock();
          } catch {
            /* already released */
          }
          controller.close();
        } catch (err) {
          console.error(
            JSON.stringify({
              tag: "summary-stream.passthrough",
              paperId,
              userId: user.userId,
              model: analysisModel,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });

    return withDeployHeader(
      new Response(passthrough, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
          "X-Know-Model": analysisModel,
          "X-Know-Deploy": DEPLOY_SHA,
        },
      }),
    );
  } catch (e) {
    await releaseOnFailure();
    console.error(
      JSON.stringify({
        tag: "summary-stream.unhandled",
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack?.slice(0, 800) : undefined,
        model: analysisModel,
      }),
    );
    const message = e instanceof Error ? e.message : "Internal server error";
    return jsonError(502, "internal_error", message, { model: analysisModel });
  }
}
