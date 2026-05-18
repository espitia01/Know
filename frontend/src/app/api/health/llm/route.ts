/**
 * Smoke-test endpoint for the AI SDK plumbing.
 *
 * Hits the configured fast model with a tiny prompt and reports whether
 * Gateway is in front, which slug each role resolves to, and the
 * round-trip latency. Wired so a `curl` against `/api/health/llm` after
 * deploy proves the entire stage 1 plumbing chain is configured —
 * Anthropic key (or Gateway OIDC), model routing, and the SDK itself.
 *
 * Returns 503 on provider errors so deploy health checks can flag a
 * misconfigured key without polluting `2xx` traffic.
 */

import { NextResponse } from "next/server";
import { generateText } from "ai";
import { getModel, modelRouting } from "@/lib/server/llm";

export const runtime = "nodejs";
// Don't cache the smoke test result — every call should actually round-trip.
export const dynamic = "force-dynamic";

export async function GET() {
  const routing = modelRouting();
  const start = Date.now();
  try {
    const { text } = await generateText({
      model: getModel("fast"),
      prompt: "ping",
      system: "Reply with the single word 'pong'.",
      maxOutputTokens: 8,
    });
    const latencyMs = Date.now() - start;
    return NextResponse.json({
      ok: true,
      gateway: routing.gateway,
      roles: routing.roles,
      replyPrefix: text.slice(0, 16),
      latencyMs,
    });
  } catch (e) {
    const latencyMs = Date.now() - start;
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json(
      {
        ok: false,
        gateway: routing.gateway,
        roles: routing.roles,
        latencyMs,
        error: message,
      },
      { status: 503 },
    );
  }
}
