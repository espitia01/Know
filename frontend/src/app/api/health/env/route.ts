/**
 * Diagnostic-only endpoint: reports presence (NOT values) of the env
 * vars the migrated routes need. Read by `curl` from a maintainer's
 * laptop to debug "the route says X is not configured even though
 * Vercel shows it's set".
 *
 * Returns booleans — never the actual values — so leaking this URL
 * doesn't leak secrets. Auth: same `INTERNAL_BACKEND_TOKEN` bearer
 * the rest of the internal routes use, so a casual prober gets a
 * 401 instead of fingerprinting the deployment.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPECTED_KEYS = [
  "ANTHROPIC_API_KEY",
  "AI_GATEWAY_API_KEY",
  "OPENAI_API_KEY",
  "MISTRAL_API_KEY",
  "INTERNAL_BACKEND_URL",
  "INTERNAL_BACKEND_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "CLERK_SECRET_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CRON_SECRET",
  "VERCEL_OIDC_TOKEN",
  "MODEL_ANALYSIS",
  "MODEL_FAST",
  "MODEL_VISION",
] as const;

export async function GET(request: Request) {
  // Gate behind the same internal bearer so this can't be probed by a
  // random caller. Also check a `?key=` query string for convenience
  // when curling from a laptop.
  const expected = process.env.INTERNAL_BACKEND_TOKEN || "";
  const auth = request.headers.get("authorization") || "";
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key") || "";

  if (!expected) {
    return NextResponse.json(
      {
        // Special-case so this endpoint is *useful* when the bearer
        // itself is the missing var. Reports the env-var presence
        // table without auth in that one case, and only that case.
        warning: "INTERNAL_BACKEND_TOKEN itself is missing — bypassing auth so this is diagnose-able",
        runtime: process.env.VERCEL_REGION || "unknown",
        env: Object.fromEntries(
          EXPECTED_KEYS.map((k) => [k, Boolean(process.env[k])]),
        ),
      },
      { status: 200 },
    );
  }

  const presented =
    auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : queryKey;
  if (presented !== expected) {
    return NextResponse.json(
      { detail: { code: "unauthorized", message: "Bearer required" } },
      { status: 401 },
    );
  }

  return NextResponse.json({
    runtime: process.env.VERCEL_REGION || "unknown",
    env: Object.fromEntries(
      EXPECTED_KEYS.map((k) => [k, Boolean(process.env[k])]),
    ),
  });
}
