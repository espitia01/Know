/**
 * Migrated summary-stream route (Stage 3 — replaces Python's
 * /api/papers/{id}/summary-stream for authenticated callers).
 *
 * Same shape as the selection-stream route but for the analysis model:
 * pull paper context → reserve usage → streamObject(PaperSummary). On
 * finish, persist the assembled summary into cached_analysis.summary
 * via the internal upsert (replaces the old `event.type === "done"`
 * branch that wrote it from Python).
 */

import { NextResponse } from "next/server";
import { streamObject } from "ai";
import { after } from "next/server";

import { getModel } from "@/lib/server/llm";
import { requireUser, AuthError } from "@/lib/server/auth";
import {
  fetchPaperContext,
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
  try {
    const ctx = await fetchPaperContext(paperId, user.userId);
    paper = { title: ctx.title, raw_text: ctx.raw_text };
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
      // Summary uses the analysis (Sonnet) model — it's the heaviest
      // single LLM call in the product and quality matters more than
      // latency.
      model: getModel("analysis"),
      schema: PaperSummarySchema,
      system,
      prompt,
      onFinish: async (event) => {
        if (event.error) {
          await releaseOnFailure();
          return;
        }
        const finalObject = event.object as PaperSummary | undefined;
        if (!finalObject) return;
        after(
          upsertCachedAnalysis({
            userId: user.userId,
            paperId,
            key: "summary",
            value: finalObject,
          }),
        );
      },
      onError: async () => {
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
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
