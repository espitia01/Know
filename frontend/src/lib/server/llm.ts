/**
 * Model factory for migrated streaming routes.
 *
 * Stream routes resolve the user's Settings picks via
 * `fetchUserModelPrefs` (Python `resolve_*_model`) and call
 * `getModelFromSlug`. `getModel(role)` remains for health probes and
 * env-default fallbacks (`MODEL_ANALYSIS`, `MODEL_FAST`, `MODEL_VISION`).
 *
 * Per-model completion budgets: use `maxOutputTokensFor(slug, role)` so
 * Opus/Sonnet can emit deeper structured output than Haiku on the same
 * route. Do not hard-code a single cap per route.
 *
 * Routing prefers AI Gateway when configured; otherwise direct Anthropic.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { gateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";

export type ModelRole = "analysis" | "fast" | "vision";

/**
 * Default slugs picked to match the existing Python defaults. Override per
 * role with `MODEL_ANALYSIS`, `MODEL_FAST`, `MODEL_VISION` in Vercel env.
 * `claude-opus-4-7` is the current Opus alias — see backend `gating.py`
 * comments for the alias-canonicalization story.
 */
const DEFAULT_SLUGS: Record<ModelRole, string> = {
  analysis: "claude-sonnet-4-6",
  fast: "claude-haiku-4-5",
  vision: "claude-sonnet-4-6",
};

function slugFor(role: ModelRole): string {
  const env = process.env;
  if (role === "analysis") return env.MODEL_ANALYSIS || DEFAULT_SLUGS.analysis;
  if (role === "fast") return env.MODEL_FAST || DEFAULT_SLUGS.fast;
  return env.MODEL_VISION || DEFAULT_SLUGS.vision;
}

/**
 * Prefer the Gateway whenever it can authenticate. Gateway picks up either
 * `AI_GATEWAY_API_KEY` (set explicitly) or Vercel OIDC inside a Vercel
 * deploy. Locally without either, falls back to direct Anthropic so `npm
 * run dev` still works against a personal `ANTHROPIC_API_KEY`.
 */
function preferGateway(): boolean {
  if (process.env.AI_GATEWAY_API_KEY) return true;
  if (process.env.VERCEL_OIDC_TOKEN) return true;
  return false;
}

/** Build a language model from an Anthropic slug (Settings or env default). */
export function getModelFromSlug(slug: string): LanguageModel {
  if (preferGateway()) {
    return gateway(`anthropic/${slug}`);
  }
  return anthropic(slug);
}

export function getModel(role: ModelRole): LanguageModel {
  return getModelFromSlug(slugFor(role));
}

/**
 * Diagnostic helper for `/api/health/llm`. Returns the role → slug map so
 * the smoke test can report which model an environment is actually using.
 */
export function modelRouting(): { gateway: boolean; roles: Record<ModelRole, string> } {
  return {
    gateway: preferGateway(),
    roles: {
      analysis: slugFor("analysis"),
      fast: slugFor("fast"),
      vision: slugFor("vision"),
    },
  };
}

/** Completion token budget by user-selected model tier (Bug 3). */
export function maxOutputTokensFor(slug: string, role: ModelRole): number {
  const isOpus = slug.includes("opus");
  const isSonnet = slug.includes("sonnet");
  if (role === "analysis") {
    if (isOpus) return 8000;
    if (isSonnet) return 6000;
    return 4000;
  }
  if (role === "fast") {
    if (isOpus) return 4000;
    if (isSonnet) return 3000;
    return 2000;
  }
  if (isOpus) return 4000;
  if (isSonnet) return 3000;
  return 2000;
}
