/**
 * KV-backed sliding-window rate limiter for the anonymous trial flow.
 *
 * Replaces the in-memory deque inside Python's `_check_trial_rate`,
 * which had two known bugs: (1) per-process state died on every
 * Railway redeploy, resetting every IP's bucket; (2) the eviction
 * sort key compared the wrong end of the deque. Moving the limiter
 * to Upstash Redis (via @upstash/ratelimit) survives redeploys and
 * scales horizontally across workers.
 *
 * Auth model: the same `INTERNAL_BACKEND_TOKEN` Python uses to call
 * Next.js's other internal endpoints. Browsers never hit this route;
 * the trial flow on Python uses it as a server-to-server check.
 */

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/server/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 5;
const DEFAULT_WINDOW_SECONDS = 60 * 60; // 1 hour

function unauthorized(): Response {
  return NextResponse.json(
    { detail: { code: "unauthorized", message: "Internal bearer required" } },
    { status: 401 },
  );
}

export async function POST(request: Request) {
  const expected = process.env.INTERNAL_BACKEND_TOKEN;
  if (!expected) {
    return NextResponse.json(
      {
        detail: {
          code: "ratecheck_unconfigured",
          message: "INTERNAL_BACKEND_TOKEN not configured",
        },
      },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${expected}`) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { detail: { code: "bad_body", message: "Body must be valid JSON" } },
      { status: 400 },
    );
  }

  const ip = (typeof body.ip === "string" ? body.ip.trim() : "").slice(0, 64);
  if (!ip) {
    return NextResponse.json(
      { detail: { code: "bad_ip", message: "ip is required" } },
      { status: 400 },
    );
  }
  const limit = Number.isFinite(body.max_requests as number)
    ? Math.max(1, Math.min(1000, Number(body.max_requests)))
    : DEFAULT_LIMIT;
  const windowSec = Number.isFinite(body.window_seconds as number)
    ? Math.max(1, Math.min(86400, Number(body.window_seconds)))
    : DEFAULT_WINDOW_SECONDS;

  const result = await rateLimit.tryConsume(`trial:${ip}`, limit, windowSec);
  return NextResponse.json({
    ok: true,
    allowed: result.allowed,
    remaining: result.remaining,
    reset_ms: result.resetMs,
  });
}
