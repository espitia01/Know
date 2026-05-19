/**
 * Typed client for the Python backend's `/api/internal/*` server-to-server
 * router. Migrated streaming routes use this for paper context, usage
 * reservation, figure bytes, and cached-analysis upserts.
 *
 * Auth is a shared bearer (`INTERNAL_BACKEND_TOKEN`) — never the user's
 * Clerk token. The Next.js route is responsible for having already
 * authenticated the user via `requireUser()` and passes the resolved
 * `userId` to these helpers.
 */

import "server-only";

const BASE = process.env.INTERNAL_BACKEND_URL || "";
const TOKEN = process.env.INTERNAL_BACKEND_TOKEN || "";

function assertConfigured(): void {
  if (!BASE || !TOKEN) {
    throw new InternalApiError(
      503,
      "Internal backend not configured (set INTERNAL_BACKEND_URL and INTERNAL_BACKEND_TOKEN)",
      "internal_unconfigured",
    );
  }
}

export class InternalApiError extends Error {
  status: number;
  code: string;
  detail?: unknown;
  constructor(status: number, message: string, code = "internal_error", detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function call<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  assertConfigured();
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, signal, cache: "no-store" });
  } catch (e) {
    throw new InternalApiError(
      503,
      `Internal backend unreachable: ${e instanceof Error ? e.message : "unknown"}`,
      "internal_unreachable",
    );
  }
  if (!res.ok) {
    let detail: unknown = undefined;
    try {
      detail = await res.json();
    } catch {
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
    }
    throw new InternalApiError(
      res.status,
      `Internal backend ${res.status}`,
      "internal_status",
      detail,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ----------------------------------------------------------------
// Paper context
// ----------------------------------------------------------------

export type PaperContext = {
  id: string;
  title: string;
  authors: string[];
  raw_text: string;
  has_si: boolean;
};

export async function fetchPaperContext(
  paperId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<PaperContext> {
  const qs = new URLSearchParams({ user_id: userId }).toString();
  return call<PaperContext>(`/api/internal/paper/${paperId}/text?${qs}`, { method: "GET" }, signal);
}

export type UserModelPrefs = {
  analysis_model: string;
  fast_model: string;
};

/** Tier-enforced analysis/fast slugs from Settings (Python source of truth). */
export async function fetchUserModelPrefs(
  userId: string,
  signal?: AbortSignal,
): Promise<UserModelPrefs> {
  return call<UserModelPrefs>(`/api/internal/user/${userId}/models`, { method: "GET" }, signal);
}

/** Tier allow-list for per-request model overrides on stream routes. */
export async function fetchAllowedModels(
  userId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await call<{ allowed: string[] }>(
    `/api/internal/user/${userId}/allowed-models`,
    { method: "GET" },
    signal,
  );
  return res.allowed ?? [];
}

/**
 * Single-shot stream override: validate `body.model` against the tier
 * allow-list; never persist to /api/settings.
 */
export async function resolveStreamModelOverride(
  userId: string,
  body: Record<string, unknown>,
  defaultModel: string,
  signal?: AbortSignal,
): Promise<string> {
  const wanted = typeof body.model === "string" ? body.model.trim() : "";
  if (!wanted) return defaultModel;
  const allowed = await fetchAllowedModels(userId, signal);
  return allowed.includes(wanted) ? wanted : defaultModel;
}

// ----------------------------------------------------------------
// Usage reservation
// ----------------------------------------------------------------

export type UsageKind = "qa" | "selection" | "summary" | "figure";

export type UsageToken = {
  user_id: string;
  paper_id: string;
  action: string;
  model: string | null;
  count: number;
  record_daily: boolean;
  today: string;
};

export type ReserveUsageResponse = {
  token: UsageToken;
  model: string | null;
};

export async function reserveUsage(args: {
  userId: string;
  paperId: string;
  kind: UsageKind;
  model?: string;
  count?: number;
  recordDaily?: boolean;
}): Promise<ReserveUsageResponse> {
  return call<ReserveUsageResponse>(`/api/internal/usage/reserve`, {
    method: "POST",
    body: JSON.stringify({
      user_id: args.userId,
      paper_id: args.paperId,
      kind: args.kind,
      model: args.model,
      count: args.count ?? 1,
      record_daily: args.recordDaily ?? true,
    }),
  });
}

export async function releaseUsage(token: UsageToken | null | undefined): Promise<void> {
  if (!token) return;
  try {
    await call<{ ok: boolean }>(`/api/internal/usage/release`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  } catch {
    /* compensation is best-effort; never block the route on a release */
  }
}

// ----------------------------------------------------------------
// Figure PNG (vision)
// ----------------------------------------------------------------

export async function fetchFigurePng(
  paperId: string,
  figureId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  assertConfigured();
  const qs = new URLSearchParams({ user_id: userId }).toString();
  const url = `${BASE}/api/internal/figure/${paperId}/${figureId}?${qs}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal,
      cache: "no-store",
    });
  } catch (e) {
    throw new InternalApiError(
      503,
      `Figure fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
      "internal_unreachable",
    );
  }
  if (!res.ok) {
    throw new InternalApiError(res.status, `Figure ${res.status}`, "figure_fetch_failed");
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return { bytes: buf, mediaType: res.headers.get("content-type") || "image/png" };
}

// ----------------------------------------------------------------
// Cached analysis upsert
// ----------------------------------------------------------------

export async function upsertCachedAnalysis(args: {
  userId: string;
  paperId: string;
  key: string;
  value: unknown;
}): Promise<void> {
  try {
    await call<{ ok: boolean }>(`/api/internal/cached-analysis/upsert`, {
      method: "POST",
      body: JSON.stringify({
        user_id: args.userId,
        paper_id: args.paperId,
        key: args.key,
        value: args.value,
      }),
    });
  } catch {
    /* persistence is best-effort; the user already saw the streamed answer */
  }
}

// ----------------------------------------------------------------
// Cron callbacks
// ----------------------------------------------------------------

export async function adminCleanupTrial(maxAgeHours = 2): Promise<{
  ok: boolean;
  removed_db: number;
  removed_disk: number;
}> {
  return call<{ ok: boolean; removed_db: number; removed_disk: number }>(
    `/api/internal/admin/cleanup-trial`,
    { method: "POST", body: JSON.stringify({ max_age_hours: maxAgeHours }) },
  );
}
