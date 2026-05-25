/**
 * Migrated summary-stream route — replaces Python's
 * /api/papers/{id}/summary-stream for authenticated callers.
 *
 * Streams via `toTextStreamResponse` (same path as figure-qa-stream).
 * Preflight tee was removed: racing `reader.read()` left pending reads
 * that crashed the route with a generic Next.js 500 HTML page.
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
import { streamResponseHeaders } from "@/lib/server/streamObjectResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Vercel kills at 60s without this; summary can run 90–120s on long papers. */
export const maxDuration = 300;

const PAPER_ID_RE = /^[a-zA-Z0-9_-]+$/;

const DEPLOY_SHA =
  (process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || "dev").slice(0, 12);

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  const res = NextResponse.json(
    { detail: { code, message, deploy: DEPLOY_SHA, ...extra } },
    { status },
  );
  try {
    res.headers.set("X-Know-Deploy", DEPLOY_SHA);
  } catch {
    /* immutable headers — best-effort */
  }
  return res;
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

    let providerFailed: unknown = null;
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
        onFinish: (event) => {
          void (async () => {
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
          })();
        },
        onError: ({ error }) => {
          providerFailed = error;
          void (async () => {
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
          })();
        },
      });
    } catch (e) {
      await releaseOnFailure();
      const message = e instanceof Error ? e.message : "Provider error";
      return jsonError(502, "provider_error", message, { model: analysisModel });
    }

    // Yield once so synchronous provider rejections hit onError first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (providerFailed) {
      const message =
        providerFailed instanceof Error
          ? providerFailed.message
          : String(providerFailed);
      return jsonError(502, "provider_error", message, { model: analysisModel });
    }

    return result.toTextStreamResponse({
      headers: streamResponseHeaders(analysisModel),
    });
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
