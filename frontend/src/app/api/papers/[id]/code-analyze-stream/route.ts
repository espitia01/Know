import { NextResponse } from "next/server";
import { streamObject } from "ai";
import { zodSchema } from "@ai-sdk/provider-utils";

import { getModelFromSlug, maxOutputTokensFor } from "@/lib/server/llm";
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
import { retrievePaperContext } from "@/lib/server/retrieval";
import { contextBudget } from "@/lib/server/promptBudgets";
import { CodeAnalysisSchema, type CodeAnalysis } from "@/lib/server/schemas";
import { buildCodePrompt } from "@/lib/server/prompts/code";
import { providerOptionsForSlug } from "@/lib/server/promptCache";
import { knowSseFromTextBody } from "@/lib/server/streamObjectResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAPER_ID_RE = /^[a-zA-Z0-9_-]+$/;
const CODE_ID_RE = /^(?:code|algorithm)-\d+$/;

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

  const blockId = typeof body.block_id === "string" ? body.block_id : "";
  if (!CODE_ID_RE.test(blockId)) {
    return jsonError(400, "bad_block_id", "Invalid code block id");
  }
  const code = typeof body.code === "string" ? body.code.slice(0, 12000) : "";
  if (!code.trim()) {
    return jsonError(400, "bad_code", "code is required");
  }
  const language = typeof body.language === "string" ? body.language.slice(0, 40) : "text";
  const contextLine =
    typeof body.context_line === "string" ? body.context_line.slice(0, 500) : "";
  const question = typeof body.question === "string" ? body.question.slice(0, 2000) : "";

  let paper: { title: string; raw_text: string };
  let fastModel: string;
  let deepAnalysis = false;
  try {
    const [ctx, prefs] = await Promise.all([
      fetchPaperContext(paperId, user.userId),
      fetchUserPrefs(user.userId),
    ]);
    paper = { title: ctx.title, raw_text: ctx.raw_text };
    deepAnalysis = prefs.deep_analysis;
    fastModel = await resolveStreamModelOverride(user.userId, body, prefs.fast_model);
  } catch (e) {
    if (e instanceof InternalApiError) {
      if (e.status === 404) return jsonError(404, "not_found", e.message);
      return jsonError(502, "internal_unavailable", e.message);
    }
    return jsonError(502, "fetch_failed", "Could not load paper context");
  }

  let usageToken: UsageToken | null = null;
  try {
    const reserve = await reserveUsage({
      userId: user.userId,
      paperId,
      kind: "qa",
      model: fastModel,
    });
    usageToken = reserve.token;
    if (reserve.model) fastModel = reserve.model;
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

  const depth = promptDepthForModel(fastModel);
  const retrieval = await retrievePaperContext({
    userId: user.userId,
    paperIds: [paperId],
    query: question || "algorithm pseudocode implementation",
    maxChars: contextBudget("qa", deepAnalysis),
  });
  const { system, userText } = buildCodePrompt({
    paperContext: paper.raw_text,
    code,
    language,
    contextLine,
    question,
    depth,
    deepAnalysis,
    retrievedContext: retrieval.context || undefined,
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
      model: getModelFromSlug(fastModel),
      schema: zodSchema(CodeAnalysisSchema),
      schemaName: "CodeAnalysis",
      schemaDescription: "Algorithm explanation and implementation for code from a paper.",
      system,
      ...(providerOptionsForSlug(fastModel)
        ? { providerOptions: providerOptionsForSlug(fastModel) }
        : {}),
      maxOutputTokens: maxOutputTokensFor(fastModel, "analysis"),
      messages: [{ role: "user", content: userText }],
      onFinish: async (event) => {
        if (event.error) {
          await releaseOnFailure();
          return;
        }
        const finalObject = event.object as CodeAnalysis | undefined;
        if (!finalObject) return;
        try {
          await upsertCachedAnalysis({
            userId: user.userId,
            paperId,
            key: "code_analyses",
            value: {
              block_id: blockId,
              language,
              question: question || undefined,
              ...finalObject,
              model: fastModel,
              created_at: Date.now(),
            },
          });
        } catch (err) {
          console.error("[code-analyze-stream] persist failed", err);
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

  const textRes = result.toTextStreamResponse({
    headers: {
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Know-Model": fastModel,
    },
  });
  if (!textRes.body) {
    await releaseOnFailure();
    return jsonError(502, "provider_error", "Model returned an empty stream");
  }
  return knowSseFromTextBody(textRes.body, { "X-Know-Model": fastModel });
}
