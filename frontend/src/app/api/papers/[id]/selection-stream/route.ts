/**
 * Migrated selection-stream route (Stage 2 — replaces Python's
 * /api/papers/{id}/selection-stream for authenticated callers).
 *
 * Responsibilities, in order:
 *   1. Validate auth (Clerk) and the request body shape.
 *   2. Pull paper context + reserve usage from Python via /api/internal.
 *   3. Build the prompt for the requested action.
 *   4. streamObject() the SelectionResultSchema using the fast model.
 *   5. On finish: persist the final assembled object into
 *      cached_analysis.selections (best-effort) and release usage if
 *      something blew up mid-stream.
 *
 * Tier-gating is delegated to Python (single source of truth). All
 * 4xx detail bodies follow the structured `{code, message, ...}` shape
 * the frontend already dispatches on.
 *
 * Streaming protocol: AI SDK Data Stream (textStream) — each chunk is
 * a partial-JSON delta that `experimental_useObject` parses into a
 * DeepPartial<SelectionResult> on the client.
 */

import { NextResponse } from "next/server";
import { streamObject } from "ai";

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
import { SelectionResultSchema, type SelectionResult } from "@/lib/server/schemas";
import {
  buildSelectionPrompt,
  type SelectionAction,
} from "@/lib/server/prompts/selection";

export const runtime = "nodejs";
// Streaming responses must not be cached; force fresh execution per call.
export const dynamic = "force-dynamic";

const PAPER_ID_RE = /^[a-zA-Z0-9_-]+$/;
const ALLOWED_ACTIONS: ReadonlySet<SelectionAction> = new Set([
  "explain",
  "derive",
  "followup",
]);

const MAX_SELECTED_CHARS = 4000;
const MAX_QUESTION_CHARS = 2000;

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return NextResponse.json(
    { detail: { code, message, ...extra } },
    { status },
  );
}

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  if (value.length <= max) return value;
  return value.slice(0, max);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: paperId } = await params;
  if (!paperId || !PAPER_ID_RE.test(paperId)) {
    return jsonError(400, "bad_paper_id", "Invalid paper id");
  }

  // 1. Auth.
  let user: { userId: string; tier: string };
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return jsonError(e.status, e.code, e.message);
    return jsonError(401, "unauthorized", "Unauthorized");
  }

  // 2. Body parse.
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_body", "Body must be valid JSON");
  }
  const rawAction = (body.action as string | undefined) ?? "explain";
  // Legacy `question` action collapses into explain on the new path
  // (the Python service did the same; preserved here for compat).
  const normalizedAction =
    rawAction === "question" ? "explain" : (rawAction as SelectionAction);
  if (!ALLOWED_ACTIONS.has(normalizedAction)) {
    return jsonError(
      400,
      "bad_action",
      `Action must be one of: ${[...ALLOWED_ACTIONS].join(", ")}`,
    );
  }
  const selectedText = clip(body.selected_text, MAX_SELECTED_CHARS);
  if (!selectedText) {
    return jsonError(400, "bad_selected_text", "selected_text is required");
  }
  const question = clip(body.question, MAX_QUESTION_CHARS);

  // 3. Fetch paper context.
  let paper: { title: string; raw_text: string };
  try {
    const ctx = await fetchPaperContext(paperId, user.userId);
    paper = { title: ctx.title, raw_text: ctx.raw_text };
  } catch (e) {
    if (e instanceof InternalApiError) {
      // 404 from internal == not owned. Surface as 404 to the caller.
      const status = e.status === 404 ? 404 : 502;
      const code = e.status === 404 ? "paper_not_found" : "internal_unavailable";
      return jsonError(status, code, e.message);
    }
    return jsonError(502, "paper_fetch_failed", "Could not load paper context");
  }

  // 4. Reserve usage. Python is the single source of truth for
  //    tier/model/per-paper caps, so its 403/429s pass through verbatim.
  let usageToken: UsageToken | null = null;
  try {
    const reserve = await reserveUsage({
      userId: user.userId,
      paperId,
      kind: "selection",
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

  // 5. Build prompt + stream.
  const { system, prompt } = buildSelectionPrompt({
    action: normalizedAction,
    selectedText,
    paperTitle: paper.title,
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
      model: getModel("fast"),
      schema: SelectionResultSchema,
      system,
      prompt,
      // Derive responses with 6–12 step bodies plus assumption arrays
      // can run several thousand tokens. Default cap on Haiku is
      // generous, but explicit beats implicit and the Anthropic
      // default has shifted before.
      maxOutputTokens: 8000,
      onFinish: async (event) => {
        // Schema validation failure mid-stream → release usage,
        // but the client already saw the partial — log and move on.
        if (event.error) {
          await releaseOnFailure();
          return;
        }
        const finalObject = event.object as SelectionResult | undefined;
        if (!finalObject) return;

        // Persist the assembled selection into cached_analysis. We
        // await directly (rather than scheduling via `after()`)
        // because `after()` can be cut off on Vercel without Fluid
        // Compute when the function shuts down. Awaiting trades a
        // few hundred ms of tail-latency for guaranteed persistence
        // — the client already has the answer rendered by the time
        // this resolves, so the user doesn't perceive the delay.
        try {
          await upsertCachedAnalysis({
            userId: user.userId,
            paperId,
            key: "selections",
            value: {
              action: finalObject.action,
              selected_text: selectedText,
              question: question || undefined,
              // Keep `explanation` for backwards-compat with the
              // existing SelectionAnalysisResult shape rendered by
              // SelectionResultPanel/QAPanel.
              explanation: finalObject.body,
              assumptions: finalObject.assumptions ?? [],
              starting_point: finalObject.starting_point,
              final_result: finalObject.final_result,
              steps: finalObject.steps ?? [],
            },
          });
        } catch (err) {
          console.error("[selection-stream] persist failed", err);
        }
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
