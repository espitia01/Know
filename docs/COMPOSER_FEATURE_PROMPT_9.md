# Know — feature briefing #9 for Composer 2.5

> **Scope**: six net-new features. Three small ones first (section-aware Summary excerpt, Researcher "Deep analysis" toggle, workspace provenance polish), one S2-backed enrichment (Cited-by), one new persistence surface (highlights), and one big lift (retrieval-backed Q&A with pgvector). Land them in this order so each track's tests can stand alone and a failure later doesn't bury earlier wins.
>
> **Stack reminders**: Next.js 16 + AI SDK v6 + Zod 4 on Vercel; Python FastAPI on Railway; Supabase Postgres (with `pgvector` after Track D) + Upstash Redis. Streaming/structured AI runs in Next route handlers via the AI Gateway. Batch/upload/billing/gating stays in Python. Tier gating is **always** authoritative in `backend/app/gating.py`. Never duplicate gating logic in TypeScript.
>
> **Rules to keep in mind** — read first:
> - `.cursor/rules/architecture.mdc` (streaming on Next, batch on Python, no local model, HMAC for server→Python)
> - `.cursor/rules/analysis-pane.mdc` (reuse `AnalysisSection` / `AnalysisCard` / `AnalysisTabs` / `OverflowMenu` / `StreamingMarkdown`; no new design tokens or motion durations; panel host LOC budgets)
> - `.cursor/rules/latex.mdc` (math in `$...$` / `$$...$$` markdown for migrated streaming paths; do NOT re-introduce `preprocessLatex` / `remark-math` on those routes)
>
> **Test plan**: after each track, `cd frontend && npm run lint && npm run build`. For backend changes, `cd backend && pytest -q tests`. Manually smoke each surface in the IDE preview against at least two papers in a session. **After each track lands**, commit with a `feat(...)` message scoped to that track. **After all tracks pass**, push `main` to `origin/main`.
>
> **Order**: A → B → E → F → C → D (small, no-schema work first; pgvector last because the migration is the riskiest single change).
>
> **What NOT to do this round**: Markdown / PDF export of notes + selections is explicitly out of scope; existing BibTeX export is the only export surface. Don't extend it.

---

## Snapshot of the touched surfaces

| Track | Concern | Primary files |
|---|---|---|
| A | Section-aware Summary context | `frontend/src/lib/server/paperExcerpt.ts` (new), `frontend/src/lib/server/prompts/summary.ts`, `frontend/src/lib/server/prompts/selection.ts`, `frontend/src/lib/server/prompts/figure.ts` |
| B | Researcher "Deep analysis" toggle | `backend/supabase/migrations/0NN_deep_analysis.sql` (new), `backend/app/api/settings.py`, `backend/app/api/internal.py`, `backend/app/gating.py`, `backend/app/services/llm.py`, `frontend/src/lib/server/userPrefs.ts` (new helper), `frontend/src/lib/UserSettingsContext.tsx`, `frontend/src/app/settings/page.tsx`, every migrated stream route under `frontend/src/app/api/papers/[id]/*-stream/route.ts` |
| E | Workspace cross-paper provenance polish | `frontend/src/components/sidebar/CrossPaperPanel.tsx`, `frontend/src/lib/store.ts`, `backend/app/services/db.py` (saved workspace round-trip) |
| F | Cited-by via Semantic Scholar | `backend/app/services/citation_resolve.py`, `backend/app/api/analysis.py` (new endpoint), `frontend/src/lib/api.ts`, `frontend/src/components/sidebar/RelatedWorkPanel.tsx` (or new `CitedByPanel.tsx`), `frontend/src/components/panel/BottomPanel.tsx` |
| C | Persistent highlights | `backend/supabase/migrations/0NN_highlights.sql` (new), `backend/app/api/papers.py` (new highlight CRUD), `backend/app/services/db.py`, `frontend/src/lib/api.ts`, `frontend/src/components/pdf/SelectionToolbar.tsx`, `frontend/src/components/pdf/PdfViewer.tsx`, `frontend/src/components/sidebar/HighlightsPanel.tsx` (new), `frontend/src/components/panel/BottomPanel.tsx`, `frontend/src/lib/store.ts` |
| D | Retrieval-backed Q&A | `backend/supabase/migrations/0NN_paper_chunks.sql` (new, pgvector), `backend/app/config.py`, `backend/app/services/embeddings.py` (new), `backend/app/services/retrieval.py` (new), `backend/app/services/llm.py` (Q&A + figure-QA paths), `backend/app/api/papers.py` (post-upload embed hook), `backend/app/api/internal.py` (retrieve endpoint for Next streams), `frontend/src/lib/server/retrieval.ts` (new helper that calls `/api/internal/retrieve`), `frontend/src/app/api/papers/[id]/figure-qa-stream/route.ts`, `frontend/src/lib/server/prompts/figure.ts` |

Do **not** revert earlier patterns: `useShallow` selectors, per-paper analysis slices, `papersFreshness`, `StreamingMarkdown`, `RichContent`, `OverflowMenu`, `mergeCachedAnalysis`, `pendingNavRef` (just-shipped fix for workspace tab races), section-aware Prepare excerpt, Anthropic prompt caching. Build on top.

---

## Track A — section-aware Summary excerpt (carry Prepare's win into Summary)

### Goal
Summary today head-truncates `raw_text` to 8,000 chars before either prompt runs. On long papers that wipes out methodology, results, and discussion. Port the Python section-aware extractor (`backend/app/services/paper_excerpt.py::build_prepare_excerpt`) to TypeScript so the migrated Summary route picks abstract + intro + methods + results + discussion + conclusion instead of just the head slice. Reuse the helper for selection and figure-Q&A context too — they currently also head-slice.

### Implementation

#### A1. New `frontend/src/lib/server/paperExcerpt.ts`

Port the Python algorithm. Heading regex must accept the same shapes (`## Abstract`, `1 Introduction`, `IV. Methods`, `Methods`, `Conclusion`, etc.). Generalize the priority weights so Summary can ask for "methods + results heavy" instead of Prepare's "intro + conclusion heavy".

```ts
export type ExcerptProfile = "prepare" | "summary" | "selection";

export function buildPaperExcerpt(
  rawText: string,
  opts: { maxChars: number; profile: ExcerptProfile },
): string;
```

- `profile: "summary"` — full body of abstract, methodology, results, discussion, conclusion; first 2 paragraphs of everything else.
- `profile: "prepare"` — full body of abstract, introduction, conclusion, future work; truncated bodies elsewhere (mirror current Python behavior).
- `profile: "selection"` — full body of abstract and introduction; everything else takes its first paragraph only. Keep budget tight (the selection itself dominates).

When fewer than two headings parse, fall back to `rawText.slice(0, maxChars)`. Strip control characters and zero-width chars at the boundary (same banned set as `_sanitize_user_text`).

#### A2. Wire it into Summary

In `frontend/src/lib/server/prompts/summary.ts`:

```ts
import { buildPaperExcerpt } from "@/lib/server/paperExcerpt";

const PAPER_CHAR_BUDGET = 18000; // up from 8000

function buildContext(paperTitle: string, paperContext: string): string {
  const titleLine = paperTitle ? `Paper title: ${paperTitle}\n\n` : "";
  const excerpt = buildPaperExcerpt(paperContext || "", {
    maxChars: PAPER_CHAR_BUDGET,
    profile: "summary",
  });
  return titleLine + `Paper content (excerpt — section-aware):\n"""\n${excerpt}\n"""`;
}
```

Reuse the same helper in `frontend/src/lib/server/prompts/selection.ts` (`profile: "selection"`, keep `PAPER_CONTEXT_CHAR_BUDGET = 6000`) and `frontend/src/lib/server/prompts/figure.ts` (`profile: "summary"`, `PAPER_CHAR_BUDGET = 6000`).

#### A3. Tests

Add `frontend/src/lib/server/__tests__/paperExcerpt.test.ts` (Vitest scaffold under `frontend/src/lib/server/__tests__/`; if Vitest isn't wired up, add the runner — `npm i -D vitest @vitejs/plugin-react jsdom` and a minimal `vitest.config.ts`):

- Long paper (~80k chars) with `## Methods` and `## Results` → output of `profile: "summary"` contains both headings' full body.
- Paper with **no** headings → fallback head slice equals `rawText.slice(0, maxChars)`.
- `profile: "prepare"` matches the Python output's set of selected sections on the same input (compare against a fixture; you can dump one from Python with `python -m app.services.paper_excerpt …`).

### Acceptance

- Long Methods/Results-heavy papers produce a Summary `methodology` and `main_results` that actually quote the corresponding sections instead of paraphrasing abstract content.
- `npm run lint && npm run build` clean.
- No backend changes in this track. Prepare still uses Python's `build_prepare_excerpt` unchanged.

### Commit
`feat(summary): section-aware excerpt for streaming summary, selection, and figure Q&A`

---

## Track B — Researcher "Deep analysis" opt-in (bigger budgets, prompt-cache friendly)

### Goal
Researcher-tier users can opt into materially larger prompt budgets for Summary, selection, single-paper Q&A, figure Q&A, and assumptions. Below Researcher, the toggle is hidden. Anthropic prompt caching keeps the marginal cost reasonable since the system blocks don't change between calls.

**Cost discipline**: every Deep budget is exactly **2× standard** — clean ratio so users can predict their bill. Deep also **doubles per-call quota consumption** (a Deep Q&A consumes 2 units of the paper's Q&A budget, a Deep selection consumes 2 selection slots, etc.) so paper-scoped tier caps still bound spend.

### Implementation

#### B1. Schema

`backend/supabase/migrations/0NN_deep_analysis.sql`:

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deep_analysis_enabled boolean NOT NULL DEFAULT false;
```

No RLS change needed — `users` rows are already user-owned.

#### B2. Settings endpoints

In `backend/app/api/settings.py`:

- Extend the `GET /api/settings` response with `deep_analysis_enabled` and a derived `deep_analysis_allowed` boolean (true only when the resolved tier is `researcher`).
- Extend the PATCH payload model to accept `deep_analysis_enabled: bool | None`. If a non-Researcher attempts to set it true, return `403` with `code: "feature_locked"`. Free/Scholar can set it false (idempotent no-op).

In `backend/app/gating.py`, add:

```python
def resolve_deep_analysis(user_id: str) -> bool:
    """Researcher-only opt-in; everyone else returns False."""
    user = get_user_row(user_id)
    if not user:
        return False
    if (user.get("tier") or "free") != "researcher":
        return False
    return bool(user.get("deep_analysis_enabled"))
```

#### B3. Per-feature budget table

In `backend/app/services/llm.py` add at the top of the file:

```python
# Standard budgets — match today's behavior (post-Track-A excerpt).
STD_BUDGETS = {
    "summary":   {"context": 12000, "selection": 0,     "history": 0},
    "selection": {"context": 6000,  "selection": 4000,  "history": 0},
    "qa":        {"context": 6000,  "selection": 0,     "history": 0},
    "figure":    {"context": 6000,  "selection": 0,     "history": 0},
    "assumptions": {"context": 6000, "selection": 0,    "history": 0},
}
# Deep budgets — exactly 2× standard so cost stays predictable and the
# settings UI can show a single multiplier instead of a per-feature table.
DEEP_MULTIPLIER = 2

def _scale(budget: dict, factor: int) -> dict:
    return {k: (v * factor if v else 0) for k, v in budget.items()}

DEEP_BUDGETS = {k: _scale(v, DEEP_MULTIPLIER) for k, v in STD_BUDGETS.items()}

def get_budgets(kind: str, user_id: str | None) -> dict:
    deep = bool(user_id) and resolve_deep_analysis(user_id)
    return (DEEP_BUDGETS if deep else STD_BUDGETS).get(kind, STD_BUDGETS["qa"])

def get_usage_multiplier(user_id: str | None) -> int:
    """How many units a single call charges against the paper's quota."""
    return DEEP_MULTIPLIER if (user_id and resolve_deep_analysis(user_id)) else 1
```

Refactor each batch function (`extract_assumptions`, `answer_questions`, `summarize_paper`, `analyze_selection`, `analyze_figure`) to call `get_budgets(...)` and use that for `_sanitize_user_text` / slice operations. Keep the prompt body unchanged.

#### B4. Next.js streaming routes

The migrated streams need the same flag. Expose it through the internal API.

In `backend/app/api/internal.py`, extend `GET /api/internal/user/{user_id}/preferences` to return:

```python
return {
    "analysis_model": ...,
    "fast_model": ...,
    "tier": ...,
    "deep_analysis": resolve_deep_analysis(user_id),
}
```

(If that route doesn't exist, add it — HMAC-protected.)

In `frontend/src/lib/server/userPrefs.ts` (new) wrap the call with a 60-second LRU cache (use `lru-cache` if already in deps; otherwise a `Map` with timestamp suffices — same pattern as `papersFreshness.ts`).

In every migrated stream route (`selection-stream`, `summary-lite-stream`, `summary-stream`, `figure-qa-stream`) call `fetchUserPrefs(userId)` before building the prompt and pass `deepAnalysis` into the prompt builder. Prompts default to the standard budgets and bump to deep when `deepAnalysis === true`.

#### B5. Quota consumption: 1 unit standard, 2 units deep

In `backend/app/gating.py::reserve_usage` (or wherever the per-paper count is tallied), accept the call site's resolved multiplier and pass it through to the increment. Every call site in `backend/app/api/analysis.py` and `backend/app/api/papers.py` that does `reserve_usage(..., action, count=1)` (or relies on the default) becomes:

```python
units = get_usage_multiplier(user_id)
token = reserve_usage(user_id, paper_id, action, model=..., count=units)
```

For migrated streaming routes, the Next.js side already reserves via `/api/internal/usage/reserve`. Extend that payload with `units: number` so the route can stamp the right multiplier (the Next route resolves `deepAnalysis` from `fetchUserPrefs(userId)` already — Track B4).

When the paper's per-paper Q&A / selection cap is, say, 20: standard fits **20** calls, deep fits **10**. Same for selections, figure-Q&A, assumptions.

#### B6. Frontend settings UI

In `frontend/src/app/settings/page.tsx`, add a new card right after the Models section:

- Heading: **"Deep analysis (Researcher)"**
- One-line body: "Use 2× larger prompt budgets across Summary, Selection, Q&A, Assumptions, and Figure Q&A — more of the paper reaches the model. Each call consumes 2× your per-paper quota."
- Toggle bound to `deep_analysis_enabled`; disabled (with lock icon + tooltip) when `deep_analysis_allowed === false`.
- **Live cost-estimate block** rendered directly below the toggle, two columns:

  ```
  Standard                                  Deep (2×)
  ───────────────────────────────────       ───────────────────────────────────
  Q&A         20 / paper                    Q&A         10 / paper
  Selections  30 / paper                    Selections  15 / paper
  Figure Q&A  10 / paper                    Figure Q&A   5 / paper
  Context     ~3k tokens / call             Context     ~6k tokens / call
  ```

  The left column reads the user's actual `TIER_LIMITS` from `/api/settings` → `tier_limits`. The right column applies the multiplier client-side. **Do not** hardcode numbers; if `TIER_LIMITS` changes in `gating.py`, the UI follows.
- Reuse the existing toggle primitive — do not introduce a new switch component.

In `frontend/src/lib/UserSettingsContext.tsx` expose:

```ts
deepAnalysis: boolean;
deepAnalysisAllowed: boolean;
deepMultiplier: number;        // currently 2; comes from /api/settings
setDeepAnalysis(next: boolean): Promise<void>;
```

The setter PATCHes `/api/settings` and updates context optimistically.

#### B7. Surface the state in the analysis pane

Two quiet affordances when deep analysis is on:

1. **Header chip** next to the existing usage indicator: `Q&A 3/10 · Deep` (note that the denominator already reflects the effective cap, since reservation consumes 2 units). Style as `text-[var(--text-xs)] text-muted-foreground/70`. No new color.
2. **One-line note** under the Summary and Q&A input areas: `"Deep mode — each call uses 2× your quota."` Same muted styling.

Neither affordance is a new component; both reuse existing typography utilities. Keep the analysis pane LOC budgets intact.

### Acceptance

- Free/Scholar accounts never see the toggle; PATCH attempts return 403 (`code: "feature_locked"`).
- Researcher toggle ON → next Summary stream sends exactly **2×** the standard context (verify byte count in route logs).
- Researcher toggle ON → a single Q&A call decrements the paper's Q&A budget by **2**, not 1 (verify via `/api/usage` or DB).
- Toggle OFF → behavior matches today exactly (Track A excerpt still applies; only the budget multiplier changes).
- Cost-estimate block in Settings updates in real time when the toggle flips.
- Prompt caching still hits (the system block is unchanged between calls; only the user block grows).
- `pytest backend/tests` and `cd frontend && npm run lint && npm run build` clean.

### Commit
`feat(researcher): deep analysis toggle expands prompt budgets across migrated routes`

---

## Track E — workspace cross-paper provenance polish

### Goal
`CrossPaperPanel` already stamps `asked_against` / `asked_against_titles` / `created_at` on every result (commit `043fdda`). What's still missing:

1. **Stale-membership chip** when current session diverges from the result's `asked_against`.
2. **Persist results** with saved workspaces server-side so reload doesn't lose them when no workspace is saved (currently `crossPaperResults` is in `partialize`, but the moment a workspace is opened we `clearCrossPaperResults` — and saved workspaces should round-trip their stored answers).
3. **One-click pin** to rerun the same question against the current session.

### Implementation

#### E1. Stale chip

In `CrossPaperPanel.tsx`, when rendering each result item, compare `result.asked_against` (sorted) against `currentSig`:

```tsx
const sessionSig = [...paperIds].sort().join(",");
const askedSig = (result.asked_against ?? []).slice().sort().join(",");
const stale = askedSig && askedSig !== sessionSig;
```

Render the chip in the result card header:

```tsx
{stale && (
  <span
    className="rounded-md border border-border/55 bg-muted/[0.08] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/85"
    title={`Asked against: ${(result.asked_against_titles ?? []).join(" • ")}`}
  >
    Stale membership
  </span>
)}
```

#### E2. Saved-workspace round-trip

Verify `backend/app/services/db.py` already stores `cross_paper_results` JSONB on workspace save (the migration column exists). If `save_workspace` / `update_workspace` don't accept the field, plumb it through. On `list_workspaces` / `load_workspace`, return it verbatim and let the frontend's `applyWorkspaceSession` (in `frontend/src/lib/workspaceSessionLoad.ts`) keep using it.

If the server `cross_paper_results` schema doesn't yet include `asked_against` / `asked_against_titles` / `created_at`, **do not** drop those fields on round-trip — JSONB persistence makes them survive. Add a server-side soft-validation: if any saved item lacks `asked_against`, fill it with the workspace's `paper_ids` (best-effort backfill).

#### E3. "Re-run on current session" button

Each result card gets a small ghost button (next to delete) labeled `Rerun against current session`. Disabled when `!stale` (no membership change to justify rerun). On click:

```ts
handleAsk(result.question);
```

(Use the existing `handleAsk` already defined in `CrossPaperPanel.tsx`.)

### Acceptance

- Ask "compare methods" with `[A, B, C]`; remove C → the existing result now shows a "Stale membership" chip and a Rerun button.
- Click Rerun → a fresh result lands beneath the stale one with `asked_against: [A, B]`.
- Save a workspace with cross-paper history, reload, reopen the workspace → answers reappear with their provenance.
- No new colors or motion durations introduced.

### Commit
`feat(workspace): stale-membership chip and rerun affordance for cross-paper results`

---

## Track F — Cited-by via Semantic Scholar

### Goal
Show "Papers that cite this one" alongside the existing Related Work (outbound citations). Reuse the Semantic Scholar plumbing in `backend/app/services/citation_resolve.py` — we already hit `/paper/search`; add `/paper/{paperId}/citations`. Results live in `cached_analysis.cited_by` with a 7-day TTL so we don't hammer S2.

### Implementation

#### F1. Resolve the paper to S2

In `backend/app/services/citation_resolve.py` add:

```python
async def resolve_paper_s2_id(title: str, doi: str | None, arxiv: str | None) -> str | None:
    """Return the Semantic Scholar paperId for this manuscript."""
```

Prefer DOI/arXiv (use `/paper/DOI:...` or `/paper/arXiv:...`). Fall back to title search.

#### F2. Fetch cited-by

```python
async def fetch_cited_by(s2_id: str, limit: int = 50) -> list[dict]:
    """Hit /paper/{paperId}/citations and return [{title, year, authors, url, s2_id, citation_count}]."""
```

Use the existing `httpx.AsyncClient` pattern + `User-Agent` header. Cap at 50 to keep payloads small.

#### F3. New endpoint

In `backend/app/api/analysis.py`:

```python
@router.get("/{paper_id}/cited_by")
async def get_cited_by(paper_id: str, user_id: str = Depends(require_auth)):
    """Return cached cited_by; refetch if missing or > 7 days old."""
```

Reads `paper.cached_analysis.cited_by` if fresh, otherwise resolves S2 id (use the paper's `doi`/`arxiv`/`title` from `extract_metadata` output), fetches, writes back via `mutate_paper`.

#### F4. Frontend

Two options — pick one and stay consistent:

- **Preferred**: extend `RelatedWorkPanel.tsx` with a new `<AnalysisSection title="Cited by" count={citedBy.length}>` rendered above (or below) the existing outbound clusters. Lazy-load: don't fire the request until the Related tab is visible.
- **Alternative**: new tab `Cited by` under `BottomPanel.tsx`. Only do this if the Related tab feels overloaded; otherwise stick with the section.

Each row: `index. Author1, Author2 (Year) — Title  [↗︎ S2 link]`. Use `priorWorkExternalHref`-style logic to prefer DOI then S2 URL.

Add `api.getCitedBy(paperId)` to `frontend/src/lib/api.ts`.

#### F5. Empty / error states

- No S2 match → `EmptyState` with "Couldn't find this paper on Semantic Scholar."
- S2 returns zero citations → `EmptyState` "No known papers cite this one yet."

#### F6. Tier gating

Free tier already has Prepare/Related gated open as a freebie; Cited-by inherits the same gate. Don't introduce a new feature key.

### Acceptance

- Open a well-known paper that's clearly cited (e.g. anything from arXiv with > 100 cites) → Cited by section populates within ~3 s.
- Reopen the paper within 7 days → no S2 request fires (cache hit, verified in Network tab).
- S2 returns 429 → log it (structured `LLMProviderError`-shaped object, not `console.log`) and show a quiet retry banner.

### Commit
`feat(citations): cited-by enrichment via Semantic Scholar with 7-day cache`

---

## Track C — persistent highlights

### Goal
Selection underlines today come from past Explain/Derive results. They're not "highlights" — the user can't pick a passage and just mark it for later. Add first-class highlights: a new selection-toolbar action, server-persisted rows, colored rectangles in the PDF, and a Highlights panel where the user can manage them.

### Implementation

#### C1. Schema

`backend/supabase/migrations/0NN_highlights.sql`:

```sql
CREATE TABLE IF NOT EXISTS highlights (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  paper_id    TEXT NOT NULL,
  selected_text TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT 'yellow',
  note        TEXT,
  page_hint   INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_highlights_paper ON highlights(paper_id);

ALTER TABLE highlights ENABLE ROW LEVEL SECURITY;
CREATE POLICY highlights_own ON highlights FOR ALL
  USING (user_id = current_setting('app.user_id', true));
```

Allowed colors: `yellow`, `green`, `blue`, `pink`. Validate at the API layer (no enum needed in SQL).

#### C2. API

In `backend/app/api/papers.py` add a small router section:

- `POST /api/papers/{paper_id}/highlights` body `{ selected_text, color, note?, page_hint? }` → returns the new highlight row.
- `GET /api/papers/{paper_id}/highlights` → returns the list newest-first, capped at 200.
- `PATCH /api/papers/{paper_id}/highlights/{id}` body `{ color?, note? }`.
- `DELETE /api/papers/{paper_id}/highlights/{id}`.

Owner-check every call via the existing `_verify_paper_owner` helper. Sanitize `selected_text` (~4000 char cap) and `note` (~2000 char cap) with `_sanitize_user_text`.

Add helpers in `backend/app/services/db.py`: `list_highlights`, `create_highlight`, `update_highlight`, `delete_highlight`. Mirror the shape of existing per-paper CRUD.

#### C3. Frontend store

In `frontend/src/lib/store.ts`:

```ts
highlightsByPaper: Record<string, Highlight[]>;
setHighlightsForPaper: (paperId: string, highlights: Highlight[]) => void;
addHighlightForPaper: (paperId: string, highlight: Highlight) => void;
removeHighlightForPaper: (paperId: string, id: string) => void;
updateHighlightForPaper: (paperId: string, id: string, patch: Partial<Highlight>) => void;
```

Same per-paper-slot pattern as `selectionHistoryByPaper`. Persist nothing — always re-fetched from the server.

#### C4. Selection toolbar

In `frontend/src/components/pdf/SelectionToolbar.tsx`, add a new `Highlight` action with a small color-swatch sub-popover (4 colors). Default action when the user clicks the main Highlight button is `yellow`; the swatch opens via a separate caret button so single-tap is fast.

`SelectionAction` type gets `"highlight"` added but the page-level `handleSelectionAction` short-circuits before calling the selection-stream route — Highlights don't kick off Anthropic; they POST to `/highlights` and seed the store.

#### C5. PDF rendering

In `frontend/src/components/pdf/PdfViewer.tsx`, the existing `drawUnderlinesForPage` function knows how to anchor text via fuzzy match. Add a sibling `drawHighlightsForPage` that paints a translucent rectangle (`mix-blend-multiply` for paper-friendly readability) using the same anchoring approach. Wire it into the existing `drainPending` MutationObserver flow.

Color → Tailwind class map (these classes must already exist in the codebase; use the swatch classes from the selection toolbar):

- `yellow`: `bg-yellow-200/55 dark:bg-yellow-300/30`
- `green`:  `bg-emerald-200/55 dark:bg-emerald-300/30`
- `blue`:   `bg-sky-200/55 dark:bg-sky-300/30`
- `pink`:   `bg-pink-200/55 dark:bg-pink-300/30`

If any of those aren't already used somewhere, fall back to existing accent tokens — do not add new colors per `.cursor/rules/analysis-pane.mdc`. (The swatch picker may already define them; check before adding.)

#### C6. Highlights panel

New `frontend/src/components/sidebar/HighlightsPanel.tsx`. Mount it as a sub-tab inside the Notes tab using `AnalysisTabs` so we don't blow the tab-row LOC budget. Inside, render each highlight as an `AnalysisCard` (`compact` variant): the verbatim selected text, color chip, optional note (editable inline), delete affordance. Empty state: "No highlights yet — pick a passage in the PDF and choose a color from the toolbar."

When the panel mounts, dispatch `api.listHighlights(paperId)` once and hydrate the store; subsequent visits read from the store.

#### C7. Hydration

On reader page load (`paper/[id]/page.tsx`), kick off `api.listHighlights(paperId)` alongside the existing data fetch and hydrate `highlightsByPaper`. Use the same per-paper freshness gate so paper switches don't refetch.

### Acceptance

- Select text → toolbar shows Highlight with swatch → click → colored rectangle persists, panel updates immediately.
- Reload the reader → highlight survives, renders at the right anchor (allowing for the same fuzzy-match latitude as selection underlines).
- Delete from panel → rectangle disappears.
- Inline note edit saves on blur (PATCH).
- Switching papers shows the right paper's highlights only — no bleed.
- `npm run lint && npm run build` clean. `BottomPanel.tsx` stays under its 200-LOC budget (the Notes / Highlights split must live inside Notes via `AnalysisTabs`, not as new top-level tabs).
- `pytest backend/tests` clean — add a test for create/list/update/delete covering owner enforcement.

### Commit
`feat(highlights): persistent passage highlights with PDF rendering and panel`

---

## Track D — retrieval-backed Q&A (RAG via pgvector + embeddings provider)

### Goal
Q&A (single-paper and cross-paper) and figure Q&A stop head-truncating `raw_text`. Instead, on upload we chunk the paper, embed each chunk, store in `paper_chunks` with pgvector. At question time, embed the query and retrieve the top-N matching chunks, pass them as context. Long papers stop "forgetting" their Methods/Results. This is textbook **Retrieval-Augmented Generation (RAG)**: retrieve relevant passages → augment the generator's prompt → Claude generates the answer.

**Provider decision — OpenAI.** Anthropic doesn't ship an embeddings API. We're shipping with **OpenAI `text-embedding-3-small` (1536 dim)**: ~$0.02 per million input tokens, plenty of headroom for academic text, single new env var. Keep the implementation provider-agnostic so a future swap to Voyage AI (1024 dim, Anthropic's recommended partner) is one env-var change plus a re-migration of the embedding column — but **do not ship a Voyage code path now**; OpenAI is the only adapter that needs to work end-to-end.

**Track D works fine without an OpenAI key** (head-truncation fallback), so deploys missing the key still serve Q&A — they just don't get the retrieval upgrade.

### Implementation

#### D1. Schema

`backend/supabase/migrations/0NN_paper_chunks.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS paper_chunks (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  paper_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  section     TEXT,
  text        TEXT NOT NULL,
  embedding   vector(1536) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_paper_chunks_paper ON paper_chunks(paper_id);
CREATE INDEX idx_paper_chunks_vec   ON paper_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

ALTER TABLE paper_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY paper_chunks_own ON paper_chunks FOR ALL
  USING (user_id = current_setting('app.user_id', true));

CREATE OR REPLACE FUNCTION match_paper_chunks(
  query_embedding vector(1536),
  paper_ids       text[],
  match_count     int
)
RETURNS TABLE (id text, paper_id text, chunk_index int, section text, text text, distance float4)
LANGUAGE sql STABLE AS $$
  SELECT id, paper_id, chunk_index, section, text,
         (embedding <=> query_embedding) AS distance
  FROM paper_chunks
  WHERE paper_id = ANY(paper_ids)
  ORDER BY embedding <=> query_embedding ASC
  LIMIT match_count;
$$;
```

Embedding dim **1536** to match OpenAI `text-embedding-3-small`. If you swap providers later, write a migration to rebuild the index at a new dim — don't try to make it dynamic now.

#### D2. Embedding provider (OpenAI — only adapter shipped)

Add to `backend/app/config.py`:

```python
KNOW_EMBEDDING_PROVIDER = os.getenv("KNOW_EMBEDDING_PROVIDER", "openai")  # only "openai" is implemented this round
KNOW_EMBEDDING_MODEL    = os.getenv("KNOW_EMBEDDING_MODEL", "text-embedding-3-small")
KNOW_OPENAI_API_KEY     = os.getenv("KNOW_OPENAI_API_KEY", "")
```

Schema dim is **1536** to match `text-embedding-3-small`. Keep it pinned — do not try to make the column dimension dynamic. If a future operator swaps embedding providers, they own the column-recreate migration.

New `backend/app/services/embeddings.py`:

```python
class EmbeddingProviderError(Exception):
    def __init__(self, code: str, message: str, model: str | None = None):
        self.code, self.message, self.model = code, message, model

async def embed_batch(texts: list[str]) -> list[list[float]]:
    """Return one embedding per input. Batches up to 128 per request."""

async def embed_query(text: str) -> list[float]:
    """Single-query convenience wrapper."""
```

Implementation:

- `POST https://api.openai.com/v1/embeddings` with `model = KNOW_EMBEDDING_MODEL`, `input = texts`. Auth header `Authorization: Bearer ${KNOW_OPENAI_API_KEY}`.
- 30s `httpx.AsyncClient` timeout. Retry once on 429 with a 2s backoff (no retry on 4xx other than 429).
- Strip any text > 8000 chars per element before sending.
- If `KNOW_EMBEDDING_PROVIDER != "openai"` → `EmbeddingProviderError("unsupported_provider", ...)` so a misconfigured env fails loudly instead of silently degrading.
- If `KNOW_OPENAI_API_KEY` is empty → `EmbeddingProviderError("disabled", "no OpenAI key configured")`. The caller (D5) catches and falls back to head-truncation.

Surface failures as `EmbeddingProviderError(code, message, model)` mirroring `LLMProviderError`. No new requirement in `backend/requirements.txt` — `httpx` is already there.

#### D3. Chunker + retrieval service

`backend/app/services/retrieval.py`:

```python
def chunk_paper(raw_text: str, *, target_chars: int = 1100, overlap: int = 200) -> list[dict]:
    """Section-aware chunking — emit dicts {chunk_index, section, text}."""

async def build_chunks_for_paper(paper_id: str, user_id: str, raw_text: str) -> int:
    """Idempotent: delete existing rows for this paper, then write new ones. Returns count."""

async def retrieve_for_paper(
    paper_ids: list[str], query: str, top_k: int = 12, max_chars: int = 14000
) -> tuple[str, list[dict]]:
    """Return (joined_context, hit_metadata). Joined context is '\n\n---\n\n'-separated chunk text capped at max_chars."""
```

Section-aware chunking reuses the heading regex from `paper_excerpt.py` so each chunk carries its section label (helps with citation in answers).

#### D4. Post-upload hook + backfill

In `backend/app/api/papers.py::upload`, after the paper is parsed and stored, fire-and-forget:

```python
asyncio.create_task(_safe_build_chunks(paper.id, user_id, paper.raw_text))
```

Where `_safe_build_chunks` swallows `EmbeddingProviderError` and logs structured. Add an internal admin endpoint `POST /api/internal/papers/{id}/embed` (HMAC-protected) so a backfill script can replay over existing papers.

#### D5. Wire retrieval into Q&A paths

In `backend/app/services/llm.py`:

- `answer_questions(paper_text, questions, user_id, paper_id=None)`: if `paper_id` and `KNOW_OPENAI_API_KEY` are set, call `retrieve_for_paper([paper_id], " ".join(questions))` and use the returned context **instead of** the head-sliced `paper_text`. On `EmbeddingProviderError` (or empty result), fall back to today's `paper_text[:6000]`.
- `answer_questions_multi(...)`: retrieve per question (or per workspace) using all session paper ids; budget split per paper unchanged. Log retrieval hit-count.
- `analyze_figure(...)`: same — retrieve against the question, otherwise fall back to `paper_text[:4000]`.

Update the route signatures in `backend/app/api/analysis.py` to pass `paper.id` (or list of session paper ids) into the LLM calls.

For Next-side `figure-qa-stream/route.ts` (also a Q&A path), call a new internal endpoint:

```
POST /api/internal/retrieve
{ paper_ids: [pid], query: "...", top_k: 12, max_chars: 14000 }
→ { context: string, hits: { paper_id, chunk_index, section }[] }
```

Then pass the returned `context` into `buildFigureQAPrompt` instead of `paper.raw_text`.

#### D6. Frontend signals

In Q&A, figure Q&A, and cross-paper results, add a quiet footer line `"Context drawn from N passages"` when retrieval succeeded. When it didn't (fallback fired), no footer — silent degrade.

#### D7. Tests

`backend/tests/test_retrieval.py`:

- `chunk_paper` produces non-overlapping chunk indices with text that's never empty.
- `retrieve_for_paper` returns at most `top_k` rows and only for the requested paper ids.
- With `KNOW_OPENAI_API_KEY` unset, the helpers raise the expected error and Q&A still returns a valid (head-truncated) answer.

### Acceptance

- Upload a 40-page paper → `paper_chunks` row count > 30 within a few seconds; verify via SQL.
- Ask a Q&A question whose answer lives on page 20 → answer correctly quotes that section (would not happen with the old 6k head slice).
- Disable `KNOW_OPENAI_API_KEY` locally → Q&A still works on the head-truncation fallback; no 500s.
- Cross-paper Q&A on three papers retrieves chunks from all three; the footer reports "N passages from 3 papers."
- pgvector index hit verified in `EXPLAIN`. `lists = 100` is fine for the early scale; document a rebuild step for when row count > 1M.

### Commit
`feat(qa): pgvector-backed retrieval for single- and cross-paper Q&A with graceful fallback`

---

## Operator runbook — Composer must produce this

After all tracks are committed, write a single file **`docs/PROMPT_9_RUNBOOK.md`** with the contents below, then commit it with message `docs(prompt-9): operator runbook for migrations and env vars`. **Print the same content verbatim in the final chat reply** so the operator sees it without opening the file.

The runbook is the operator's one-stop guide for everything outside source code: Supabase migrations to apply, env vars to set, and how to verify each track is live. Use the exact section structure below — the operator scans by heading.

### Runbook content (fill in concrete file names as you go)

```markdown
# Prompt 9 — Operator runbook

Apply these steps **in order** after pulling `main`. Total time: 10–15 minutes plus deployment.

## 1. Supabase migrations

Three new migrations were added under `backend/supabase/migrations/`. Apply them in numeric order:

| File | Track | What it does |
|---|---|---|
| `014_deep_analysis.sql` | B | Adds `users.deep_analysis_enabled boolean default false` |
| `015_highlights.sql`    | C | Creates `highlights` table + RLS + 1 index |
| `016_paper_chunks.sql`  | D | Enables `pgvector`, creates `paper_chunks` table + ivfflat index + `match_paper_chunks` RPC |

### Apply via Supabase CLI (recommended)

```bash
cd backend
supabase link --project-ref <your-project-ref>   # one-time, skip if already linked
supabase db push
```

### Or apply via Dashboard SQL Editor

1. Open Supabase → SQL Editor.
2. For each file above (014 → 015 → 016), paste the file contents and click **Run**. Order matters.
3. After `016_paper_chunks.sql` runs, verify pgvector is on: Database → Extensions → search "vector" → should show **Enabled**. (The migration enables it; this step is only verification.)

### Verify each migration

```sql
-- 014: column exists, default false
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'deep_analysis_enabled';

-- 015: table + RLS
SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'highlights';

-- 016: extension + table + RPC
SELECT extname FROM pg_extension WHERE extname = 'vector';
SELECT relname FROM pg_class WHERE relname = 'paper_chunks';
SELECT proname FROM pg_proc WHERE proname = 'match_paper_chunks';
```

All four queries should return non-empty rows.

## 2. Environment variables

Set on the **Python backend** (Railway → Service → Variables). The Vercel side needs **no new vars** for this prompt.

| Variable | Required? | Value | Why |
|---|---|---|---|
| `KNOW_OPENAI_API_KEY` | **Yes for Track D** | Your OpenAI key starting with `sk-...` | Generates embeddings for RAG. Get it from platform.openai.com → API keys. |
| `KNOW_EMBEDDING_PROVIDER` | No | `openai` (default) | Pin to `openai`. Other values currently error out. |
| `KNOW_EMBEDDING_MODEL` | No | `text-embedding-3-small` (default) | Don't change unless you also redo the `016` migration at a different `vector(N)` dim. |

If you do not set `KNOW_OPENAI_API_KEY`, Tracks A, B, C, E, F all work. Track D silently falls back to head-truncation — Q&A still answers, just without retrieval. **No 500 errors either way.**

### Where to set them

- Production: Railway → your backend service → Variables → New Variable.
- Local dev: `backend/.env`.

Restart the backend after setting them so `app/config.py` picks them up.

## 3. Backfill existing papers (Track D only)

New uploads chunk + embed automatically. Papers uploaded **before** this prompt won't have rows in `paper_chunks`, so their Q&A still uses head-truncation fallback. Two options:

### Option A — lazy backfill (do nothing)

Existing papers degrade gracefully. Next time a user opens an old paper and asks a question, you can add a one-shot endpoint call (see Option B). Cheapest.

### Option B — bulk backfill script

Run this once after the migrations:

```bash
cd backend
python -m app.scripts.embed_backfill --batch 50
```

Composer ships this script as `backend/app/scripts/embed_backfill.py`. It walks `papers`, skips any that already have `paper_chunks` rows, embeds the rest, and logs progress.

Cost estimate: ~$0.0004 per paper × your library size. 1000 existing papers ≈ $0.40 in OpenAI charges, one-time.

## 4. Smoke-test each track

Open the app and verify:

- **Track A** — Open a long paper, run Summary. Methodology / Results sections quote concrete content from those sections, not just abstract paraphrase.
- **Track B** — Settings → Deep analysis toggle is visible only as Researcher. Flipping it on shows the 2× cost-estimate block. After enabling, the reader header shows `Q&A 0/10 · Deep` (capped halves).
- **Track C** — Select text in the PDF → toolbar shows the new Highlight action with color swatch. Reload → highlight persists.
- **Track D** — Ask a Q&A question about something on the last page of a long paper. Answer quotes that section. Bottom of the answer reads `"Context drawn from N passages"`.
- **Track E** — In a 3-paper session, ask a cross-paper question, remove one paper, see the **Stale membership** chip + Rerun button.
- **Track F** — Open a well-known paper in Related tab → **Cited by** section populates within a few seconds.

## 5. Rollback notes

- Tracks A, B, E, F are all pure code; reverting the commits is enough.
- Track C: dropping the `highlights` table deletes user data — do not drop on rollback unless that's the intent.
- Track D: dropping `paper_chunks` is safe (re-embeds on next upload). Dropping the `vector` extension is also safe but unnecessary; leave it on.
```

End of runbook content. Make sure the file is committed before the final `git push origin main`.

---

## Closing checklist (apply after every track lands)

1. `cd frontend && npm run lint && npm run build`
2. `cd backend && pytest -q tests`
3. `git add` only files relevant to the just-finished track, commit with the track's prescribed message.
4. Smoke each surface in the IDE preview against ≥ 2 real papers. Record any deviations in `docs/COMPOSER_FEATURE_PROMPT_9.md`'s closing notes section (append-only) so the next round of work knows what landed.

## After all six tracks are committed

```bash
git checkout main
git push origin main
```

If any track has to be skipped (e.g. Track D blocked on missing `KNOW_OPENAI_API_KEY` in the env), commit the others, push, and leave a single-line note at the bottom of this file under a new `## Carry-over` section so the next round can pick it up. Do not push a half-implemented track — feature-flag it off, or revert it, or skip it cleanly.

**Do not** force-push. **Do not** rebase main. **Do not** introduce new design tokens, motion durations, or shadow utilities. **Do not** reintroduce local-model code paths, `preprocessLatex` on migrated routes, or `console.log` in production code paths.
