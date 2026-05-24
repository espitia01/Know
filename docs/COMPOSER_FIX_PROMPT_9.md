# Multi-fix pass: summary 500, demo reader, settings UX, combined caps, model logos

You're working in a Next.js 15 (App Router) + FastAPI repo. Streaming LLM calls live in
Next.js (`frontend/src/app/api/papers/[id]/*`), batch + tier/usage gating live in Python
(`backend/app/gating.py`, `backend/app/main.py`, `backend/app/api/internal.py`). Tier
gating is the **Python source of truth** — Next.js calls `/api/internal/*` over an HMAC
bearer; do **not** duplicate gating logic in TS.

Make the following changes as one cohesive PR. Each section is independent — open them
as separate commits if useful, but ship them together.

---

## 1. Summary endpoint still returns 500

Repro: authenticated user clicks Summary → 500 from
`POST /api/papers/{id}/summary-stream`. Recent commit `8117179` added a guard for
empty `raw_text` and an outer try/catch, so any 500 we see now is bubbling up from
`streamObject` itself (provider error, schema-validation error, or an unhandled rejection
inside `onFinish`).

Do this in `frontend/src/app/api/papers/[id]/summary-stream/route.ts`:

1. Wrap the `streamObject({...})` call's `onFinish` and `onError` bodies in
   `try/catch` so a throw inside our persistence path can never propagate out as
   "Internal Server Error". Log with the existing `tag: "summary-stream.*"` shape.
2. Treat the result of `result.toTextStreamResponse(...)` as the only thing we
   return; if `streamObject` throws *synchronously* (e.g. invalid model slug, missing
   provider key), keep the existing `502 provider_error` path but include the slug
   we tried in the error body so the frontend can surface "GPT-5 mini is not
   configured on the server" instead of a bare 500.
3. On the Python side, audit `backend/app/api/internal.py::internal_paper_text` and
   `gating.reserve_usage` paths used by `summary-stream` for any unhandled exception
   that would surface as a 502 → masked as 500 by AI Gateway. If `paper_prompt_text`
   returns empty, return a structured `409 paper_text_unavailable` (we already do
   this for empty `raw_text` in TS — match it server-side).
4. Add a small E2E-ish unit test in `backend/tests/` that hits `summary-stream`
   with a paper whose `raw_text` is `"   "` (whitespace) and asserts a 409 with
   `code === "paper_text_unavailable"`.

Acceptance: forced provider error (e.g. `analysis_model` set to a slug with no key
configured) returns a JSON body `{ detail: { code, message, model } }` with 502, never
500. The structured-output schema-mismatch path also returns a typed error rather than
crashing the route.

---

## 2. PDF worker warning: `TT: undefined function: 32`

This is a benign pdf.js font-program warning (TrueType opcode 32). Don't break
rendering. Just silence it at the source so the console stays clean:

In `frontend/src/components/pdf/PdfViewer.tsx` (or wherever we configure pdf.js
`getDocument`), set `verbosity: pdfjs.VerbosityLevel.ERRORS` on the `getDocument`
call, and confirm `GlobalWorkerOptions.workerSrc` is still pointed at the bundled
`pdf.worker.min.b67f3282.mjs`. Add a one-line comment: `// pdf.js logs benign
TrueType warnings at INFOS — clamp to ERRORS only.`

---

## 3. Demo (`/try/[id]`) shows the OCR markdown reader instead of the actual paper

Yes — the trial flow runs Mistral OCR (see `_ocr_upload_fields` in
`backend/app/api/papers.py`, called from `trial_upload` in `backend/app/main.py`).
When `ocrStatus === "ready"` the trial page swaps in `MarkdownReader`. The
authenticated paper view at `frontend/src/app/paper/[id]/page.tsx` already gates
this with `const useMarkdownReader = false;` so signed-in users see the PDF.

Make the trial consistent: in `frontend/src/app/try/[id]/page.tsx`, replace the
`ocrStatus === "ready" ? <MarkdownReader ... /> : <PdfViewer ... />` ternary with
`<PdfViewer .../>` unconditionally. Keep the OCR run in the trial backend (we still
need OCR markdown for selection/summary grounding) — just don't render it.

Acceptance: a freshly uploaded trial paper shows the real PDF in the reader pane;
selection/summary still work because OCR markdown is still fetched server-side for
prompts.

---

## 4. Settings page model list is too dense + lags on first click

Two problems, one file: `frontend/src/app/settings/page.tsx` and
`frontend/src/components/settings/ModelPicker.tsx`.

### 4a. Lag

The page issues `getSettings` **twice** in two separate `useEffect`s, plus
`getModels`, plus (when `tierUser` resolves) `getAccountUsage`. Consolidate:

- One `useEffect` hits `getSettings` once and sets all derived state
  (`hasAnthropicKey`, `hasOpenaiKey`, `hasMistralKey`, `analysisModel`, `fastModel`,
  `deepAnalysis`, `deepAllowed`, `deepMultiplier`, `tierLimits`).
- `getModels` and `getAccountUsage` run in parallel via `Promise.all` next to it.
- Add a `useState<boolean>` `loading` and render a skeleton with the same card
  shells (no layout shift) until the first paint resolves.

### 4b. Simplify the model list

Today every model is a full-height radio card. The list reads as 9 redundant
options. Redesign the picker:

- Render a single **scrollable** list (`max-h-[280px] overflow-y-auto`) grouped by
  *capability tier* — `fast` / `balanced` / `top` — using the existing
  `MODEL_CATALOG[].tier` field. Provider becomes a small `ProviderLogo` + name
  prefix on each row, not a section header.
- Each row: provider logo (16px), model name, one-line description, and a
  trailing **checkmark** when selected (replace the radio input with a clickable
  row whose selected state shows a `Check` icon from `lucide-react`).
- Models that the **current tier doesn't include** must still be **visible** but
  **disabled** with `aria-disabled="true"`, lower opacity, a small "Researcher"
  badge, and a tooltip "Available on the Researcher plan." Do not filter them out
  via `allowedIds` anymore — instead, `MODEL_CATALOG` is the visible source of
  truth, and a `tierAllows(model)` helper drives the disabled/enabled state.
- "Provider not configured" is a separate disabled reason — keep that tooltip
  message for the admin path.

Acceptance: a Free user opens Settings and sees all 9 models with Mistral Medium
/ Sonnet / GPT-5 / Opus / Mistral Large / GPT-5.4 visibly disabled with a
"Scholar" or "Researcher" upsell badge. A Scholar user sees Researcher-tier
models disabled. Researcher sees everything enabled (provider-key permitting).

---

## 5. Analysis pane: model "dot" → provider logo

`frontend/src/components/analysis/ModelPill.tsx` and
`frontend/src/components/analysis/ModelOverridePill.tsx` both render a
1.5×1.5 colored dot before the model short-name. Replace it with the provider
logo from `frontend/src/components/ProviderLogo.tsx`:

- `modelLabel(slug).provider` already returns the `ProviderName`.
- Render `<ProviderLogo provider={provider} size={12} tone="none" />` in place of
  the dot in both `ModelPill` and the option rows in `ModelOverridePill`.
- Keep the existing `data-action` attribute (still tone-derived) so action-tinted
  styling continues to work elsewhere.

Acceptance: every place the small "Sonnet"/"GPT-5"/"Mistral Large" pill appears
in the analysis pane (including selection results and figure Q&A) shows the
real provider mark, not a generic dot.

---

## 6. Delete the Google Drive integration card from Settings

In `frontend/src/app/settings/page.tsx`, remove the entire
`<div id="integrations" ...>` block (the "Google Drive & Workspace" card). Drive
import remains available on Dashboard/Library; we just don't surface it in
Settings anymore.

Also remove the now-unused imports: `Link` (only if no other usage remains —
check), `isGoogleDriveConfigured` from `@/lib/googleDrive`, and the SVG path. Run
the linter; nothing else should regress.

---

## 7. Restructure per-model caps as **3 shared tier-level caps**

This is the biggest semantic change. Today
`backend/app/gating.py::TIER_LIMITS[tier]["per_model_daily"]` keys per-model
counts independently — Researcher gets 300 Haiku + 300 Mistral Small + 300
GPT-5 mini, etc. The intent is for those to **share** a single 300/day "fast"
budget; balanced models share 150/day; top models share 30/day. Same idea on
Scholar (100 fast, 40 balanced) and Free (10 fast, no balanced/top).

### 7a. Data model

Add a `MODEL_TIER` constant in `gating.py` mirroring the `tier` field of
`frontend/src/components/settings/ModelPicker.tsx::MODEL_CATALOG`:

```python
MODEL_TIER = {
    "claude-haiku-4-5": "fast",
    "gpt-5-mini": "fast",
    "mistral-small-latest": "fast",
    "claude-sonnet-4-6": "balanced",
    "gpt-5": "balanced",
    "mistral-medium-latest": "balanced",
    "claude-opus-4-7": "top",
    "gpt-5.4": "top",
    "mistral-large-latest": "top",
}
```

Replace `TIER_LIMITS[tier]["per_model_daily"]` (per-model dict) with
`TIER_LIMITS[tier]["per_capability_daily"]` (per-tier dict):

```python
"researcher": { ..., "per_capability_daily": {"fast": 300, "balanced": 150, "top": 30}, ... }
"scholar":    { ..., "per_capability_daily": {"fast": 100, "balanced": 40,  "top": 0  }, ... }
"free":       { ..., "per_capability_daily": {"fast": 10,  "balanced": 0,   "top": 0  }, ... }
```

### 7b. Reservation path

In `reserve_usage`, when a `model` is supplied, compute
`capability = MODEL_TIER.get(model)` and reserve from a **single shared daily
counter keyed on capability**, not on the model slug. Use one new DB RPC
`reserve_daily_capability_usage(user_id, day, capability, count, cap)`.
Compensating release is `release_daily_capability_usage(...)`. Add a Supabase
migration `backend/supabase/migrations/023_capability_caps.sql` that:

- Adds a `daily_capability_usage(user_id text, day date, capability text, used int)`
  table with `(user_id, day, capability)` PK.
- Defines the two RPCs above with the same atomic "increment iff under cap"
  pattern as `reserve_daily_model_usage` (see migration 008).
- Optional: keep the legacy `daily_model_usage` table for read compatibility,
  but mark `reserve_daily_model_usage` as deprecated (don't drop yet).

### 7c. Hard-deny when capability cap is 0 (free user trying to use a balanced/top model)

After we map `model → capability`, if the tier's
`per_capability_daily[capability]` is 0 we reject with **403 model_tier_locked**
(not 429), with `detail.code = "model_tier_locked"` and a message pointing at
the upgrade flow. This is what makes "lower tiers can't use models not in their
plan" enforceable server-side. The frontend Settings change in §4b is the
visual half; this is the enforcement half.

### 7d. Reporting

Update `get_per_model_daily_usage` → `get_capability_daily_usage` returning:

```python
[
  {"capability": "fast",     "label": "Fast",     "used": int, "limit": int},
  {"capability": "balanced", "label": "Balanced", "used": int, "limit": int},
  {"capability": "top",      "label": "Top",      "used": int, "limit": int},
]
```

Update `/api/usage` in `backend/app/main.py` to return the new shape under a new
key `per_capability_usage` (keep `per_model_usage` returning `[]` for one
release for back-compat). Update
`frontend/src/lib/api.ts::api.getAccountUsage` and the Usage card in
`frontend/src/app/settings/page.tsx` to render three `UsageBar`s — "Fast
models", "Balanced models", "Top models" — instead of nine per-model bars.

### 7e. Tests

- Update `backend/tests/test_gating_matrix.py` to assert combined-cap behavior:
  a Researcher who has used 100 Haiku, 100 GPT-5 mini, and 99 Mistral Small
  succeeds on the next fast call but fails on the *301st*.
- Add a test that a Free user calling with `model="claude-sonnet-4-6"` gets a
  403 `model_tier_locked`.

Acceptance criteria summary:
- A Researcher can spend their 300 fast budget across Haiku + Mistral Small +
  GPT-5 mini in any mix.
- Free users are blocked at the gating layer from selecting balanced/top models
  (UI shows them disabled per §4b; backend returns 403 if forced).
- The Settings Usage card shows 3 bars, not 9.

---

## Out of scope (do not touch this PR)

- The legacy `polish_note_from_selection` markdown→KaTeX pipeline.
- Anything under `frontend/src/components/notes/` and `Md.tsx`.
- The PDF worker file itself (`pdf.worker.min.b67f3282.mjs`); we only adjust
  verbosity at the consumer.

## Notes

- Keep the `backend/supabase/migrations/022_db_security_hardening.sql` style
  for the new migration — header comment block + plain SQL, no plpgsql magic
  beyond what migration 008 already used.
- No new design tokens, no new motion durations, no new shadow tokens (per
  `.cursor/rules/analysis-pane.mdc`).
- All math in any new prose stays in `math` blocks; no `$...$` in markdown
  (per `.cursor/rules/latex.mdc`). None of these changes should touch prompts,
  but it's a free reminder.
- After substantive edits, run the linter and fix anything you introduce.
