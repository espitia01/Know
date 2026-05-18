/**
 * Diagnostic-only endpoint that runs a minimal streamObject call
 * against each role (fast / analysis / vision) with a tiny schema
 * and reports what each model returned. Lets a maintainer test the
 * AI SDK + Anthropic structured-output path without the full
 * summary stream, paper context, or Clerk session in the loop.
 *
 * Auth: same INTERNAL_BACKEND_TOKEN bearer the other internal
 * health endpoints use. Returns booleans + clipped error strings —
 * never raw model output beyond a small preview.
 */

import { NextResponse } from "next/server";
import { streamObject } from "ai";
import { zodSchema } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { getModel, type ModelRole } from "@/lib/server/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TinySchema = z.object({
  greeting: z.string().describe("A short greeting like 'hello'."),
  fact: z.string().describe("A one-sentence neutral fact."),
});

async function probe(role: ModelRole) {
  const start = Date.now();
  let hasObject = false;
  let hasError = false;
  let errorMessage: string | undefined;
  let preview: string | undefined;
  try {
    const result = streamObject({
      model: getModel(role),
      schema: zodSchema(TinySchema),
      schemaName: "TinyProbe",
      maxOutputTokens: 200,
      system:
        "You produce a tiny test response. Fill `greeting` with 'hello' and `fact` with one neutral sentence about water.",
      prompt: "Return the structured object.",
    });
    // Drain the partial-object stream so onFinish fires.
    for await (const _ of result.partialObjectStream) {
      void _;
    }
    const final = await result.object.catch(() => undefined);
    if (final && typeof final === "object") {
      hasObject = true;
      preview = JSON.stringify(final).slice(0, 200);
    }
  } catch (e) {
    hasError = true;
    errorMessage = String(e).slice(0, 800);
  }
  return {
    role,
    durationMs: Date.now() - start,
    hasObject,
    hasError,
    errorMessage,
    preview,
  };
}

function unauthorized(): Response {
  return NextResponse.json(
    { detail: { code: "unauthorized", message: "Bearer required" } },
    { status: 401 },
  );
}

export async function GET(request: Request) {
  const expected = process.env.INTERNAL_BACKEND_TOKEN || "";
  if (!expected) {
    return NextResponse.json(
      {
        detail: {
          code: "unconfigured",
          message: "INTERNAL_BACKEND_TOKEN not configured",
        },
      },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${expected}`) return unauthorized();

  const url = new URL(request.url);
  const requestedRole = url.searchParams.get("role") as ModelRole | null;
  const roles: ModelRole[] =
    requestedRole && ["fast", "analysis", "vision"].includes(requestedRole)
      ? [requestedRole]
      : ["fast", "analysis"];

  const results = [];
  for (const role of roles) {
    results.push(await probe(role));
  }
  return NextResponse.json({ ok: true, results });
}
