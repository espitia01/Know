/**
 * Typed wrappers around the Vercel Marketplace Redis (Upstash) store.
 *
 * Three concerns we keep here so route code stays terse:
 *   - Ad-hoc cache get/set with explicit TTL semantics.
 *   - Idempotency-key lookup/store for migrated streaming routes.
 *   - Sliding-window rate limiting via @upstash/ratelimit.
 *
 * Treated as best-effort: routes that hit `cacheGet` or `idempotency`
 * helpers must tolerate a `null` return on transport errors. Rate
 * limiting is the one path that fails closed if we can't reach Redis —
 * anonymous trial calls would otherwise be unguarded.
 *
 * The legacy `@vercel/kv` package is deprecated; this module talks to
 * `@upstash/redis` directly. The same env vars work for both
 * (`KV_REST_API_URL` / `KV_REST_API_TOKEN`, or the Upstash-named
 * equivalents).
 */

import "server-only";

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (_redis) return _redis;
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) {
    throw new Error(
      "Redis (KV) not configured: set KV_REST_API_URL and KV_REST_API_TOKEN.",
    );
  }
  _redis = new Redis({ url, token });
  return _redis;
}

// ----------------------------------------------------------------
// Cache
// ----------------------------------------------------------------

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const v = await getRedis().get<T>(key);
    return (v ?? null) as T | null;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().set(key, value, { ex: Math.max(1, Math.floor(ttlSeconds)) });
  } catch {
    /* best-effort */
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    await getRedis().del(key);
  } catch {
    /* best-effort */
  }
}

// ----------------------------------------------------------------
// Idempotency
// ----------------------------------------------------------------

const IDEMP_TTL_SECONDS = 60 * 60; // 1 hour

export const idempotency = {
  key(scope: string, ...parts: (string | number | undefined)[]): string {
    return ["idemp", scope, ...parts.filter(Boolean)].join(":");
  },
  async lookup<T>(key: string): Promise<T | null> {
    return cacheGet<T>(key);
  },
  async store<T>(key: string, value: T): Promise<void> {
    return cacheSet(key, value, IDEMP_TTL_SECONDS);
  },
};

// ----------------------------------------------------------------
// Rate limiting
// ----------------------------------------------------------------

/**
 * Build a sliding-window limiter. Keep limiter instances cached per
 * (limit, windowSec) so we don't allocate on every request.
 */
const limiterCache = new Map<string, Ratelimit>();

function getLimiter(limit: number, windowSec: number): Ratelimit {
  const k = `${limit}:${windowSec}`;
  let l = limiterCache.get(k);
  if (!l) {
    l = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
      prefix: "rl",
      analytics: false,
    });
    limiterCache.set(k, l);
  }
  return l;
}

export const rateLimit = {
  /**
   * Attempt to consume one slot for `key` against `(limit, windowSec)`.
   * Returns `{ allowed, remaining, resetMs }`. On KV transport failure
   * returns `{ allowed: false, … }` — fail closed.
   */
  async tryConsume(
    key: string,
    limit: number,
    windowSec: number,
  ): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
    try {
      const r = await getLimiter(limit, windowSec).limit(key);
      return {
        allowed: r.success,
        remaining: r.remaining,
        resetMs: r.reset,
      };
    } catch {
      return { allowed: false, remaining: 0, resetMs: Date.now() + windowSec * 1000 };
    }
  },
};
