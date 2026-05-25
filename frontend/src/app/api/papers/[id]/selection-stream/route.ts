/**
 * Migrated selection-stream route. Mirrors summary-stream's hardened
 * pre-flight peek so lazy provider failures (Mistral / OpenAI / gateway)
 * surface as typed JSON 502 instead of a Next.js 500.
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
import { SelectionResultSchema, type SelectionResult } from "@/lib/server/schemas";
import {
  buildSelectionPrompt,
  type SelectionAction,
} from "@/lib/server/prompts/selection";
import {
  cachedUserMessages,
  providerOptionsForSlug,
} from "@/lib/server/promptCache";
import {
  buildStreamObjectResponse,
  isStreamErrorPayload,
} from "@/lib/server/streamObjectResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAPER_ID_RE = /^[a-zA-Z0-9_-]+$/;
const ALLOWED_ACTIONS: ReadonlySet<SelectionAction> = new Set([
  "explain",
  "derive",
  "followup",
]);

const MAX_SELECTED_CHARS = 4000;
const MAX_QUESTION_CHARS = 2000;

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
    /* immutable */
  }
  return res;
}

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function sanitizeSelectionText(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\n" || ch === "\t" || ch === "\r") {
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 32) continue;
    out += ch;
  }
  return out.trim();
}

function maxTokensForSelection(action: SelectionAction, model: string): number {
  const base = maxOutputTokensFor(model, "fast");
  if (action === "derive") return base;
  if (action === "followup") return Math.min(base, 1800);
  return Math.min(base, 1400);
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
  let fastModel = defaultSlugFor("fast");
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

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, "bad_body", "Body must be valid JSON");
    }

    const rawAction = (body.action as string | undefined) ?? "explain";
    const normalizedAction =
      rawAction === "question" ? "explain" : (rawAction as SelectionAction);
    if (!ALLOWED_ACTIONS.has(normalizedAction)) {
      return jsonError(
        400,
        "bad_action",
        `Action must be one of: ${[...ALLOWED_ACTIONS].join(", ")}`,
      );
    }

    const selectedText = sanitizeSelectionText(clip(body.selected_text, MAX_SELECTED_CHARS));
    if (!selectedText) {
      return jsonError(400, "bad_selected_text", "selected_text is required");
    }
    const question = clip(body.question, MAX_QUESTION_CHARS);

    let paper: { title: string; raw_text: string };
    let deepAnalysis = false;
    try {
      const [ctx, prefs] = await Promise.all([
        fetchPaperContext(paperId, user.userId),
        fetchUserPrefs(user.userId),
      ]);
      paper = { title: ctx.title, raw_text: ctx.raw_text ?? "" };
      deepAnalysis = prefs.deep_analysis;
      fastModel = await resolveStreamModelOverride(
        user.userId,
        body,
        prefs.fast_model,
      );
      if (!fastModel?.trim()) {
        fastModel = defaultSlugFor("fast");
      }
    } catch (e) {
      if (e instanceof InternalApiError) {
        return internalErrorResponse(
          e,
          e.status === 409 ? "paper_text_unavailable" : "internal_unavailable",
          e.status === 404 ? "Paper not found" : "Could not load paper context",
        );
      }
      return jsonError(502, "paper_fetch_failed", "Could not load paper context");
    }

    try {
      const reserve = await reserveUsage({
        userId: user.userId,
        paperId,
        kind: "selection",
        model: fastModel,
      });
      usageToken = reserve.token;
      if (reserve.model?.trim()) fastModel = reserve.model;
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

    const depth = promptDepthForModel(fastModel);
    const { system, paperContextText, taskText } = buildSelectionPrompt({
      action: normalizedAction,
      selectedText,
      paperTitle: paper.title,
      paperContext: paper.raw_text,
      question,
      depth,
      deepAnalysis,
    });

    let result: ReturnType<typeof streamObject>;
    try {
      result = streamObject({
        model: getModelFromSlug(fastModel),
        schema: zodSchema(SelectionResultSchema),
        schemaName: "SelectionResult",
        schemaDescription:
          "Structured analysis of a selected passage from an academic paper.",
        system,
        messages: cachedUserMessages(fastModel, paperContextText, taskText),
        ...(providerOptionsForSlug(fastModel)
          ? { providerOptions: providerOptionsForSlug(fastModel) }
          : {}),
        temperature: 0.2,
        maxOutputTokens: maxTokensForSelection(normalizedAction, fastModel),
        onFinish: async (event) => {
          try {
            if (event.error) {
              await releaseOnFailure();
              return;
            }
            const finalObject = event.object as SelectionResult | undefined;
            if (!finalObject) {
              await releaseOnFailure();
              return;
            }
            try {
              await upsertCachedAnalysis({
                userId: user.userId,
                paperId,
                key: "selections",
                value: {
                  action: finalObject.action,
                  selected_text: selectedText,
                  question: question || undefined,
                  explanation: finalObject.body,
                  assumptions: finalObject.assumptions ?? [],
                  starting_point: finalObject.starting_point,
                  final_result: finalObject.final_result,
                  steps: finalObject.steps ?? [],
                  model: fastModel,
                },
              });
            } catch (err) {
              console.error(
                JSON.stringify({
                  tag: "selection-stream.persist",
                  paperId,
                  userId: user.userId,
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          } catch (err) {
            console.error(
              JSON.stringify({
                tag: "selection-stream.finish",
                paperId,
                userId: user.userId,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
            await releaseOnFailure();
          }
        },
        onError: async ({ error }) => {
          try {
            console.error(
              JSON.stringify({
                tag: "selection-stream.error",
                paperId,
                userId: user.userId,
                action: normalizedAction,
                model: fastModel,
                error: String(error).slice(0, 800),
              }),
            );
            await releaseOnFailure();
          } catch {
            /* swallow */
          }
        },
      });
    } catch (e) {
      await releaseOnFailure();
      const message = e instanceof Error ? e.message : "Provider error";
      return jsonError(502, "provider_error", message, { model: fastModel });
    }

    const response = await buildStreamObjectResponse<SelectionResult>(result, {
      model: fastModel,
      releaseOnFailure,
      logTag: "selection-stream",
      logContext: { paperId, userId: user.userId, action: normalizedAction },
    });
    if (isStreamErrorPayload(response)) {
      return jsonError(
        response.status,
        response.body.detail.code,
        response.body.detail.message,
        { model: response.body.detail.model },
      );
    }
    return response;
  } catch (e) {
    await releaseOnFailure();
    console.error(
      JSON.stringify({
        tag: "selection-stream.unhandled",
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack?.slice(0, 800) : undefined,
        model: fastModel,
      }),
    );
    const message = e instanceof Error ? e.message : "Internal server error";
    return jsonError(502, "internal_error", message, { model: fastModel });
  }
}
