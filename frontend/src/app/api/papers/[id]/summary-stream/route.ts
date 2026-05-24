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

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return NextResponse.json({ detail: { code, message, ...extra } }, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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
  let analysisModel: string;
  let deepAnalysis = false;
  try {
    const [ctx, prefs] = await Promise.all([
      fetchPaperContext(paperId, user.userId),
      fetchUserPrefs(user.userId),
    ]);
    paper = {
      title: ctx.title ?? "Untitled paper",
      // Defensive: an empty raw_text would cause the model to produce a
      // schema-invalid object and surface as a 500 from `streamObject`.
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
      const status = e.status === 404 ? 404 : 502;
      const code = e.status === 404 ? "paper_not_found" : "internal_unavailable";
      return jsonError(status, code, e.message);
    }
    return jsonError(502, "paper_fetch_failed", "Could not load paper context");
  }

  let usageToken: UsageToken | null = null;
  try {
    const reserve = await reserveUsage({
      userId: user.userId,
      paperId,
      kind: "summary",
      model: analysisModel,
    });
    usageToken = reserve.token;
  } catch (e) {
    if (e instanceof InternalApiError) {
      const detail = e.detail as { detail?: Record<string, unknown> } | undefined;
      const inner = (detail?.detail ?? {}) as Record<string, unknown>;
      const code = (inner.code as string) || (e.status === 403 ? "tier_locked" : "rate_limited");
      const message = (inner.message as string) || e.message;
      return jsonError(e.status, code, message, { ...inner });
    }
    return jsonError(503, "usage_unavailable", "Usage tracking unavailable");
  }

  const depth = promptDepthForModel(analysisModel);
  const { system, paperContextText, taskText } = buildSummaryDeepPrompt({
    paperTitle: paper.title,
    paperContext: paper.raw_text,
    depth,
    deepAnalysis,
  });

  let releasedOnError = false;
  const releaseOnFailure = async () => {
    if (releasedOnError) return;
    releasedOnError = true;
    if (usageToken) await releaseUsage(usageToken);
  };

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
          console.error("[summary-stream] persist failed", err);
        }
      },
      onError: async ({ error }) => {
        console.error(
          JSON.stringify({
            tag: "summary-stream.error",
            paperId,
            userId: user.userId,
            error: String(error).slice(0, 800),
          }),
        );
        await releaseOnFailure();
      },
    });
  } catch (e) {
    await releaseOnFailure();
    const message = e instanceof Error ? e.message : "Provider error";
    return jsonError(502, "provider_error", message);
  }

  try {
    return result.toTextStreamResponse({
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
        "X-Know-Model": analysisModel,
      },
    });
  } catch (e) {
    await releaseOnFailure();
    const message = e instanceof Error ? e.message : "Stream response error";
    return jsonError(502, "stream_response_error", message);
  }
  } catch (e) {
    console.error(
      JSON.stringify({
        tag: "summary-stream.unhandled",
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack?.slice(0, 800) : undefined,
      }),
    );
    const message = e instanceof Error ? e.message : "Internal server error";
    return jsonError(500, "internal_error", message);
  }
}
