/**
 * Daily Vercel Cron callback that retires trial papers older than two
 * hours. Replaces the in-process asyncio loop that lived inside the
 * Python FastAPI app — that loop tied cleanup to whichever Railway
 * worker happened to be alive, so a deploy / scale event during the
 * sleep window dropped it on the floor. A real scheduled job is more
 * reliable.
 *
 * Auth model:
 *   - Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` with
 *     every scheduled request. We verify this header so a leaked
 *     route URL can't be invoked by a public caller.
 *   - The actual cleanup logic lives in Python under
 *     `/api/internal/admin/cleanup-trial`, called via the existing
 *     `INTERNAL_BACKEND_TOKEN` HMAC.
 */

import { NextResponse } from "next/server";
import { adminCleanupTrial, InternalApiError } from "@/lib/server/internalApi";

export const runtime = "nodejs";
// Cron callbacks must always execute fresh; never serve a cached
// response from an earlier run.
export const dynamic = "force-dynamic";

function unauthorized(): Response {
  return NextResponse.json(
    { detail: { code: "unauthorized", message: "Cron secret required" } },
    { status: 401 },
  );
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        detail: {
          code: "cron_unconfigured",
          message: "CRON_SECRET not configured",
        },
      },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization") || "";
  const expected = `Bearer ${secret}`;
  if (auth !== expected) return unauthorized();

  try {
    const result = await adminCleanupTrial(2);
    // `result.ok` is the inner Python "did the call succeed" flag;
    // we surface our own `ok: true` after we've assembled the
    // Vercel-side response, so spread first then override.
    return NextResponse.json({ ...result, ok: true });
  } catch (e) {
    if (e instanceof InternalApiError) {
      return NextResponse.json(
        {
          ok: false,
          status: e.status,
          code: e.code,
          message: e.message,
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        message: e instanceof Error ? e.message : "Cleanup failed",
      },
      { status: 502 },
    );
  }
}
