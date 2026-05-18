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

import { getModelFromSlug } from "@/lib/server/llm";
import { requireUser, AuthError } from "@/lib/server/auth";
import {
  fetchPaperContext,
  fetchUserModelPrefs,
  reserveUsage,
  releaseUsage,
  upsertCachedAnalysis,
  InternalApiError,
  type UsageToken,
} from "@/lib/server/internalApi";
import { PaperSummarySchema, type PaperSummary } from "@/lib/server/schemas";
import { buildSummaryPrompt } from "@/lib/server/prompts/summary";

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
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  let paper: { title: string; raw_text: string };
  let analysisModel: string;
  try {
    const [ctx, prefs] = await Promise.all([
      fetchPaperContext(paperId, user.userId),
      fetchUserModelPrefs(user.userId),
    ]);
    paper = { title: ctx.title, raw_text: ctx.raw_text };
    analysisModel = prefs.analysis_model;
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

  const { system, prompt } = buildSummaryPrompt({
    paperTitle: paper.title,
    paperContext: paper.raw_text,
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
      schema: zodSchema(PaperSummarySchema),
      schemaName: "PaperSummary",
      schemaDescription: "Structured summary of an academic paper.",
      system,
      prompt,
      temperature: 0.3,
      maxOutputTokens: 6000,
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
        const raw = event.object as PaperSummary | undefined;
        const parsed = PaperSummarySchema.safeParse(raw);
        const finalObject = parsed.success ? parsed.data : raw;
        const overview =
          typeof finalObject?.overview === "string" ? finalObject.overview.trim() : "";
        if (!overview) {
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
            key: "summary",
            value: { ...finalObject, overview } as PaperSummary,
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

  return result.toTextStreamResponse({
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
