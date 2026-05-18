/**
 * Migrated figure-qa-stream route (Stage 3).
 *
 * Pulls the figure PNG bytes from Python's internal endpoint, embeds
 * them as a vision content part, and streams a structured FigureAnalysis
 * via the vision model. Persists the final assembled object into
 * cached_analysis.figure_analyses so the conversation history survives
 * page reloads.
 */

import { NextResponse } from "next/server";
import { streamObject } from "ai";
import { after } from "next/server";

import { getModel } from "@/lib/server/llm";
import { requireUser, AuthError } from "@/lib/server/auth";
import {
  fetchFigurePng,
  fetchPaperContext,
  reserveUsage,
  releaseUsage,
  upsertCachedAnalysis,
  InternalApiError,
  type UsageToken,
} from "@/lib/server/internalApi";
import { FigureAnalysisSchema, type FigureAnalysis } from "@/lib/server/schemas";
import { buildFigurePrompt } from "@/lib/server/prompts/figure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[a-zA-Z0-9_-]+$/;

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
  const { id: paperId } = await params;
  if (!paperId || !ID_RE.test(paperId)) {
    return jsonError(400, "bad_paper_id", "Invalid paper id");
  }

  let user: { userId: string; tier: string };
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return jsonError(e.status, e.code, e.message);
    return jsonError(401, "unauthorized", "Unauthorized");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_body", "Body must be valid JSON");
  }
  const figureId = typeof body.figure_id === "string" ? body.figure_id : "";
  if (!ID_RE.test(figureId)) {
    return jsonError(400, "bad_figure_id", "Invalid figure id");
  }
  const question = typeof body.question === "string" ? body.question.slice(0, 2000) : "";

  // Pull paper context (for grounding the prompt) and the figure PNG
  // in parallel — they're independent and both are blocking.
  let paper: { title: string; raw_text: string };
  let figure: { bytes: Uint8Array; mediaType: string };
  try {
    const [ctx, png] = await Promise.all([
      fetchPaperContext(paperId, user.userId),
      fetchFigurePng(paperId, figureId, user.userId),
    ]);
    paper = { title: ctx.title, raw_text: ctx.raw_text };
    figure = png;
  } catch (e) {
    if (e instanceof InternalApiError) {
      if (e.status === 404) return jsonError(404, "not_found", e.message);
      return jsonError(502, "internal_unavailable", e.message);
    }
    return jsonError(502, "fetch_failed", "Could not load figure or paper context");
  }

  let usageToken: UsageToken | null = null;
  try {
    const reserve = await reserveUsage({
      userId: user.userId,
      paperId,
      kind: "figure",
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

  const { system, userText } = buildFigurePrompt({
    paperContext: paper.raw_text,
    question,
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
      model: getModel("vision"),
      schema: FigureAnalysisSchema,
      system,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", image: figure.bytes, mediaType: figure.mediaType },
            { type: "text", text: userText },
          ],
        },
      ],
      onFinish: async (event) => {
        if (event.error) {
          await releaseOnFailure();
          return;
        }
        const finalObject = event.object as FigureAnalysis | undefined;
        if (!finalObject) return;
        after(
          upsertCachedAnalysis({
            userId: user.userId,
            paperId,
            key: "figure_analyses",
            value: {
              figure_id: figureId,
              question: question || undefined,
              ...finalObject,
            },
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
