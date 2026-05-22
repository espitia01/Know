/**
 * Cached user preferences from Python internal API (60s TTL).
 */

import "server-only";

import { InternalApiError } from "@/lib/server/internalApi";

export type UserPrefs = {
  analysis_model: string;
  fast_model: string;
  tier: string;
  deep_analysis: boolean;
  usage_multiplier: number;
};

type CacheEntry = { at: number; prefs: UserPrefs };

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

const BASE = () => process.env.INTERNAL_BACKEND_URL || "";
const TOKEN = () => process.env.INTERNAL_BACKEND_TOKEN || "";

export async function fetchUserPrefs(userId: string): Promise<UserPrefs> {
  const hit = cache.get(userId);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) {
    return hit.prefs;
  }

  const base = BASE();
  const token = TOKEN();
  if (!base || !token) {
    throw new InternalApiError(
      503,
      "Internal backend not configured",
      "internal_unconfigured",
    );
  }

  const res = await fetch(`${base}/api/internal/user/${userId}/preferences`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    if (hit) return hit.prefs;
    throw new InternalApiError(res.status, `Internal backend ${res.status}`);
  }
  const prefs = (await res.json()) as UserPrefs;
  cache.set(userId, { at: now, prefs });
  return prefs;
}

export function invalidateUserPrefs(userId: string): void {
  cache.delete(userId);
}
