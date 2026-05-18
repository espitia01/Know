/**
 * Server-side auth helpers for migrated route handlers.
 *
 * Wraps Clerk's `auth()` to also resolve the user's tier from Supabase
 * (cached briefly in KV). Routes use `requireUser()` to get a single
 * `{ userId, tier }` object — no separate Supabase round-trip per call.
 *
 * Tier is read-only here; writes still go through Stripe webhooks and
 * the existing Python `/api/user/me` reconciliation. We're just reading
 * the row to know which `gating.py` cap applies.
 */

import "server-only";

import { auth } from "@clerk/nextjs/server";
import { cacheGet, cacheSet } from "./kv";
import { getAdminSupabase } from "./supabase";

const TIER_CACHE_TTL_SECONDS = 30;

export type AuthUser = { userId: string; tier: string };

async function readTier(userId: string): Promise<string> {
  const cacheKey = `user:tier:${userId}`;
  const cached = await cacheGet<string>(cacheKey);
  if (cached) return cached;
  try {
    const supabase = getAdminSupabase();
    const { data } = await supabase
      .from("users")
      .select("tier")
      .eq("user_id", userId)
      .maybeSingle();
    const tier = (data?.tier as string | undefined) || "free";
    await cacheSet(cacheKey, tier, TIER_CACHE_TTL_SECONDS);
    return tier;
  } catch {
    // Fail-soft: pretend free. The Python `/api/internal/usage/reserve`
    // call is the actual enforcement gate, and that re-reads the user
    // row authoritatively. Returning "free" here just means the Next.js
    // route may format an upgrade prompt slightly differently.
    return "free";
  }
}

export async function requireUser(): Promise<AuthUser> {
  const session = await auth();
  const userId = session.userId;
  if (!userId) {
    throw new AuthError(401, "Unauthorized");
  }
  const tier = await readTier(userId);
  return { userId, tier };
}

export class AuthError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "unauthorized") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Tier gating mirror — kept *display-only*. Real enforcement remains in
 * the Python `gating.py` via `/api/internal/usage/reserve`. This helper
 * lets routes early-reject obvious mismatches (e.g. free trying to use
 * cross-paper QA) without a network hop, but if it returns true the
 * route still must reserve usage before doing real work.
 */
const FEATURE_TIER_FLOOR: Record<string, string[]> = {
  summary: ["free", "scholar", "researcher"],
  qa: ["free", "scholar", "researcher"],
  selection: ["free", "scholar", "researcher"],
  prepare: ["scholar", "researcher"],
  assumptions: ["scholar", "researcher"],
  figures: ["scholar", "researcher"],
  notes: ["scholar", "researcher"],
  bibtex: ["scholar", "researcher"],
  "multi-qa": ["researcher"],
};

export function userHasFeatureFloor(user: AuthUser, feature: string): boolean {
  const allowed = FEATURE_TIER_FLOOR[feature];
  if (!allowed) return true;
  return allowed.includes(user.tier);
}
