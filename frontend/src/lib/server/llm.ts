/**
 * Model factory for migrated streaming routes.
 *
 * Stream routes resolve the user's Settings picks via
 * `fetchUserModelPrefs` (Python `resolve_*_model`) and call
 * `getModelFromSlug`. `getModel(role)` remains for health probes and
 * env-default fallbacks (`MODEL_ANALYSIS`, `MODEL_FAST`, `MODEL_VISION`).
 *
 * Per-model completion budgets: use `maxOutputTokensFor(slug, role)` so
 * top-tier models can emit deeper structured output than fast-class models
 * on the same route. Do not hard-code a single cap per route.
 *
 * Routing prefers AI Gateway when configured; otherwise direct provider SDK.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { mistral } from "@ai-sdk/mistral";
import { gateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";

export type ModelRole = "analysis" | "fast" | "vision";

type ProviderName = "anthropic" | "openai" | "mistral";

/**
 * Default slugs — Mistral Small for analysis and fast roles. Override per
 * role with `MODEL_ANALYSIS`, `MODEL_FAST`, `MODEL_VISION` in Vercel env.
 */
const DEFAULT_SLUGS: Record<ModelRole, string> = {
  analysis: "mistral-small-latest",
  fast: "mistral-small-latest",
  vision: "mistral-large-latest",
};

/** Env-backed default slug for a role (used by stream routes as last resort). */
export function defaultSlugFor(role: ModelRole): string {
  return slugFor(role);
}

function slugFor(role: ModelRole): string {
  const env = process.env;
  if (role === "analysis") return env.MODEL_ANALYSIS || DEFAULT_SLUGS.analysis;
  if (role === "fast") return env.MODEL_FAST || DEFAULT_SLUGS.fast;
  return env.MODEL_VISION || DEFAULT_SLUGS.vision;
}

/**
 * Prefer the Gateway whenever it can authenticate. Gateway picks up either
 * `AI_GATEWAY_API_KEY` (set explicitly) or Vercel OIDC inside a Vercel
 * deploy. Locally without either, falls back to direct provider SDKs.
 */
function preferGateway(): boolean {
  if (process.env.AI_GATEWAY_API_KEY) return true;
  if (process.env.VERCEL_OIDC_TOKEN) return true;
  return false;
}

export function providerForSlug(slug: string): ProviderName {
  if (slug.startsWith("claude-")) return "anthropic";
  if (slug.startsWith("gpt-")) return "openai";
  if (
    slug.startsWith("mistral-") ||
    slug.startsWith("ministral-") ||
    slug.startsWith("magistral-") ||
    slug.startsWith("pixtral-")
  ) {
    return "mistral";
  }
  return "anthropic";
}

/** Build a language model from a provider slug (Settings or env default). */
export function getModelFromSlug(slug: string): LanguageModel {
  const p = providerForSlug(slug);
  if (preferGateway()) {
    return gateway(`${p}/${slug}`);
  }
  if (p === "openai") return openai(slug);
  if (p === "mistral") return mistral(slug);
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

function isTopTier(slug: string): boolean {
  return (
    slug.includes("opus") ||
    slug.includes("gpt-5.4") ||
    slug === "gpt-5" ||
    slug.includes("mistral-large")
  );
}

function isBalanced(slug: string): boolean {
  return (
    slug.includes("sonnet") ||
    slug.includes("gpt-4.1") ||
    slug.includes("mistral-medium")
  );
}

/** Completion token budget by user-selected model tier. */
export function maxOutputTokensFor(slug: string, role: ModelRole): number {
  const top = isTopTier(slug);
  const balanced = isBalanced(slug);
  if (role === "analysis") {
    if (top) return 8000;
    if (balanced) return 6000;
    return 4000;
  }
  if (role === "fast") {
    if (top) return 4000;
    if (balanced) return 3000;
    return 2000;
  }
  if (top) return 4000;
  if (balanced) return 3000;
  return 2000;
}
