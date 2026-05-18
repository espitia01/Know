/**
 * Lightweight server-side observability helpers.
 *
 * Vercel collects function logs automatically, so this module mostly
 * exists to standardize the shape of the JSON we emit so logs are
 * grep-able / dashboard-friendly. Two concerns:
 *
 *   - `recordLlmCall(...)` — one structured log line per LLM call,
 *     including role, model, paperId (when relevant), duration, and
 *     status. Useful in the AI Gateway dashboard to correlate a
 *     latency spike with a particular role or paper.
 *   - `kvCounter(...)` — increment a per-day KV counter for ad-hoc
 *     daily totals (e.g. how many summary streams ran today). Best-
 *     effort; KV transport failures are swallowed.
 *
 * Calls are non-blocking. Wrap them in `after()` if your route is
 * latency-sensitive.
 */

import "server-only";

import { cacheGet, cacheSet } from "./kv";

export type LlmCallEvent = {
  role: "analysis" | "fast" | "vision";
  model: string;
  paperId?: string;
  durationMs: number;
  status: "ok" | "error" | "aborted";
  errorMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
};

export function recordLlmCall(event: LlmCallEvent): void {
  // Plain JSON to stdout is the cheapest way to ship structured
  // events on Vercel — the Logs UI parses these and the platform's
  // log forwarder can ingest them downstream.
  const line = {
    type: "llm_call",
    ts: new Date().toISOString(),
    ...event,
  };
  // Structured server log; Vercel ingests stdout JSON natively.
  console.log(JSON.stringify(line));
}

function todayKey(scope: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `metric:${scope}:${y}-${m}-${d}`;
}

const DAY_TTL_SECONDS = 60 * 60 * 26; // 26h, slight buffer over a day

export async function kvCounter(scope: string, by = 1): Promise<void> {
  const key = todayKey(scope);
  try {
    const current = (await cacheGet<number>(key)) ?? 0;
    await cacheSet(key, current + by, DAY_TTL_SECONDS);
  } catch {
    /* best-effort */
  }
}
