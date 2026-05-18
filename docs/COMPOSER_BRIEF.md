# Composer 2 Implementation Brief — Know

> **Read this whole document before starting Stage 0.** Each stage is one PR. Do not begin a stage until the previous stage is merged. If any acceptance criterion fails, fix in-stage; do not roll forward.

> **Commit and push to GitHub after every stage.** Use the per-stage git workflow in §11. Do not let work pile up across stages without pushing.

## 0. Mission

Move interactive LLM streaming off Python/httpx and onto Next.js + Vercel AI SDK. Drop local-model support. Adopt Vercel AI Gateway, KV, Cron, and Fluid Compute. Fix LaTeX rendering at the schema level (no more delimiter regexes). Refactor the analysis pane to a small set of shared primitives. Keep the existing visual language ("calmer chrome, neutral tokens, restrained motion").

## 1. Architecture target

```
Browser ──► Next.js (Vercel)
              │
              ├─► AI SDK route handlers (streaming):
              │     /api/papers/[id]/selection-stream
              │     /api/papers/[id]/summary-stream
              │     /api/papers/[id]/figure-qa-stream
              │     /api/papers/[id]/qa            (new — also AI SDK)
              │
              ├─► AI Gateway → Anthropic (Sonnet/Haiku/vision)
              ├─► Vercel KV  (token cache, rate limits, idempotency, cache)
              ├─► Supabase   (read paper rows for context, via service role)
              └─► Python /api/internal/*  (HMAC bearer; usage reserve/release, paper text, figure PNG)

Browser ──► Python (Railway / Mac Studio)
              ├─► Paper upload, parse, figure extraction, storage mirror
              ├─► Batch analysis endpoints (analyze, assumptions, ask, ask-multi) — UNCHANGED
              ├─► Trial endpoints — UNCHANGED THIS CYCLE
              ├─► Settings, billing, search, library
              └─► /api/internal/* (server-to-server only; HMAC)
```

## 2. Scope

**In scope**

- Migrating selection-stream, summary-stream, figure-qa-stream, and authenticated Q&A to Next.js + AI SDK.
- Replacing the broken in-memory rate limiter and the in-process trial cleanup loop with Vercel KV + Cron.
- A structured `ContentBlock` schema rendered by a new `RichContent` component; deleting `preprocessLatex` for migrated paths.
- Full refactor of `BottomPanel`, `SelectionResultPanel`, `SummaryPanel`, `QAPanel`, `AssumptionsPanel`, `FiguresPanel`, `RelatedWorkPanel` against shared primitives in `components/analysis/`.
- AI Gateway in front of Anthropic with provider/model routing.
- Removing all local-model code paths.

**Explicitly out of scope this cycle**

- Authentication semantics, Clerk integration, billing flow.
- Paper upload, PDF parse, figure extraction, storage mirror.
- Trial endpoints (anonymous flow stays in Python).
- Notes (`polish_note_from_selection`) — keeps Python markdown path; keep a slim `preprocessLatex` shim only for this.
- Dashboard, library, landing, sign-in/up, terms.
- Batch analysis endpoints (`analyze`, `assumptions`, `ask`, `ask-multi`, `extract_metadata`).

## 3. Files Composer 2 must read first

In order:

1. `backend/app/services/llm.py` — current Anthropic client, prompts, JSON repair.
2. `backend/app/api/papers.py` — selection-stream and figure-qa-stream routes.
3. `backend/app/main.py` — trial endpoints, CORS, lifespan.
4. `backend/app/gating.py` — `enforce_model`, `reserve_usage`, `release_usage`, `TIER_LIMITS`.
5. `backend/app/services/db.py` — Supabase RPCs already in use.
6. `frontend/src/lib/api.ts` — full client surface.
7. `frontend/src/lib/selectionSse.ts` — current SSE consumer.
8. `frontend/src/lib/latex.ts` — the 956-line preprocessor we are deleting (for migrated paths).
9. `frontend/src/components/ui/Md.tsx` — current markdown renderer.
10. `frontend/src/components/panel/BottomPanel.tsx` — analysis-pane host.
11. `frontend/src/components/panel/SelectionResultPanel.tsx` — selection result UI.
12. `frontend/src/components/sidebar/SummaryPanel.tsx`, `QAPanel.tsx`, `AssumptionsPanel.tsx`, `FiguresPanel.tsx`, `RelatedWorkPanel.tsx`.
13. `frontend/src/lib/store.ts` — zustand store; selection / summary / qa slices.
14. `frontend/AGENTS.md` — *this Next.js is not the one in your training data; respect deprecation notices.*
15. `.cursor/rules/architecture.mdc`, `.cursor/rules/latex.mdc`, `.cursor/rules/analysis-pane.mdc`.

## 4. Files Composer 2 MUST NOT modify

- `frontend/src/middleware.ts`
- `frontend/src/components/ClerkTokenProvider.tsx`
- `frontend/src/app/sign-in/**`, `frontend/src/app/sign-up/**`
- `backend/app/auth.py`
- `backend/app/api/billing.py`
- `backend/app/services/storage.py`
- `backend/supabase/**` (migrations) — additive only via new files; never edit existing migrations.
- Anything under `papers/` or `frontend/public/`.

## 5. Visual language (enforced everywhere new)

Source of truth: existing tokens in `globals.css` and recent commits. Do not introduce new colors, new shadow tokens, or new motion durations. Full rules in `.cursor/rules/analysis-pane.mdc`.

## 6. Cross-cutting rules

- **No new visual styles.** Audit yourself: any new Tailwind class not currently in the codebase requires a comment justifying it.
- **No `console.log`** in production paths. Use Vercel observability.
- **Idempotency**: every migrated streaming route accepts an optional `Idempotency-Key` header. Cache the final assembled result in KV for 1 hour at `(user_id, paper_id, action, key)`.
- **Errors**: structured `{ code, message, model? }` detail body, mirroring the existing Python `LLMProviderError` shape. Surface tier/limit errors as 403 (`code: "tier_locked"`) or 429 (`code: "rate_limited"` / `"daily_cap"` / `"paper_cap"`).
- **Tier gating** is the Python backend's responsibility. **Never duplicate `gating.py` logic in Next.js.** Always call `/api/internal/usage/reserve` before stream start and `/api/internal/usage/release` (via `after()`) on completion or failure.
- **Auth**: Next.js routes use Clerk's server `auth()` to extract `userId`. Reject if missing.
- **Server secrets** live in Vercel env: `ANTHROPIC_API_KEY`, `AI_GATEWAY_API_KEY` (or use OIDC), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_BACKEND_URL`, `INTERNAL_BACKEND_TOKEN`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`. **Never expose to the browser.**
- **Streaming protocol**: AI SDK Data Stream Protocol on migrated routes. Old SSE envelope (`{type, text}`) stays only on the trial endpoint and any unmigrated path. Frontend may temporarily keep both consumers; remove legacy when nothing references it.
- **Tests**: each migrated route gets a smoke test under `frontend/src/__tests__/api-routes/` using `@ai-sdk/anthropic`'s mock provider.
- **Lint**: must pass `cd frontend && npm run lint`.
- **Commit style**: match recent commits — short imperative title, optional body explaining *why* (see `git log`). Conventional prefixes are *not* required.

## 7. Assumptions (Composer 2: stop and ask the user if any of these are wrong)

1. Python deploy URL is reachable from Vercel as `INTERNAL_BACKEND_URL` (HTTPS).
2. Supabase service-role key may be stored in Vercel env.
3. Anthropic API key may be stored in Vercel env (in addition to Railway env).
4. Vercel project is on a plan with KV, Cron, and Fluid Compute.
5. AI Gateway is enabled on the Vercel team or `AI_GATEWAY_API_KEY` is provisioned.
6. The frontend currently builds and runs locally with `NEXT_PUBLIC_API_URL=http://localhost:8000`.
7. Notes path stays in Python, returning markdown — Notes panel is unchanged.
8. Trial flow stays in Python — trial selection-stream is unchanged this cycle.
9. PR cadence: per-stage PRs (one per stage). Push to GitHub after each.
10. Gating: Python `/api/internal/*` is the single source of truth (no Next.js → Supabase RPC duplication).

## 8. Stages

Each stage is one PR. Title each PR `[stage N] <short>`. Commit and push to GitHub at the end of each stage (see §11).

---

### Stage 0 — Repo hygiene & Cursor rules

**Goal:** quiet noise; record the architectural rules so future agents follow them.

**Tasks**

1. Delete `frontend/package-lock 2.json` and any stray `.DS_Store` files in tracked paths.
2. Add to `.gitignore` (root): `.DS_Store`, `**/.DS_Store`, `frontend/.next/`, `frontend/tsconfig.tsbuildinfo`. (Some entries already present; consolidate.)
3. Create `.cursor/rules/latex.mdc` (alwaysApply) summarizing: migrated paths use `ContentBlock` schema; never put math in markdown prose; legacy Notes path keeps slim preprocessLatex.
4. Create `.cursor/rules/analysis-pane.mdc` (alwaysApply) summarizing: use `AnalysisSection`, `AnalysisCard`, `StreamingMarkdown`, `RichContent`, `OverflowMenu`; no new colors / shadows / motion durations.
5. Create `.cursor/rules/architecture.mdc` (alwaysApply) summarizing: streaming = Next.js + AI SDK; batch = Python; gating = Python via internal endpoints; LLM keys in Vercel env; trial path stays Python.
6. Save this brief at `docs/COMPOSER_BRIEF.md`.

**Acceptance**

- `git status` clean post-commit.
- `frontend/` lint passes unchanged.
- Three rule files present and ≤ 80 lines each.

---

### Stage 1 — Plumbing (no behavior changes yet)

**Goal:** install AI SDK + supporting libs; create server-side primitives; add Python internal router; smoke-test the round trip.

**Frontend tasks**

1. Add deps in `frontend/`:
   - `ai`, `@ai-sdk/anthropic`, `@ai-sdk/gateway`, `@ai-sdk/react`
   - `zod`
   - `@vercel/kv`, `@vercel/functions`
   - `@upstash/ratelimit` (KV-backed limiter)
   - Use `npm install <pkg>@latest` — do not pin versions you guess.
2. Create `frontend/src/lib/server/llm.ts`:
   - `getModel(role: "analysis" | "fast" | "vision"): LanguageModel` — returns AI Gateway model when `AI_GATEWAY_API_KEY` is set, otherwise direct `@ai-sdk/anthropic`.
   - Roles map to env-overridable model slugs: `MODEL_ANALYSIS` (default Sonnet), `MODEL_FAST` (Haiku), `MODEL_VISION` (Sonnet).
   - Anthropic prompt-caching headers enabled for the system prompt.
3. Create `frontend/src/lib/server/kv.ts`:
   - Typed wrappers around `@vercel/kv`: `cacheGet<T>`, `cacheSet`, `idempotency.lookup/store`, `rateLimit.tryConsume(key, limit, windowSec)` using `@upstash/ratelimit` sliding window.
4. Create `frontend/src/lib/server/supabase.ts`: server-only admin client; throws if used from a client component.
5. Create `frontend/src/lib/server/auth.ts`:
   - `requireUser(): Promise<{ userId: string; tier: string }>` using Clerk `auth()` then a Supabase read for tier (cache 30s in KV).
6. Create `frontend/src/lib/server/internalApi.ts`:
   - `fetchPaperContext(paperId, userId)` → `{ raw_text, title, authors, has_si }`.
   - `reserveUsage({ userId, paperId, kind, model })` → `{ token, remaining }`.
   - `releaseUsage({ userId, paperId, kind, token })`.
   - `fetchFigurePng(paperId, figureId)` → `Buffer`.
   - All include `Authorization: Bearer ${INTERNAL_BACKEND_TOKEN}`; throw on non-2xx with structured detail.
7. Create `frontend/src/app/api/health/llm/route.ts`:
   - Calls `getModel("fast").doGenerate({ prompt: "ping", maxOutputTokens: 8 })` (verify exact API by reading `node_modules/ai/dist/docs/`).
   - Returns `{ ok, model, latencyMs }`.
8. Update `frontend/.env.example` with the new vars.
9. Update `frontend/vercel.json`: enable Fluid for `/api/papers/*/selection-stream`, `/api/papers/*/summary-stream`, `/api/papers/*/figure-qa-stream`, `/api/papers/*/qa`.

**Backend tasks**

1. Create `backend/app/api/internal.py`, router prefix `/api/internal`, requires `Authorization: Bearer ${INTERNAL_BACKEND_TOKEN}` (constant-time compare via `hmac.compare_digest`).
   - `GET /paper/{paper_id}/text` (query: `user_id`) — wraps `get_paper_meta` + `get_paper`; returns sanitized payload; 404 if not owned.
   - `POST /usage/reserve` body `{ user_id, paper_id, kind, model? }` → `{ token, remaining }`. Wraps `reserve_usage` (resolves model via `enforce_model` if provided).
   - `POST /usage/release` body `{ user_id, paper_id, kind, token }`. Wraps `release_usage`.
   - `GET /figure/{paper_id}/{figure_id}` — owner-checked PNG bytes.
   - `POST /cached-analysis/upsert` body `{ user_id, paper_id, key, value }` — for streaming routes to persist final assembled JSON.
2. Wire the new router in `backend/app/main.py`.
3. Document `INTERNAL_BACKEND_TOKEN` in `backend/.env.example`.

**Acceptance**

- `curl https://<vercel>/api/health/llm` returns `{ok: true}` against AI Gateway.
- `curl -H "Authorization: Bearer $TOK" https://<railway>/api/internal/paper/<id>/text?user_id=<u>` returns paper text.
- KV roundtrip works.
- No Vercel route is calling Anthropic from the browser.

---

### Stage 2 — Migrate `selection-stream` (Explain / Derive / Followup)

**Goal:** Selection panel streams from Next.js + AI SDK, returning structured `ContentBlock[]`, with usage reserve/release through Python.

**Tasks**

1. Define schemas in `frontend/src/lib/server/schemas.ts` (Zod):

```ts
const Prose = z.object({ kind: z.literal("prose"), markdown: z.string() });
const Math = z.object({ kind: z.literal("math"), display: z.boolean(), tex: z.string() });
const Code = z.object({ kind: z.literal("code"), lang: z.string().optional(), text: z.string() });

export const ContentBlock: z.ZodType<ContentBlockT> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    Prose, Math, Code,
    z.object({ kind: z.literal("list"), ordered: z.boolean(), items: z.array(z.array(ContentBlock)) }),
    z.object({ kind: z.literal("quote"), blocks: z.array(ContentBlock) }),
  ])
);

export const SelectionExplainResult = z.object({
  action: z.enum(["explain", "derive", "followup"]),
  body: z.array(ContentBlock),
  assumptions: z.array(z.object({
    type: z.enum(["explicit", "implicit"]),
    statement: z.string(),
    significance: z.string().optional(),
  })).default([]),
  steps: z.array(z.object({
    step_number: z.number().int().positive(),
    prompt: z.array(ContentBlock),
    answer: z.array(ContentBlock),
    explanation: z.array(ContentBlock),
    hint: z.string().optional(),
  })).default([]),
});
```

2. Create prompts in `frontend/src/lib/server/prompts/selection.ts`:
   - One short system prompt per action (`explain`, `derive`, `followup`).
   - Use the single rule from `.cursor/rules/latex.mdc` instead of the old `LATEX_FORMAT_INSTRUCTIONS` blob.

3. Create `frontend/src/app/api/papers/[id]/selection-stream/route.ts`:
   - `POST`. Reads body `{ selected_text, action, question? }`. Validates action ∈ {`explain`, `derive`, `followup`}.
   - `requireUser()`; `fetchPaperContext()`; `reserveUsage()`.
   - Calls `streamObject({ model: getModel("fast"), schema: SelectionExplainResult, system, prompt })`.
   - Returns `result.toTextStreamResponse()` or `toUIMessageStreamResponse()` (verify by reading `node_modules/ai/dist/docs/`).
   - On `onFinish`, `after()` → `releaseUsage()` and KV-cache the assembled object for 1h.
   - Errors: 4xx forwarded with structured detail; 5xx wraps Anthropic error map similar to `_raise_for_anthropic`.

4. Frontend consumer:
   - Create `frontend/src/lib/useSelectionThread.ts` — replaces dual streaming logic in `BottomPanel.handleFollowUp` and `paper/[id]/page.tsx`. Wraps `useObject` (or current AI SDK equivalent) against `SelectionExplainResult`.
   - Single source of truth: `{ messages, current, status, start, abort, focusHistory }`.
   - Persist history in zustand `selectionHistory` slice.

5. Update Selection panel to render `ContentBlock[]` via a minimal inline renderer (finalize in Stage 4).

6. Mark Python `selection-stream` deprecated; delete in Stage 8.

**Acceptance**

- 5 sample papers (`docs/test-papers.md` — create with at least 5 `paper_id`s) render Explain / Derive / Followup correctly. No literal `$`, stable streaming, assumptions and steps populate.
- Abort on tab switch cleanly cancels upstream.
- Usage counters update via internal endpoint.
- Free-tier cap returns 403 `{ code: "tier_locked" }`; daily cap returns 429 `{ code: "daily_cap" }`.

---

### Stage 3 — Migrate `summary-stream` and `figure-qa-stream`

**Goal:** Summary streams partial fields progressively (huge UX win); figure QA runs through AI SDK vision.

**Tasks**

1. Add to `frontend/src/lib/server/schemas.ts`:

```ts
export const PaperSummary = z.object({
  overview: z.array(ContentBlock).default([]),
  motivation: z.array(ContentBlock).default([]),
  key_contributions: z.array(z.array(ContentBlock)).default([]),
  methodology: z.array(ContentBlock).default([]),
  main_results: z.array(ContentBlock).default([]),
  discussion: z.array(ContentBlock).default([]),
  limitations: z.array(z.array(ContentBlock)).default([]),
  future_work: z.array(ContentBlock).default([]),
  key_equations: z.array(z.object({ tex: z.string(), meaning: z.array(ContentBlock) })).default([]),
  key_figures_and_tables: z.array(z.object({ id: z.string(), description: z.array(ContentBlock) })).default([]),
});

export const FigureAnalysis = z.object({
  description: z.array(ContentBlock),
  key_observations: z.array(z.array(ContentBlock)),
  methodology_shown: z.array(ContentBlock).optional(),
  relation_to_paper: z.array(ContentBlock),
  takeaway: z.array(ContentBlock).optional(),
  answer: z.array(ContentBlock).optional(),
});
```

2. Create `frontend/src/app/api/papers/[id]/summary-stream/route.ts` using `streamObject` against `PaperSummary`. Persist final via internal `/cached-analysis/upsert`.

3. Create `frontend/src/app/api/papers/[id]/figure-qa-stream/route.ts`:
   - Pulls PNG via `fetchFigurePng`.
   - Uses `streamObject` with `FigureAnalysis`; image content array per AI SDK message format.
   - Resize via Python internal endpoint with `?max_dim=1024`, or `sharp` server-side.

4. Migrate `SummaryPanel.tsx` to `useObject` against `PaperSummary`. Render fields progressively. Replace `Md` with `RichContent` (Stage 4).

5. Migrate `FiguresPanel.tsx` figure-QA invocation to the new endpoint.

6. Backend: keep `POST /api/papers/{id}/summary` (non-stream) for dashboard preload. Have it return cached value only (no LLM); if missing, return 202 with hint to use stream.

7. Old Python streaming routes (`/papers/{id}/summary-stream`, `/papers/{id}/figure-qa-stream`) — leave in place for one deploy; remove in Stage 8.

**Acceptance**

- `SummaryPanel` shows fields populating in order.
- Figure analysis matches semantically (smoke test on 3 figures).
- Abort works on both.

---

### Stage 4 — Structured rendering: kill `preprocessLatex` for migrated paths

**Goal:** one component renders all migrated content (`ContentBlock[]`); KaTeX renders math directly; no delimiter detection.

**Tasks**

1. Create `frontend/src/components/analysis/RichContent.tsx`:
   - Props: `{ blocks: ContentBlock[]; streaming?: boolean }`.
   - `prose`: `react-markdown` with **only** `remark-gfm` (no `remark-math`, no `rehype-katex`). Sanitize hrefs as in `Md.tsx`.
   - `math`: render via `katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: false })`, wrap in styled container that handles overflow.
   - `code`: `<pre><code>` with current syntax styling.
   - `list`: `<ul>` / `<ol>`; each item recursively renders `RichContent`. Math nodes nest correctly — that's the (f) fix.
   - `quote`: `<blockquote>` recursing into `RichContent`.
   - When `streaming=true`, append a single cursor span after the last block.
2. Create `frontend/src/components/analysis/StreamingMarkdown.tsx` wrapping `RichContent` with cursor + "streaming…" badge logic (replaces four ad-hoc copies).
3. Runtime guard: if `prose.markdown` contains `$`, log a warning (KV counter `lint:prose_dollar`) and strip — do not parse.
4. Keep `frontend/src/lib/latex.ts:preprocessLatex` and `Md.tsx` only for the Notes path. Add deprecation comment.
5. Delete uses of `Md` from migrated panels.
6. CSS: ensure `overflow-x-auto` math containers don't break accordion height — set `min-w-0` on flex parents. (e) fix.

**Acceptance**

- Visual regression on the 5 sample papers from Stage 2: zero literal `$`, zero glyph-per-line, math wraps inside accordion correctly.
- `RichContent` is the only renderer in `SelectionResultPanel`, `SummaryPanel`, `QAPanel`, `AssumptionsPanel`, `FiguresPanel`, `RelatedWorkPanel`.
- `Md` referenced only by Notes.
- 30s summary stream shows progressive fields, no flicker.

---

### Stage 5 — Analysis pane full refactor

**Goal:** small set of primitives, consistent visual language, shrink the giant components.

**Primitives (`frontend/src/components/analysis/`)**

1. `AnalysisSection.tsx` — `<section>` + `SectionHeader` + spacing.
2. `AnalysisCard.tsx` — card shell. Variants: `default`, `accent`, `compact`.
3. `AnalysisAccordionRow.tsx` — keep current; harmonize props.
4. `AnalysisTabs.tsx` — config-driven. `TabSpec = { id, label, feature?, pinned?, badge?, icon? }`. Renders lock icon when `feature` fails `canAccess(tier, feature)`.
5. `OverflowMenu.tsx` — base-ui `Popover` wrapper. Replaces 80-line portaled menu.
6. `useSelectionThread.ts` — see Stage 2.
7. `useStreamingObject.ts` — generic hook wrapping `useObject` with abort + idempotency-key + zustand persistence.
8. `RichContent.tsx`, `StreamingMarkdown.tsx` — Stage 4.

**Refactor targets**

- `BottomPanel.tsx` → ≤ 200 LOC. Composition: `<AnalysisTabs/>` + `<OverflowMenu/>` + tab content slots.
- `SelectionResultPanel.tsx` → ≤ 250 LOC. Thread reconstruction in `useSelectionThread`. Card shells `AnalysisCard`.
- `SummaryPanel.tsx` → ≤ 160 LOC. Array-driven section loop; streaming partial fields via `useObject(PaperSummary)`.
- `QAPanel.tsx` → replace bespoke card + Md with `AnalysisCard` + `RichContent`. Reduce by ≥ 100 LOC.
- `AssumptionsPanel.tsx`, `RelatedWorkPanel.tsx`, `FiguresPanel.tsx` — same primitives.

**Visual rules** — see `.cursor/rules/analysis-pane.mdc`.

**Behavioral rules**

- Pin Selection tab when history non-empty.
- Lazy-mount tabs on first visit, then keep mounted (owned by `AnalysisTabs`).
- Position cycle (right/bottom/left) lives in `OverflowMenu`.
- Font scale lives in `OverflowMenu`. Persist via existing zustand slice.
- Keyboard shortcuts in `KeyboardShortcuts.tsx` continue to work.

**Acceptance**

- Component LOC budgets met (or document why exceeded).
- Manual checklist: tab switch, font scale, panel position cycle, history-thread focus, follow-up flow, abort, error states, tier-lock state.

---

### Stage 6 — Vercel Cron + KV rate limit + Fluid

**Goal:** kill the in-process trial-cleanup loop; replace the broken in-memory rate limiter; ensure Fluid is on.

**Tasks**

1. `frontend/src/app/api/cron/cleanup-trial/route.ts`:
   - Daily cron in `vercel.json`.
   - Auth via `CRON_SECRET`.
   - Calls Python `/api/internal/admin/cleanup-trial` (new internal endpoint wrapping existing RPC + disk cleanup).
2. Add the internal endpoint in `backend/app/api/internal.py`. Keep `_trial_cleanup_loop` as fallback gated by env `KNOW_DISABLE_INTERNAL_CRON_FALLBACK`.
3. Trial rate limiter migration:
   - Add `frontend/src/app/api/trial/rate-check/route.ts`: KV-backed `@upstash/ratelimit` (sliding window, 5 / 1h per IP). Honor first hop of `x-forwarded-for`.
   - Update Python's `_check_trial_rate` to first try this Next.js endpoint (if `KNOW_TRIAL_RATELIMIT_URL` set), fall back to Supabase RPC, fail closed if neither. Remove the in-memory deque entirely.
4. Confirm Fluid Compute matchers in `vercel.json` cover all migrated streaming routes. Set generous `maxDuration` (e.g. 300s).

**Acceptance**

- Cron entry visible in Vercel; logs show daily run.
- Trial rate limit survives a Vercel redeploy.
- 60s+ Sonnet streams complete without timeout.

---

### Stage 7 — AI Gateway + observability

**Goal:** all model calls go through Gateway; provider/model switch is one env change.

**Tasks**

1. Default `getModel()` to use `@ai-sdk/gateway` when `AI_GATEWAY_API_KEY` (or OIDC) is present.
2. Configure model slugs per role via env. Document in `frontend/.env.example`.
3. Enable Anthropic prompt caching on system prompt blocks per AI SDK provider options.
4. Add KV-backed caching layer for non-streaming completions (suggested questions, term explainer).
5. Add `@vercel/speed-insights` (analytics already on).
6. Add `frontend/src/lib/server/observability.ts` with `recordLlmCall({role, model, paperId, durationMs, status})`; structured JSON logs; optional KV daily counters.

**Acceptance**

- Gateway dashboard shows traffic.
- Setting `MODEL_ANALYSIS=opus` env routes everything to Opus. No code change.
- `recordLlmCall` events visible in logs.

---

### Stage 8 — Cleanup

**Goal:** delete dead code and update docs.

**Tasks**

1. Delete `LocalModelProvider` and references (`backend/app/services/llm.py`, `backend/app/config.py:KNOW_LOCAL_MODEL_*`).
2. Delete `LATEX_FORMAT_INSTRUCTIONS` from Python paths that no longer use it.
3. Delete `_normalize_latex_delimiters` from migrated paths (keep one copy for Notes).
4. Delete deprecated streaming routes in `backend/app/api/papers.py`.
5. Delete `frontend/src/lib/selectionSse.ts` if nothing imports it.
6. Update `README.md`: remove Ollama / qwen sections; add Vercel + AI SDK + AI Gateway sections; add Vercel env list.
7. Update `docs/PRODUCTION_LAUNCH_GUIDE.md`.
8. `git grep -i "ollama\|qwen\|local model"` — should return zero outside historical comments.
9. Verify `frontend/AGENTS.md` and `CLAUDE.md` references still apply.

**Acceptance**

- `git grep` clean for the dead names.
- Docs match reality.
- `cd frontend && npm run lint && npm run build` passes.
- A fresh deploy with only the Vercel env list works end-to-end.

---

## 9. Definition of done (whole project)

A user can:

1. Sign up.
2. Upload a PDF.
3. See a paper render.
4. Click a passage → Explain streams in with no literal `$`, no glyph salad, math overflows nicely, derivation steps work.
5. Open Summary → fields populate progressively over ~30s.
6. Ask a question → answer streams.
7. Switch papers → no stale state bleeds.
8. Hit the free-tier cap → see a structured upgrade prompt.

Operationally:

- AI Gateway dashboard shows model traffic and per-call cost.
- KV holds the trial limiter and a token cache.
- Cron runs daily.
- A model swap is one env variable.
- `LocalModelProvider` is gone.

## 10. How to invoke Composer 2 per stage

Hand each stage as a separate task with this preamble:

> You are implementing **Stage N** of the brief at `docs/COMPOSER_BRIEF.md`. Read the brief, especially §§3, 4, 5, 6, the stage's tasks and acceptance criteria, and the per-stage git workflow in §11. Open one PR with title `[stage N] <short>`. Do not start adjacent stages. If any assumption from §7 is invalid, stop and report.

## 11. Per-stage git workflow (REQUIRED — commit and push after every stage)

After completing each stage's tasks and verifying acceptance:

```bash
git status                                 # confirm only intended files changed
git add <files>                            # stage explicitly; never blanket `git add .` if untracked noise exists
git commit -m "[stage N] <short title>

<optional body explaining why, not what>
"
git push origin <branch>                   # if on a feature branch
# OR open a PR:
git push -u origin HEAD
gh pr create --title "[stage N] <short>" --body "Closes stage N. Acceptance: <list>."
```

Rules:

- **Never `git push --force` to `main`.**
- **Never amend a commit that has been pushed** unless the user explicitly asks.
- **Never skip hooks** (`--no-verify`, `--no-gpg-sign`).
- **Never commit `.env`, credentials, service-role keys, or `INTERNAL_BACKEND_TOKEN`**. If a secret-looking file appears in `git status`, stop and ask.
- **Stage-N commits stay scoped to stage N.** If you noticed unrelated cleanup mid-stage, leave it for a follow-up.
- **One PR per stage.** Don't pile stages into one branch.
- **After push:** verify with `git status` and `git log -1` that the commit is on the remote.

