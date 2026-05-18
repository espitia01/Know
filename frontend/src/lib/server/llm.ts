/**
 * Model factory for migrated streaming routes.
 *
 * One entry point: `getModel(role)`. Roles map to env-overridable Anthropic
 * model slugs. Routing prefers AI Gateway (which handles caching, retries,
 * and provider failover for us) and falls back to direct `@ai-sdk/anthropic`
 * only when Gateway isn't configured. A model swap is one env change.
 *
 * Anthropic prompt caching is enabled on the Gateway path for the system
 * prompt — the system prompt repeats verbatim across selection / summary /
 * figure-qa calls, so caching cuts both cost and TTFB.
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

export function getModel(role: ModelRole): LanguageModel {
  const slug = slugFor(role);
  if (preferGateway()) {
    // Gateway routes Anthropic provider IDs as `anthropic/<slug>`.
    return gateway(`anthropic/${slug}`);
  }
  return anthropic(slug);
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
