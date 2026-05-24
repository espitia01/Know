# Know — feature briefing #15 for Composer 2.5

> **Scope**: add first-class OpenAI and Mistral support alongside Anthropic. Make the cheapest Mistral chat model the new default for both Analysis and Selection. Refresh the Settings model picker into a provider-grouped UI with per-model descriptions and provider logos. End state: a user signs in, opens Settings, sees three provider sections (Anthropic, OpenAI, Mistral), each with its own logo and 3–4 models with short plain-English blurbs, and the system defaults to Mistral Small for new users while keeping every existing user's saved Anthropic pick working.
>
> **Stack reminders**:
> - Next.js 16 + AI SDK v6 on Vercel (TypeScript). Existing provider package: `@ai-sdk/anthropic`. Existing gateway routing: `@ai-sdk/gateway`. **You must add `@ai-sdk/openai` and `@ai-sdk/mistral`**.
> - Python FastAPI on Railway (3.11). Existing provider class: `AnthropicProvider` in `backend/app/services/llm.py`. **You must add `OpenAIProvider` and `MistralProvider`** with the same `LLMProvider.complete` / `stream_complete` / `complete_with_image` surface.
> - Tier gating + per-model daily caps are authoritative in `backend/app/gating.py` (Supabase RPCs underneath). Next.js stream routes call back via `/api/internal/*` (HMAC). **Do not duplicate `gating.py` logic in TypeScript.**
> - Anthropic prompt caching is in-place on system blocks. OpenAI and Mistral do not need caching wired up in this round — keep the providers symmetric on `complete()` shape and skip the cache plumbing for them.
>
> **Source-of-truth for model names and API shapes** — **read these first** (yes, actually fetch them; do not guess slugs):
> - Mistral models overview: `https://docs.mistral.ai/getting-started/models/models_overview/`
> - Mistral API reference (chat completions schema, headers, streaming): `https://docs.mistral.ai/api/`
> - Mistral Vercel provider docs: `https://ai-sdk.dev/v5/providers/ai-sdk-providers/mistral`
> - OpenAI models catalog: `https://developers.openai.com/api/docs/models`
> - OpenAI pricing (confirms model ids): `https://openai.com/api/pricing/`
> - OpenAI Vercel provider docs: `https://ai-sdk.dev/v5/providers/ai-sdk-providers/openai`
> - OpenAI Chat Completions (still supported alongside the Responses API): `https://platform.openai.com/docs/api-reference/chat`
>
> **Test plan**: after each track, `cd frontend && npm run lint && npm run build` and `cd backend && pytest -q tests`. Manually verify: (a) a fresh signup defaults to a Mistral model end-to-end, (b) an existing user with `claude-haiku-4-5` stored keeps working without errors, (c) Explain / Derive / Summary all succeed under each provider, (d) the Settings page renders three logo-led sections with model descriptions. **After each track lands**, commit with a `feat(...)` message scoped to that track. **After all tracks pass**, push `main` to `origin/main`.

---

## What you are NOT doing in this round

- Not changing tier prices or quotas.
- Not adding embeddings beyond what's already wired (`text-embedding-3-small` stays for RAG).
- Not changing Mistral OCR (`mistral-ocr-latest` continues to be used for paper parsing — that's separate from chat).
- Not removing Anthropic — every existing path keeps working. Anthropic remains a first-class provider; we are *adding*, not migrating.
- Not adding a custom-API-key BYO flow. Server keys only, same as today.

---

## Provider matrix (the analogs the user asked for)

Three "tiers" map across providers. **You must verify these slugs exist by fetching the docs URLs above before pinning them.** If any slug 404s the API, search the docs again and pick the documented replacement.

| Tier (what users want) | Anthropic | OpenAI | Mistral |
|---|---|---|---|
| Fast & cheap ("Haiku-class") | `claude-haiku-4-5` | `gpt-5-mini` (fallback `gpt-4.1-mini`) | `mistral-small-latest` |
| Balanced ("Sonnet-class") | `claude-sonnet-4-6` | `gpt-5` (fallback `gpt-4.1`) | `mistral-medium-latest` |
| Top quality ("Opus-class") | `claude-opus-4-7` | `gpt-5.4` (fallback `gpt-5`) | `mistral-large-latest` |

**Default for both `analysis_model` and `fast_model` on new users**: `mistral-small-latest`. This is the cheapest first-party Mistral chat model that still does multilingual instruct + structured JSON. (Ministral 3 3B is technically cheaper but is positioned as an edge model — do **not** default to it.)

### Concrete `TIER_LIMITS` block (copy verbatim into `backend/app/gating.py`)

```python
TIER_LIMITS: dict[str, dict] = {
    "free": {
        "max_papers": 3,
        "qa_per_paper": 5,
        "selections_per_paper": 3,
        "features": {"summary", "qa", "selection"},
        "models": {
            "mistral-small-latest",   # default for new users (global default)
            "claude-haiku-4-5",
            "gpt-5-mini",
        },
        # Tier-downgrade target. When a user-saved model is no longer allowed,
        # `enforce_model` returns this. Free → Mistral Small (cheapest).
        "best_model": "mistral-small-latest",
        "daily_api_calls": 10,
        "export_daily": {"pdf": 0, "pptx": 0, "podcast": 0},
        "per_model_daily": {
            "mistral-small-latest": 10,
            "claude-haiku-4-5": 10,
            "gpt-5-mini": 10,
        },
    },
    "scholar": {
        "max_papers": 25,
        "qa_per_paper": 100,
        "selections_per_paper": 100,
        "features": {"summary", "prepare", "assumptions", "qa", "figures", "notes", "selection", "bibtex", "export-pdf", "export-pptx"},
        "models": {
            # Fast (cheap)
            "mistral-small-latest", "claude-haiku-4-5", "gpt-5-mini",
            # Balanced
            "mistral-medium-latest", "claude-sonnet-4-6", "gpt-5",
        },
        # Keep Sonnet as Scholar's tier-downgrade target so EXISTING Scholar
        # users who had Opus stored don't get silently swapped to a different
        # provider — they keep landing on a comparable Anthropic model.
        "best_model": "claude-sonnet-4-6",
        "daily_api_calls": 100,
        "export_daily": {"pdf": 5, "pptx": 3, "podcast": 0},
        "per_model_daily": {
            "mistral-small-latest": 100, "claude-haiku-4-5": 100, "gpt-5-mini": 100,
            "mistral-medium-latest": 40, "claude-sonnet-4-6": 40, "gpt-5": 40,
        },
    },
    "researcher": {
        "max_papers": -1,
        "qa_per_paper": -1,
        "selections_per_paper": -1,
        "features": {"summary", "prepare", "assumptions", "qa", "figures", "notes", "selection", "bibtex", "multi-qa", "export-pdf", "export-pptx", "export-podcast"},
        "models": {
            # Fast
            "mistral-small-latest", "claude-haiku-4-5", "gpt-5-mini",
            # Balanced
            "mistral-medium-latest", "claude-sonnet-4-6", "gpt-5",
            # Top
            "mistral-large-latest", "claude-opus-4-7", "gpt-5.4",
        },
        # Researcher's flagship stays Anthropic Opus so the existing Researcher
        # experience is unchanged on upgrade or downgrade-from-future-tier paths.
        "best_model": "claude-opus-4-7",
        "daily_api_calls": 300,
        "export_daily": {"pdf": 20, "pptx": 10, "podcast": 3},
        "per_model_daily": {
            "mistral-small-latest": 300, "claude-haiku-4-5": 300, "gpt-5-mini": 300,
            "mistral-medium-latest": 150, "claude-sonnet-4-6": 150, "gpt-5": 150,
            "mistral-large-latest": 30, "claude-opus-4-7": 30, "gpt-5.4": 30,
        },
    },
}
```

**Why `best_model` differs from the new-user default**: new users get `mistral-small-latest` because `backend/app/config.py:analysis_model` and `fast_model` default to it (so any user row with NULL `analysis_model` resolves to Mistral). The `best_model` field is only consulted by `enforce_model()` when a user has explicitly saved a model that their CURRENT tier no longer allows — for that path we prefer to keep them on a provider they've already chosen rather than silently flipping them to Mistral. Free has no Anthropic "balanced" tier model so it falls through to Mistral Small naturally.

### Enforcement story (DO NOT BREAK)

Tier gating is enforced in **three independent layers**. Composer must not collapse any of them in pursuit of cleanup — they exist on purpose so a bug or DB-direct write at one layer cannot bypass the others.

**Layer 1 — Write-time**: `backend/app/api/settings.py::update_settings` calls `enforce_model(user_id, requested)` **before** persisting to `users.analysis_model` / `users.fast_model`. Any model not in the caller's tier is silently rewritten to `best_model` before the DB row is touched. Composer must keep this call site intact.

**Layer 2 — Per-request override**: stream routes accept `body.model` for one-off overrides (`ModelOverridePill` UI). `frontend/src/lib/server/internalApi.ts::resolveStreamModelOverride` fetches the user's allow-list via the HMAC-protected `GET /api/internal/user/{id}/allowed_models` and returns the requested model **only if** it's in that list, otherwise it falls back to the user's saved default. Composer must call this helper from every new model-aware route; do not parse `body.model` raw.

**Layer 3 — Use-time**: both code paths that actually instantiate a provider re-run `enforce_model`:
1. Python batch routes (`POST /selection`, `POST /qa`, etc.) → `get_provider(user_id)` / `get_fast_provider(user_id)` → `enforce_model`.
2. Internal usage reservation (`POST /api/internal/usage/reserve`) → calls `enforce_model(user_id, model)` again before debiting the per-model daily cap.

So even if a malicious client crafts a request body with `model = "claude-opus-4-7"` against a Free account, *and* somehow bypasses the allow-list check in Layer 2 (e.g. by writing to Supabase directly), Layer 3 still downgrades it to the tier's `best_model` before the LLM call goes out *and* before any per-model cap is consulted. **The reservation always charges the enforced (downgraded) model, never the requested one** — this is critical so a Researcher-priced cap can't be burned by a Free user.

**Per-model daily caps**: a model only consumes from its own per-model cap if it appears in `per_model_daily` for that tier. The new entries above ensure this for all 9 models in all three tiers. **If you forget to add a row to `per_model_daily` for a model that's in `models`**, usage on that model is bounded only by the per-day total — Composer must double-check this when running through the gating tests.

**Test obligation** (new file `backend/tests/test_gating_matrix.py`):

```python
def test_free_tier_cannot_save_opus():
    # write-time enforcement
    assert enforce_model(free_user_id, "claude-opus-4-7") == "mistral-small-latest"

def test_scholar_downgrade_keeps_anthropic():
    # tier-downgrade target preserves provider continuity for existing users
    assert enforce_model(scholar_user_id, "claude-opus-4-7") == "claude-sonnet-4-6"

def test_per_model_cap_charges_enforced_model_not_requested():
    # Layer 3 charges the downgraded model
    token = reserve_usage(free_user_id, "paper-x", "qa", model="claude-opus-4-7")
    assert token["model"] == "mistral-small-latest"
    # And only the mistral-small-latest cap should have decremented.
```

Mock the DB at the same level the existing tests already do (`backend/tests/conftest.py`).

---

## Track A — Backend: provider plumbing

Files: `backend/app/services/llm.py`, `backend/app/gating.py`, `backend/app/config.py`, `backend/app/api/settings.py`, `backend/app/api/internal.py`, new tests under `backend/tests/`.

### A.1 — Config

`backend/app/config.py`:

```python
# Existing
analysis_model: str = "mistral-small-latest"   # was claude-sonnet-4-6
fast_model: str = "mistral-small-latest"        # was claude-haiku-4-5

# Existing keys (already present)
anthropic_api_key: str = ""
openai_api_key: str = ""          # already used for embeddings; reuse for chat
mistral_api_key: str = ""         # already used for OCR; reuse for chat
```

Update the env warning block at the bottom of the file so missing OpenAI / Mistral keys log a one-shot warning the first time a route tries to use that provider, not on import (we don't want every dev who only has an Anthropic key to see warnings on boot).

### A.2 — Provider classes

`backend/app/services/llm.py`:

Add two new classes alongside `AnthropicProvider`. Keep the `LLMProvider` ABC; don't extend it. Each new class must implement:

- `complete(system, user, max_tokens, *, cache_user_prefix=None)` — returns full text
- `stream_complete(system, user, max_tokens)` — async iterator of text chunks
- `complete_with_image(system, text, image_b64, media_type="image/png", max_tokens)` — returns full text (only if the underlying model is multimodal)

#### OpenAIProvider

- Endpoint: `POST https://api.openai.com/v1/chat/completions`
- Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`
- Body shape (chat completions): `{ "model": "<slug>", "max_completion_tokens": N, "messages": [{"role":"system","content":"…"},{"role":"user","content":"…"}], "stream": true|false }`. **Note**: GPT-5+ uses `max_completion_tokens`, not `max_tokens`. Send both for backwards compatibility on older models, or branch on slug.
- Streaming: SSE with `data: {...}` lines, terminating `data: [DONE]`. Token deltas live in `choices[0].delta.content`.
- Vision: messages take a list content like `[{"type":"text","text":"…"},{"type":"image_url","image_url":{"url":"data:image/png;base64,<b64>"}}]`. The data-URL form is what the Chat Completions API accepts — do **not** try to embed raw base64 in the OpenAI shape.
- Errors: 401 → "OpenAI authentication failed — the API key in server config is invalid or revoked." Map upstream codes the same way `_raise_for_anthropic` does. Use a sibling helper `_raise_for_openai(response, *, model)` so the error story is consistent.

#### MistralProvider

- Endpoint: `POST https://api.mistral.ai/v1/chat/completions`
- Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`
- Body shape: identical OpenAI-like schema — `{ "model": "<slug>", "max_tokens": N, "messages": [...], "stream": true|false, "temperature": 0.2 }`. Mistral accepts `max_tokens` (NOT `max_completion_tokens`).
- Streaming: same SSE-line protocol as OpenAI; deltas in `choices[0].delta.content`.
- Vision (Pixtral-class models like Mistral Medium 3.5 / Mistral Large 3 are multimodal): content list `[{"type":"text","text":"…"},{"type":"image_url","image_url":"data:image/png;base64,<b64>"}]`. **Verify on the docs URL above** before shipping — Mistral's image content shape has changed once already; do not trust prior memory.
- Errors: same translation helper `_raise_for_mistral`.

#### Shared

- Use the same `_get_shared_client()` (single `httpx.AsyncClient` with 300s timeout).
- Log usage tokens (`input_tokens`, `output_tokens`) at INFO with the model id, mirroring the existing `anthropic_usage` log line.
- Add a single dispatch helper:

  ```python
  def _provider_for_slug(slug: str) -> str:
      if slug.startswith("claude-"): return "anthropic"
      if slug.startswith("gpt-"): return "openai"
      if slug.startswith("mistral-") or slug.startswith("ministral-") or slug.startswith("magistral-") or slug.startswith("pixtral-"):
          return "mistral"
      raise LLMProviderError(400, f"Unknown model slug: {slug}", model=slug)
  ```

- Update `get_provider(user_id)` and `get_fast_provider(user_id)` to instantiate the right provider class based on `_provider_for_slug(model)`. The user-level `enforce_model` already canonicalizes IDs (extend it — see A.3).

### A.3 — Gating updates

`backend/app/gating.py`:

```python
ALL_MODELS = [
    # Anthropic
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    # OpenAI
    "gpt-5-mini",
    "gpt-5",
    "gpt-5.4",
    # Mistral
    "mistral-small-latest",
    "mistral-medium-latest",
    "mistral-large-latest",
]

MODEL_ALIASES = {
    # Existing Anthropic aliases — keep verbatim
    "claude-opus-4": "claude-opus-4-7",
    "claude-opus-4-0": "claude-opus-4-7",
    "claude-opus-4-1": "claude-opus-4-7",
    "claude-opus-4-5": "claude-opus-4-7",
    "claude-opus-4-6": "claude-opus-4-7",
    "claude-sonnet-4-0": "claude-sonnet-4-6",
    "claude-sonnet-4-5": "claude-sonnet-4-6",
    # OpenAI aliases (older variants users might land on)
    "gpt-4o": "gpt-5-mini",
    "gpt-4o-mini": "gpt-5-mini",
    "gpt-4.1": "gpt-5",
    "gpt-4.1-mini": "gpt-5-mini",
    "gpt-4.1-nano": "gpt-5-mini",
    # Mistral aliases
    "mistral-small": "mistral-small-latest",
    "mistral-medium": "mistral-medium-latest",
    "mistral-large": "mistral-large-latest",
    "mistral-tiny": "mistral-small-latest",
}
```

Rewrite the `TIER_LIMITS` dict so:

- `free.models` = `{"claude-haiku-4-5", "gpt-5-mini", "mistral-small-latest"}`, `best_model` = `"mistral-small-latest"`
- `scholar.models` = `{"claude-haiku-4-5", "claude-sonnet-4-6", "gpt-5-mini", "gpt-5", "mistral-small-latest", "mistral-medium-latest"}`, `best_model` = `"mistral-medium-latest"`
- `researcher.models` = all 9, `best_model` = `"claude-opus-4-7"` (keep Anthropic Opus as the absolute top so existing Researchers don't see a downgrade)
- Add `per_model_daily` entries for the 6 new models with caps consistent with the existing tier sizes (e.g. cheap class ≈ Haiku's cap; balanced ≈ Sonnet's; top ≈ Opus's).

`canonicalize_model` is fine as-is — it already runs through `MODEL_ALIASES` first.

### A.4 — Internal routes that read prefs

`backend/app/api/internal.py` already exposes `allowed_models` and `model_prefs`. No structural changes — they automatically return the wider `ALL_MODELS` set once gating is updated. **Verify** that `get_allowed_models(user_id)` returns the new ids by writing a unit test.

### A.5 — Tests (`backend/tests/`)

New file `test_providers.py`:

- `test_provider_for_slug_dispatch`: feeds Anthropic / OpenAI / Mistral slugs and an unknown slug into `_provider_for_slug`; asserts the right name comes back and unknown raises.
- `test_enforce_model_canonicalizes_aliases`: feeds `gpt-4o` and `mistral-tiny` and asserts they resolve to the new canonical ids.
- `test_tier_gating_defaults`: Free tier's `enforce_model("free", "gpt-5")` returns `mistral-small-latest`; Scholar's `enforce_model("scholar", "claude-opus-4-7")` returns `mistral-medium-latest`.

Mock `httpx.AsyncClient.post` for the provider classes — do **not** hit real OpenAI / Mistral in CI. Test that the body sent to OpenAI uses `max_completion_tokens` for `gpt-5*` models and `max_tokens` for legacy `gpt-4*` aliases.

---

## Track B — Next.js / AI SDK plumbing

Files: `frontend/package.json`, `frontend/src/lib/server/llm.ts`, `frontend/src/lib/modelLabels.ts`, `frontend/.env.example`, all four migrated stream routes (`selection-stream`, `summary-stream`, `summary-lite-stream`, `figure-qa-stream` — verify which exist).

### B.1 — Install providers

```bash
cd frontend
npm install @ai-sdk/openai @ai-sdk/mistral
```

Pin to the latest stable on registry. Do not pre-release.

### B.2 — Slug routing

`frontend/src/lib/server/llm.ts` — extend `getModelFromSlug` so the AI SDK call lands on the right provider:

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { mistral } from "@ai-sdk/mistral";
import { gateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";

type ProviderName = "anthropic" | "openai" | "mistral";

function providerForSlug(slug: string): ProviderName {
  if (slug.startsWith("claude-")) return "anthropic";
  if (slug.startsWith("gpt-")) return "openai";
  if (
    slug.startsWith("mistral-") ||
    slug.startsWith("ministral-") ||
    slug.startsWith("magistral-") ||
    slug.startsWith("pixtral-")
  ) return "mistral";
  // Fall back to anthropic — keeps existing behaviour for unknown legacy ids
  return "anthropic";
}

export function getModelFromSlug(slug: string): LanguageModel {
  const p = providerForSlug(slug);
  if (preferGateway()) {
    return gateway(`${p}/${slug}`);   // gateway slugs are "anthropic/...", "openai/...", "mistral/..."
  }
  if (p === "openai") return openai(slug);
  if (p === "mistral") return mistral(slug);
  return anthropic(slug);
}
```

**Important**: do NOT enable Anthropic prompt caching options on OpenAI / Mistral calls. `ANTHROPIC_CACHE_EPHEMERAL` and `cachedUserMessages()` should be a no-op for those providers. The cleanest move: in each stream route, build `providerOptions` conditionally — `{ anthropic: ANTHROPIC_CACHE_EPHEMERAL.anthropic }` only when the resolved slug is Anthropic.

### B.3 — Output token budgets

`maxOutputTokensFor(slug, role)` currently branches on `opus`/`sonnet` substring. Generalize:

```ts
function isTopTier(slug: string): boolean {
  return slug.includes("opus") || slug.includes("gpt-5.4") || slug === "gpt-5" || slug.includes("mistral-large");
}
function isBalanced(slug: string): boolean {
  return slug.includes("sonnet") || slug.includes("gpt-4.1") || slug.includes("mistral-medium");
}
```

Apply the same numeric ladders that exist today (analysis 4k/6k/8k, fast 2k/3k/4k, vision 2k/3k/4k).

### B.4 — Default env

`frontend/.env.example`:

```bash
# Model slugs (override per role). Defaults are now Mistral Small.
MODEL_ANALYSIS=mistral-small-latest
MODEL_FAST=mistral-small-latest
MODEL_VISION=mistral-large-latest   # Mistral Large is multimodal
OPENAI_API_KEY=
MISTRAL_API_KEY=
# Anthropic still supported — leave key blank if you only use OpenAI/Mistral.
ANTHROPIC_API_KEY=
```

### B.5 — Labels and tones

`frontend/src/lib/modelLabels.ts`:

```ts
export const MODEL_LABEL: Record<string, { short: string; tone: ModelTone; provider: ProviderName }> = {
  // Anthropic
  "claude-haiku-4-5":  { short: "Haiku",  tone: "blue",   provider: "anthropic" },
  "claude-sonnet-4-6": { short: "Sonnet", tone: "violet", provider: "anthropic" },
  "claude-opus-4-7":   { short: "Opus",   tone: "amber",  provider: "anthropic" },
  // OpenAI
  "gpt-5-mini":        { short: "GPT-5 mini", tone: "blue",   provider: "openai" },
  "gpt-5":             { short: "GPT-5",      tone: "violet", provider: "openai" },
  "gpt-5.4":           { short: "GPT-5.4",    tone: "amber",  provider: "openai" },
  // Mistral
  "mistral-small-latest":  { short: "Mistral Small",  tone: "blue",   provider: "mistral" },
  "mistral-medium-latest": { short: "Mistral Medium", tone: "violet", provider: "mistral" },
  "mistral-large-latest":  { short: "Mistral Large",  tone: "amber",  provider: "mistral" },
};
```

`promptDepthForModel` — generalize so balanced and top-tier models from any provider land on `standard` and `deep`. Keep the default `concise` for cheap-class models.

---

## Track C — Settings UI redesign

File: `frontend/src/app/settings/page.tsx` (the only settings page; other settings files don't exist).

### C.1 — Provider logos

**Already shipped.** `frontend/src/components/ProviderLogo.tsx` exists on `main` and exports `ProviderLogo` plus `PROVIDER_LABEL`:

```tsx
import { ProviderLogo, PROVIDER_LABEL, type ProviderName } from "@/components/ProviderLogo";

// In Settings:
<ProviderLogo provider="mistral" size={20} tone="warm" />
<span>{PROVIDER_LABEL.mistral}</span>     // "Mistral AI"
```

Use it as-is. Do not re-implement, do not add wordmarks, do not pull from a CDN. The marks render via `currentColor` so they adopt the surrounding text color in both light and dark mode. The optional `tone` prop ("warm" / "cool" / "neutral" / "none") renders a soft tinted disc behind the mark — use `tone="warm"` for Mistral, `tone="cool"` for Anthropic and OpenAI in the Settings header rows. If the user later wants pixel-perfect replicas of each company's official mark, the component is annotated with the brand-kit URLs and is the single place to swap them in.

### C.2 — Model descriptions

Replace the existing `MODEL_LABELS` (in `settings/page.tsx`) with a structured table:

```ts
type ModelInfo = {
  id: string;
  name: string;
  provider: "anthropic" | "openai" | "mistral";
  tier: "fast" | "balanced" | "top";
  description: string;
};

const MODELS: ModelInfo[] = [
  // Mistral — listed first so it's the visual default
  {
    id: "mistral-small-latest",
    name: "Mistral Small",
    provider: "mistral",
    tier: "fast",
    description:
      "Fast and inexpensive multilingual model. Great default for Explain, Derive, and quick Q&A on short papers.",
  },
  {
    id: "mistral-medium-latest",
    name: "Mistral Medium",
    provider: "mistral",
    tier: "balanced",
    description:
      "Mistral's balanced workhorse. Recommended for Summary on longer papers when you want depth without the cost of a frontier model.",
  },
  {
    id: "mistral-large-latest",
    name: "Mistral Large",
    provider: "mistral",
    tier: "top",
    description:
      "Mistral's frontier multimodal model. Use for the most demanding Summary and Derive runs.",
  },
  // OpenAI
  {
    id: "gpt-5-mini",
    name: "GPT-5 mini",
    provider: "openai",
    tier: "fast",
    description:
      "OpenAI's fastest current model. Snappy for selection-level explanations; concise prose.",
  },
  {
    id: "gpt-5",
    name: "GPT-5",
    provider: "openai",
    tier: "balanced",
    description:
      "OpenAI's general-purpose flagship. Strong at structured outputs, math, and code.",
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    tier: "top",
    description:
      "OpenAI's premium reasoning model. Use for the most complex derivations and long-context summaries.",
  },
  // Anthropic
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku",
    provider: "anthropic",
    tier: "fast",
    description:
      "Anthropic's fast, low-cost model. Excellent for selection Q&A and follow-ups; strong writing voice.",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet",
    provider: "anthropic",
    tier: "balanced",
    description:
      "Anthropic's balanced model. Reliable for Summary and Assumptions across most paper lengths.",
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus",
    provider: "anthropic",
    tier: "top",
    description:
      "Anthropic's deepest analysis model. Reserve for hard derivations and dense theory papers.",
  },
];
```

### C.3 — Layout

Replace the two flat radio lists ("Analysis Model" / "Selection Model") with **two provider-grouped pickers**. Each picker shows three sections (Anthropic / OpenAI / Mistral) — header row with the provider logo + provider name, then the models for that provider as cards.

Each model card:

- Radio input (hidden, the whole card is clickable)
- Top row: model name (bold) + tiny "fast" / "balanced" / "top" badge
- Below: one-sentence description from `MODELS[id].description`
- Provider logo on the left at 16px

Filter `MODELS` against `models` (the array returned by `api.getModels()`, which now reflects `ALL_MODELS` through tier gating). Hide whole provider groups that have zero allowed models on the current tier.

Glass card styling — match the existing `glass`/`glass-subtle` patterns. Selected card uses `glass-strong shadow-sm`, unselected uses `glass-subtle hover:bg-accent`.

Keep the existing copy under each picker ("Prepare, Summary, Assumptions, Q&A" for analysis, "Selection stream, Figures; Explain, Derive" for selection).

### C.4 — Default highlight

When `analysisModel === ""` or `fastModel === ""` (loaded before the API responds), render `mistral-small-latest` as the visual default so the UI never flickers between "nothing selected" and the persisted choice.

### C.5 — Per-provider availability hint

At the bottom of the Models card, render small status pills:

- "Anthropic: configured" / "not configured"
- "OpenAI: configured" / "not configured"
- "Mistral: configured" / "not configured"

Source: extend the existing `api.getSettings()` response (Python `GET /api/settings`) to return `has_anthropic_key`, `has_openai_key`, `has_mistral_key`. Pull from the server `settings` object. Disable any provider section whose key is missing, with a tooltip "Server is not configured for OpenAI yet — ask your admin to set KNOW_OPENAI_API_KEY".

---

## Track D — Migration safety

### D.1 — Existing users

Run a one-line backfill in `backend/app/api/settings.py`'s `_get_user_model_prefs(user_id)`:

- If the user row's `analysis_model` is NULL **or** is an alias that no longer resolves, fall back to the **tier default** (`TIER_LIMITS[tier]["best_model"]`).
- If the user row has a valid current model (Anthropic, OpenAI, or Mistral), pass through unchanged. We are not silently swapping anyone's preferences.

### D.2 — Hardcoded references

Search for any hardcoded `claude-` / `MODEL_ANALYSIS` / `MODEL_FAST` strings. There should be none outside:

- `backend/app/gating.py` (the definition site)
- `backend/app/config.py` (default values)
- `backend/app/services/llm.py` (constants like `SONNET_MODEL` if it exists)
- `frontend/src/lib/modelLabels.ts`
- `frontend/src/lib/server/llm.ts` (`DEFAULT_SLUGS`)
- `frontend/.env.example`

If you find others, surface them in the operator runbook.

### D.3 — Vercel AI Gateway

Verify Gateway accepts `openai/gpt-5` and `mistral/mistral-small-latest` slugs. The Gateway docs use that `provider/model` form universally. If a slug is rejected, the route falls through to the direct provider client — both paths must work.

---

## Operator runbook — Composer must produce this

Create `docs/PROMPT_15_RUNBOOK.md` covering:

1. **Env vars to set**:
   - On Vercel **Production** and **Preview**: `OPENAI_API_KEY`, `MISTRAL_API_KEY` (existing Anthropic key stays). Update `MODEL_ANALYSIS=mistral-small-latest` and `MODEL_FAST=mistral-small-latest` defaults.
   - On Railway: `KNOW_OPENAI_API_KEY`, `KNOW_MISTRAL_API_KEY` (both already exist for embeddings / OCR — reuse the same keys for chat; document this explicitly so ops doesn't create duplicate keys).
2. **Migration steps**: none. `users.analysis_model` and `users.fast_model` are TEXT NULL columns; no schema change. Existing NULLs resolve to the (newly Mistral-flavoured) tier default automatically.
3. **Rollback**: revert the merge commit. Existing users with stored Anthropic picks keep working because none of the Anthropic code paths are removed. Users who switched to Mistral after launch get downgraded back to their tier's old best (Anthropic) on the rollback — acceptable.
4. **Smoke test sequence** after deploy:
   - Open Settings as a free user. Confirm three providers visible; Mistral Small selected by default; only fast-class models offered on free.
   - Run Summary on a 12-page paper with each of: `mistral-small-latest`, `gpt-5`, `claude-sonnet-4-6`. All three should succeed and persist.
   - Run Explain on an equation selection with `mistral-large-latest`. Vision pipeline (we added in commit `c7b933a`) should attach the PNG for the Mistral large call. If Mistral rejects the image content shape, fall back to text-only — log a `selection.vision_fallback` line so we can see it in Vercel logs.
5. **Monitoring**: watch the Vercel function logs for `tag: "selection-stream.error"` and `tag: "summary-stream.error"` with `errorMessage` containing `model` — that's how we'll catch a stale slug breaking under one of the new providers. Filter Railway logs for `Selected model 'X' is not available` from `_raise_for_*`.

Append the runbook to chat **verbatim** in the final response so the operator can copy it without opening files.

---

## Acceptance checklist

A track is done when ALL of the below pass:

- [ ] `npm run lint && npm run build` clean in `frontend/`
- [ ] `pytest -q tests` green in `backend/`
- [ ] New tests in `backend/tests/test_providers.py` cover provider dispatch + alias canonicalization + tier defaults
- [ ] `GET /api/internal/user/<id>/allowed_models` returns the new 9-model superset for a Researcher
- [ ] `POST /api/papers/<id>/selection` with `image_base64` succeeds against `mistral-large-latest` (or falls back cleanly to text)
- [ ] Settings page renders three logo-led sections with descriptions
- [ ] A fresh signup writes `mistral-small-latest` for both `analysis_model` and `fast_model`
- [ ] A user with `claude-haiku-4-5` saved before the deploy still gets Anthropic responses after the deploy
- [ ] Commit messages follow `feat(...)` / `fix(...)` shape and one commit per track
- [ ] Final push to `origin/main`

---

## Style guardrails (existing rules in `.cursor/rules/`)

These already apply and Composer must respect them:

- `analysis-pane.mdc` — use existing primitives, no new colors / shadows.
- `architecture.mdc` — streaming runs on Vercel; batch runs on Python; gating is Python-authoritative.
- `latex.mdc` — migrated paths use `ContentBlock[]` + Zod, never free-form markdown with `$` in `prose`.

If you find yourself adding a new color token, shadow, or animation in service of "the Mistral section needs to stand out" — stop. Use the existing tone palette (`blue` / `violet` / `amber`) keyed off the tier (`fast` / `balanced` / `top`), and let provider logos carry the brand differentiation.
