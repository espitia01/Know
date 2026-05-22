# Know — feature briefing #10 for Composer 2.5

> **Scope**: three reader-side features that each plug into infrastructure that already exists. **Continue-reading memory** uses one tiny new table and reuses the per-paper hydration path. **Citation graph** is pure presentation over data Prepare and Cited-by already produce. **Anchored Q&A** is the most involved — it threads retrieval hits from Track D all the way through the Q&A response into a clickable "show passage" affordance in the PDF.
>
> **Stack reminders**: Next.js 16 + AI SDK v6 + Zod 4 on Vercel; Python FastAPI on Railway; Supabase Postgres (with `pgvector` since #9) + Upstash Redis. Streaming/structured AI runs in Next route handlers via the AI Gateway. Batch/upload/billing/gating stays in Python. Tier gating is authoritative in `backend/app/gating.py`. Never duplicate gating logic in TypeScript.
>
> **Rules to read first**:
> - `.cursor/rules/architecture.mdc` (streaming on Next, batch on Python, no local model, HMAC for server → Python)
> - `.cursor/rules/analysis-pane.mdc` (reuse `AnalysisSection` / `AnalysisCard`-style cards / data-driven tab strip / `OverflowMenu` / `StreamingMarkdown`; no new design tokens or motion durations; panel host LOC budgets)
> - `.cursor/rules/latex.mdc` (math in `$...$` / `$$...$$` markdown for migrated streaming paths; do NOT re-introduce `preprocessLatex` / `remark-math` on those routes)
>
> **Test plan**: after each track, `cd frontend && npm run lint && npm run build && npm run test`. For backend changes, `cd backend && pytest -q tests`. Manually smoke each surface in the IDE preview against at least one long paper and one workspace with two papers. **After each track lands**, commit with a `feat(...)` message scoped to that track. **After all tracks pass**, push `main` to `origin/main`.
>
> **Order**: B → A → C. B is the smallest (one migration, two endpoints, one hook). A is frontend-only over existing data. C is the largest because it threads through Python's Q&A response, the persisted `qa_sessions` shape, and the PdfViewer anchoring machinery.
>
> **What NOT to do**:
> - Don't add new design tokens, motion durations, or shadow vars (`.cursor/rules/analysis-pane.mdc` is explicit).
> - Don't add a graph-rendering library. The graph is small (≤ ~100 nodes) and the codebase already paints custom SVG overlays in `PdfViewer`. Hand-rolled SVG is the right tool here.
> - Don't reintroduce `preprocessLatex` / `remark-math` anywhere new. Q&A answers already pass through `StreamingMarkdown` → `RichContent`; keep it that way.
> - Don't bypass `_verify_paper_owner` on any new endpoint. Every per-paper read/write is owner-checked.
> - Don't add another export surface (BibTeX remains the only one).

---

## Snapshot of the touched surfaces

| Track | Concern | Primary files |
|---|---|---|
| B | Continue-reading memory | `backend/supabase/migrations/017_reading_state.sql` (new), `backend/app/api/papers.py`, `backend/app/services/db.py`, `frontend/src/lib/api.ts`, `frontend/src/hooks/useReadingState.ts` (new), `frontend/src/components/pdf/PdfViewer.tsx`, `frontend/src/components/panel/BottomPanel.tsx`, `frontend/src/app/paper/[id]/page.tsx`, `frontend/src/lib/store.ts` |
| A | Citation graph | `frontend/src/components/sidebar/CitationGraph.tsx` (new), `frontend/src/components/sidebar/RelatedWorkPanel.tsx`, `frontend/src/lib/priorWorkLinks.ts` |
| C | Anchored Q&A | `backend/app/services/llm.py` (retrieval plumbing through `answer_questions` / `answer_questions_multi`), `backend/app/models/schemas.py` (`QAItem.sources`), `backend/app/api/analysis.py`, `backend/app/services/retrieval.py`, `frontend/src/lib/api.ts`, `frontend/src/components/sidebar/QAPanel.tsx` (or wherever the panel lives), `frontend/src/components/sidebar/CrossPaperPanel.tsx`, `frontend/src/components/pdf/PdfViewer.tsx`, `frontend/src/lib/store.ts` |

Do not revert: per-paper `*ByPaper` slices, `useShallow` selectors, `pendingNavRef` (workspace tab race fix), the structured `ContentBlock[]` schema for migrated streaming routes, Anthropic prompt caching, deep-analysis 2× multiplier, post-Prompt-9 highlights + Cited-by + RAG retrieval. Build on top.

---

## Track B — "Continue reading" memory (last page + last tab, per paper)

### Goal
When a user reopens a paper, drop them back where they were. Today every reopen lands on page 1 and the first tab (`prepare`). We persist the last-viewed page, the last open analysis tab, and a fractional scroll offset, per (`user_id`, `paper_id`), and restore on paper load. Cross-device sync is the reason this lives server-side, not localStorage.

### Implementation

#### B1. Schema

`backend/supabase/migrations/017_reading_state.sql`:

```sql
CREATE TABLE IF NOT EXISTS paper_reading_state (
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  paper_id    TEXT NOT NULL,
  last_page   INTEGER NOT NULL DEFAULT 1,
  last_tab    TEXT,
  scroll_pct  REAL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, paper_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_reading_state_user
  ON paper_reading_state(user_id, updated_at DESC);

ALTER TABLE paper_reading_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS paper_reading_state_own ON paper_reading_state;
CREATE POLICY paper_reading_state_own ON paper_reading_state FOR ALL
  USING (user_id = current_setting('app.user_id', true));
```

Composite PK by `(user_id, paper_id)` so upserts are a one-row write per save and a missing row means "first visit".

Validation:

- `last_page` must be ≥ 1. Clamp at API layer.
- `last_tab` must be one of the analysis tab ids (`prepare` | `summary` | `assumptions` | `qa` | `notes` | `figures` | `selection` | `cross` | `related`). Reject anything else.
- `scroll_pct` is a 0–1 float; clamp.

#### B2. Backend

In `backend/app/services/db.py`:

```python
ALLOWED_READING_TABS = frozenset({
    "prepare", "summary", "assumptions", "qa", "notes",
    "figures", "selection", "cross", "related",
})

def get_reading_state(user_id: str, paper_id: str) -> dict | None: ...
def upsert_reading_state(user_id: str, paper_id: str, *,
    last_page: int, last_tab: str | None, scroll_pct: float | None) -> dict | None: ...
```

In `backend/app/api/papers.py` add a small router section right after the highlights CRUD:

- `GET /api/papers/{paper_id}/reading-state` → returns `{ last_page, last_tab, scroll_pct, updated_at }` or 404 (treat as "first visit").
- `PUT /api/papers/{paper_id}/reading-state` body `{ last_page, last_tab?, scroll_pct? }`.

Both owner-checked via `_verify_paper_owner`. Reject `last_tab` not in `ALLOWED_READING_TABS` with 400.

**Do not** reserve usage for these endpoints. They are bookkeeping, not LLM calls.

#### B3. Frontend store + hook

In `frontend/src/lib/store.ts` add a per-paper slot:

```ts
readingStateByPaper: Record<string, { last_page: number; last_tab: string | null; scroll_pct: number | null } | null>;
setReadingStateForPaper: (paperId: string, state: ...) => void;
```

New hook `frontend/src/hooks/useReadingState.ts`:

```ts
export function useReadingState(paperId: string): {
  saveProgress: (patch: { last_page?: number; last_tab?: string; scroll_pct?: number }) => void;
}
```

- Internally maintains a 1500 ms debounced writer per paper.
- Drops writes when the patch matches the last sent payload (avoids hammering the API on a slow scroll).
- Uses `navigator.sendBeacon` on `beforeunload` to flush a pending save, but only if the payload is JSON-serializable and small (it always is here).
- Reads pre-hydrate from the store; subsequent updates merge.

#### B4. PdfViewer wiring

`PdfViewer.tsx` already tracks the current scroll position to draw region highlights. Pipe the visible-page number and the scroll fraction (scrollTop / scrollHeight) through `useReadingState(paperId).saveProgress`. Throttle the page-change reporter so the side-effect only fires once the page is steady for ~300 ms (avoids stamping every page the user scrolls past in a fast skim).

#### B5. BottomPanel wiring

`BottomPanel.tsx` knows which analysis tab is active (it dispatches `setActiveTab`). On a deliberate user-driven change (not the initial mount), call `saveProgress({ last_tab: nextTab })`.

#### B6. Restore on load

In `frontend/src/app/paper/[id]/page.tsx`'s data-load effect (right next to the highlights hydration block we added at the end of Prompt 9):

1. After the paper context is fetched, call `api.getReadingState(paperId)`.
2. If it returns a state:
   - Dispatch `setActiveTab(state.last_tab)` (only if `state.last_tab` is in `ALLOWED_READING_TABS`).
   - Imperatively scroll the PDF: prefer `last_page` (jump to page N) and then apply `scroll_pct` for the fine offset.
3. If 404 / empty, leave defaults alone.

The restore must be **idempotent** — if the user has clicked another tab in the 200 ms it takes to hydrate, do not yank them back. Implement with a `restoredRef.current` guard the same way `auto-analyze` does it.

#### B7. Privacy + cleanup

`paper_reading_state` is per-user, owner-RLS'd; when a paper is deleted (ON DELETE for `users` cascades; on paper delete there's no FK to `papers`, so we add `ON DELETE` indirectly via `user_id`). To clean up rows for a deleted paper, add a one-liner to the paper-delete handler in `papers.py`:

```python
client.table("paper_reading_state").delete().eq("user_id", user_id).eq("paper_id", paper_id).execute()
```

### Acceptance

- Open a paper, scroll to page 7, click "Summary" tab, close the tab.
- Reopen → lands on page 7 with Summary tab active.
- Same paper from a different device / private window after sign-in → also lands on page 7.
- Deleting the paper removes its reading-state row.
- `npm run lint && npm run build && npm run test` clean. `pytest backend/tests` clean.

### Commit
`feat(reading-state): persist last page + tab per paper and restore on reopen`

---

## Track A — Citation graph (Related pane)

### Goal
Replace the flat "Related" list with a small interactive graph that shows both directions of the citation relationship at once. Center node is the current paper. Outbound citations (from Prepare's `prior_work`) fan out one way; inbound citations (from Cited-by) fan out the other. Hover highlights a row, click opens the external link. Toggle to fold back to the existing list view for keyboard / accessibility.

### Implementation

#### A1. Data shape

No new endpoints. The panel already loads `preReading.prior_work` (and `prior_work_topics`) for outbound, and `api.getCitedBy(paperId)` for inbound. Merge them into a single in-component data structure:

```ts
type GraphNode = {
  id: string;            // stable: doi || arxiv || s2_id || title
  label: string;         // first author + year, or title fallback
  href: string | null;   // priorWorkExternalHref output
  direction: "self" | "outbound" | "inbound";
  bib_label?: string;
  citation_count?: number;
};
```

`self` = the current paper, centered. Cap outbound at 30 and inbound at 30 to keep the graph readable; if the source list is longer, the remainder collapses into an "+ N more" pill that opens the existing flat list. The graph is for orientation, not exhaustive citation accounting — the list view stays available below.

#### A2. Layout

Hand-rolled SVG. **Do not** add `d3`, `react-force-graph`, or any other layout library. Use a deterministic concentric layout:

- Center node at `(cx, cy)`.
- Outbound on a left arc (e.g. angles 110° → 250°), inbound on a right arc (290° → 70°).
- Node positions are deterministic from `(direction, index, total)` so re-renders don't shift the graph.
- One straight edge per citation, semi-transparent, styled with the same `[data-action]` color variables we already use for selection highlights — outbound edges use `--highlight-rgb` from `[data-action="explain"]` (blue), inbound from `[data-action="followup"]` (teal). No new colors.

Render order: edges first (so they sit behind nodes), then nodes, then labels. Labels render only on hover/focus to keep the graph readable when both sides have 20+ nodes.

#### A3. Interaction

- Hover or keyboard-focus a node → label appears, edge brightens, the corresponding `<li>` in the flat list (still mounted below, collapsed by default in graph mode) scrolls into view and highlights for 1.5 s.
- Click a node → `window.open(href, "_blank", "noopener")` if `href`, otherwise toast "No link for this citation".
- Click the center node → no-op (it's the current paper).
- Toggle button in the section header switches between **Graph** and **List** modes. Persist the choice in `useStore.uiPrefs.relatedView` (`"graph" | "list"`, default `"graph"` for tiers that have Cited-by data, `"list"` otherwise).

#### A4. Empty / degraded states

- Outbound only (e.g. Cited-by 404'd or returned `s2_not_found`): render the graph with only the outbound arc; show a muted note "No citing papers found on Semantic Scholar."
- Inbound only (extremely rare — Prepare hasn't run): render only inbound arc; CTA to run Prepare.
- Neither: fall back to the existing `EmptyState`.

#### A5. Accessibility

- Each node is a `<button>` (or `<a>` when `href` is non-null) with an explicit `aria-label="${direction} — ${label}"`.
- Arrow-key navigation within the SVG: Left/Right cycles outbound, Up/Down cycles inbound. Implement with a `roving tabindex` pattern, no new dep.
- Keyboard users get the same hover behavior (focus event triggers the same handler).

#### A6. Performance

- Memoize the layout: `useMemo(() => computePositions(nodes), [nodesSig])` keyed on a hash of `(id, direction)` so a single new node from a cited-by refresh doesn't reflow the whole graph.
- No animations on layout. The only motion is the existing `motion-safe:duration-150` color fade on hover.

### Acceptance

- Open a paper with both Prepare + Cited-by populated → both arcs render within 100 ms after the data lands.
- Hover an outbound node → label appears, list view scrolls to that entry below.
- Click an inbound node with a DOI → opens DOI in a new tab.
- Toggle to List mode → graph collapses, existing list view renders unchanged.
- Re-render after Cited-by cache refresh → no layout jump.
- `npm run lint && npm run build` clean. New file stays under 250 LOC.

### Commit
`feat(citations): interactive Related-pane graph combining Prepare and Cited-by`

---

## Track C — Anchored Q&A (sources panel + "show passage" in PDF)

### Goal
After Prompt 9, Q&A already uses retrieval — `answer_questions` calls `retrieve_for_paper` and stuffs the matched chunks into the prompt. The user sees a polished answer but loses the line back to the underlying paper. Anchor every Q&A answer to the chunks that fed it: the panel renders a "Sources" footer with one chip per chunk (snippet preview + similarity), and clicking a chip scrolls the PDF to the source text and briefly highlights it. Same affordance applies to cross-paper Q&A (chips include which paper the snippet came from).

This is the largest track because it threads retrieval metadata through Python's Q&A response → cached_analysis → the panel → PDF anchoring.

### Implementation

#### C1. Schema (Pydantic, not SQL)

`backend/app/models/schemas.py`:

```python
class QASourceHit(BaseModel):
    paper_id: str
    chunk_index: int
    snippet: str          # ~240 chars from the matched chunk
    section: str | None = None
    similarity: float | None = None

class QAItem(BaseModel):
    question: str
    answer: str
    sources: list[QASourceHit] = []  # NEW
```

No DB migration — `qa_sessions` is already JSONB; new field rides along transparently.

#### C2. Retrieval plumbing

In `backend/app/services/retrieval.py::retrieve_for_paper`, the returned hits already carry `paper_id`, `chunk_index`, `similarity`. Extend the meta items with a truncated snippet (240 chars, stripped of leading section heading if present) and `section`:

```python
meta.append({
    "paper_id": hit.get("paper_id"),
    "chunk_index": hit.get("chunk_index"),
    "snippet": snippet[:240].strip(),
    "section": hit.get("section"),
    "similarity": (1.0 - float(dist)) if dist is not None else None,
})
```

(`snippet` is the same chunk text we already cap with `max_chars`. Be careful not to double-truncate.)

In `backend/app/services/llm.py::answer_questions`, capture the hits and zip them onto each output item. The current `_safe_parse_json` flow loses non-LLM data on parse, so weave the hits in **after** parsing:

```python
ctx_block, hits = ("", [])
if paper_id:
    try:
        from .retrieval import retrieve_for_paper
        ctx_block, hits = await retrieve_for_paper(
            [paper_id], " ".join(questions), max_chars=ctx_cap,
        )
    except Exception:
        ctx_block, hits = "", []
# ... existing prompt build with ctx_block ...
parsed = _safe_parse_json(raw)
items = parsed.get("items") if isinstance(parsed, dict) else None
if not isinstance(items, list):
    return parsed
# Stamp the same retrieval hits onto every answer. The model didn't pick
# per-question hits — Track D retrieves once for the whole batch — so each
# answer carries the same set. Cheap and honest. A future iteration can
# re-rank per question if needed.
for it in items:
    it["sources"] = hits
return {"items": items}
```

`answer_questions_multi` follows the same shape but the hits come from per-paper retrieval calls, each tagged with their `paper_id`. Stamp each answer with the **union** of hits.

#### C3. API surface

`/api/papers/{id}/qa` already returns `QAResponse(items=[QAItem(...)])`. With the schema change, sources flow through automatically. No new route.

For the **persisted** `qa_sessions` JSON in `cached_analysis`, the existing append-capped path stores whatever `resp.model_dump()` produces — sources ride along for free. Confirm with `pytest`.

#### C4. Frontend types

`frontend/src/lib/api.ts`:

```ts
export interface QASourceHit {
  paper_id: string;
  chunk_index: number;
  snippet: string;
  section?: string | null;
  similarity?: number | null;
}

export interface QAItem {
  // existing fields unchanged
  sources?: QASourceHit[];
}
```

#### C5. UI: sources footer

In the Q&A panel renderer (find the component that maps `qaResultsByPaper[paperId]` to cards — it lives under `frontend/src/components/sidebar/`; pick the existing one rather than creating a new card primitive), add a footer block per answer when `sources?.length > 0`:

```tsx
<div className="mt-2 flex flex-wrap gap-1.5">
  {(item.sources ?? []).slice(0, 6).map((s, i) => (
    <button
      key={`${s.paper_id}-${s.chunk_index}`}
      type="button"
      onClick={() => showPassage(s)}
      className="..."
      title={s.snippet}
    >
      {i + 1}. {s.section || `chunk ${s.chunk_index}`}
      {typeof s.similarity === "number" ? ` · ${Math.round(s.similarity * 100)}%` : ""}
    </button>
  ))}
</div>
```

Reuse existing chip styling (the "Stale membership" chip from `CrossPaperPanel` is a close template). **Do not** add new color or shadow tokens.

#### C6. "Show passage" → PDF anchor

Add a tiny store slice:

```ts
pendingPassageByPaper: Record<string, { snippet: string; ts: number } | null>;
setPendingPassage: (paperId: string, snippet: string | null) => void;
```

The Q&A panel's `showPassage(s)` writes the snippet (and sets the active paper if cross-paper Q&A is firing for a different paper id).

`PdfViewer.tsx` watches `pendingPassageByPaper[paperId]` with `useShallow`. When it changes:

1. Reuse the existing fuzzy anchor machinery in `drawUnderlinesForPage` (same NFKC normalize → bracket match) — extract a helper `findPassageRange(textLayer, snippet)` so both the underline painter and the passage scroller call into one place.
2. Scroll the matched range into view (`scrollIntoView({ behavior: "smooth", block: "center" })`).
3. Paint a temporary overlay (1.5 s, `motion-safe:duration-150` color fade-out only — no new motion) using the existing `know-selection-overlay` class with `data-action="followup"` so we reuse the same teal tint.
4. Clear the pending value once handled to avoid re-anchoring on re-render.

Cross-paper case: if `s.paper_id !== activePaperId`, switch to that paper first (via the existing `handleSwitchPaper`), then queue the pending passage so it fires after the new PdfViewer mounts.

#### C7. Multi-paper anchoring

For cross-paper Q&A, each source chip needs to show **which paper** it came from (paper title chip + chunk label). On click, switch the active paper before scrolling. Use the existing `pendingNavRef` pattern (the workspace-tab race fix) so a fast click sequence doesn't get clobbered by URL sync.

#### C8. Telemetry / cost

No new spend — retrieval already runs per Q&A in Prompt 9. We're just surfacing data we already paid for. The chip click is a free DOM operation.

### Acceptance

- Ask a single-paper Q&A on a long paper with retrieval enabled (OpenAI key set). Answer renders, "Sources" chips appear below it within the same render tick (no extra round trip).
- Click chip → PDF scrolls to a passage, brief teal overlay flashes, then fades. Overlay is gone within 2 s.
- Reload the page → cached `qa_sessions` rehydrates the answer **and** the chips.
- Cross-paper Q&A in a 3-paper workspace: chips correctly label the source paper. Clicking a chip for paper B switches the active paper and then scrolls.
- Disable retrieval (unset `KNOW_OPENAI_API_KEY`, redeploy Python) → the answer still renders, but the chips footer is absent (no sources). No console errors.
- `pytest backend/tests` clean (add a small unit test that asserts `answer_questions` items carry a `sources` list when retrieval returns hits).
- `npm run lint && npm run build && npm run test` clean.

### Commit
`feat(qa): anchored sources — link Q&A answers back to retrieved passages in the PDF`

---

## Wrap-up

After all three tracks land:

1. Write `docs/PROMPT_10_RUNBOOK.md` with:
   - Supabase migration to apply (`017_reading_state.sql`).
   - No new environment variables.
   - Smoke-test checklist mirroring the per-track Acceptance sections.
   - Rollback notes (drop new table; revert frontend graph component; the Q&A `sources` field is additive and safe to leave on rollback since clients ignore unknown fields).
2. Run `cd frontend && npm run lint && npm run build && npm run test` and `cd backend && pytest -q tests`. Both must be clean.
3. Verify the prior-work + cited-by surfaces still render correctly for a paper where Prepare returned nothing (defensive empty states).
4. Commit the runbook with `docs(runbook): operator notes for Prompt 10`.
5. Push `main` to `origin/main`.

### What this does not change

- Streaming/batch split is unchanged. Q&A remains a Python batch endpoint.
- Highlights, Cited-by, deep analysis, and RAG continue to work exactly as in Prompt 9.
- No new external services. No new env vars on Railway or Vercel.
- BibTeX remains the only export.
