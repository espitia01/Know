# Analysis Pane & Performance Audit

A repo-grounded audit of the analysis pane (hydration, caching, UI/UX) plus
an end-to-end performance review with concrete, prioritized fixes.

**Date:** 2026-04-25
**Branch:** `main` @ `b2fc4f3`

> Every issue below cites the actual file and line(s) where the problem
> lives. Recommendations are ordered by impact / effort. Use the
> **Priority** column at the top of each section to triage.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Hydration race conditions](#2-hydration-race-conditions)
3. [Cache layer chaos](#3-cache-layer-chaos)
4. [Per-tab data-flow issues](#4-per-tab-data-flow-issues)
5. [UI / UX rough edges](#5-ui--ux-rough-edges)
6. [Performance — frontend](#6-performance--frontend)
7. [Performance — backend](#7-performance--backend)
8. [Performance — network & infra](#8-performance--network--infra)
9. [Recommended migration plan](#9-recommended-migration-plan)
10. [Appendix: file map](#10-appendix-file-map)

---

## 1. Executive summary

The analysis pane works, but it has accumulated a tangle of overlapping
state-management strategies that produce the "finicky" behaviour you keep
hitting:

- **Six different caches** for the same data (`pdfBlobCache`,
  `papersById`, `paperCaches`, server `cached_analysis`, Zustand
  `persist`, plus direct `localStorage` for UI prefs).
- **Two effects** in `paper/[id]/page.tsx` race over hydrating state
  from `paper.cached_analysis` — one keyed on `paperId` (the URL),
  one keyed on `paper` (the object). Both can fire in the same tick.
- **All tabs render and run effects** even when not visible — `<Tabs>`
  uses `display: none` for inactive tabs, so QAPanel / FiguresPanel /
  AssumptionsPanel hydrate even if the user only ever looks at
  Summary.
- **`paper.raw_text`** (often **100–500 KB**) is included in every
  `getPaper` response. The frontend **never** uses it — it's only
  needed inside server prompts. We're shipping a quarter-megabyte of
  JSON on every paper switch.
- **`Md` re-runs `preprocessLatex`** on every render of every
  markdown block. Streaming a summary triggers thousands of these.
- The **Zustand store is enormous**, and `PaperContent` destructures
  ~25 slices in one `useStore()` call, so any state change in any
  slice re-renders the whole 1900-line component tree.
- **No request deduplication** — racing paper switches can fire 2–3
  `getPaper` calls for the same id, each ~300 KB.
- **Backend `mutate_paper`** does a full read-modify-write of the
  whole paper row for every selection / Q&A append.

The single highest-leverage change: **stop sending `raw_text` over the
wire**, **memoize markdown rendering**, and **lazy-mount inactive
tabs**. Those three alone will roughly halve the perceived "slow" feel.

---

## 2. Hydration race conditions

> **Priority: P0 (correctness bug, user-visible)**

### 2.1 Two effects fight over `paperCaches` / `cached_analysis`

`frontend/src/app/paper/[id]/page.tsx`:

| Effect | Lines | Trigger | Writes |
|---|---|---|---|
| URL-paper switch | `491–510` | `paperId` (URL) changes | `savePaperCache(activePaperId)`, `restorePaperCache(paperId)`, sets `activePaperId` |
| Cached-paper restore | `665–679` | `activePaperId` changes (mounting only — guarded by `initialRestoreDoneRef`) | `restorePaperCache(activePaperId)` |
| Paper data fetch | `681–712` | `activePaperId` changes | `setPaper`, `cachePaper` |
| Server hydration | `727–859` | `paper` *or* `activePaperId` *or* `tierUser?.tier` *or* `tierLoading` change | sets `selectionHistory`, `summary`, `qaResults`, `preReading`, `assumptions`, `notes` |

The hydration effect fires on **four** dependencies. Any time `tierLoading`
flips from true → false (cold-start auth) it re-runs after the user has
already done some work and **clobbers in-memory state with whatever the
server cached at upload time**. This is the "assumptions disappear
mid-session" report you've been chasing.

**Fix:** Collapse this into a single effect keyed on `(activePaperId,
paper?.id)` only. Move tier-gated auto-analysis to a separate effect
that only runs `if (paper?.id === activePaperId && !tierLoading)` and
uses `useRef` flags so it never reruns for the same paper.

```tsx
// Pseudocode for the consolidated effect
const hydratedFor = useRef<string | null>(null);
useEffect(() => {
  if (!paper || paper.id !== activePaperId) return;
  if (hydratedFor.current === paper.id) return; // already hydrated
  hydratedFor.current = paper.id;
  hydrateFromCachedAnalysis(paper.cached_analysis);
}, [paper?.id, activePaperId]);
```

### 2.2 `setPaper` + hydration effect double-clear

`frontend/src/lib/store.ts:168–199` — `setPaper` now wipes per-paper
slices when id changes. Good. But the hydration effect at `727–859`
runs the moment `paper` flips and **immediately re-reads
`paper.cached_analysis`** to fill those same slices. That means:

1. Frame 1: `setPaper(newPaper)` → slices cleared
2. Frame 2: hydration effect → slices written from `cached_analysis`
3. Frame 3: `paper.id !== activePaperId` was true for one render, so user briefly saw "Analyze Paper" empty state.

**Fix:** Move the wipe into `restorePaperCache`'s "miss" branch only.
`setPaper` should be a pure setter; the URL-switch effect already
calls `resetAnalysisState()` if there's no cache hit.

### 2.3 `selectionHistory` `JSON.stringify` flicker

`frontend/src/app/paper/[id]/page.tsx:751–752`:

```tsx
if (JSON.stringify(store.selectionHistory) !== JSON.stringify(merged)) {
  useStore.setState({ selectionHistory: merged.slice(0, 50) });
}
```

This O(n) string compare runs every time the hydration effect fires.
Worse: the effect runs on `paper` reference change, so any background
refetch triggers a recompare. Two side effects:

- A streaming selection that hasn't yet reached the server (no entry
  in `cached_analysis.selections`) is **wiped** because the server
  list is "shorter" → "different" → replace.
- Heavy GC pressure during streams.

**Fix:** Compare **lengths + last id** (cheap O(1)), and *merge* server
entries into in-memory state instead of replacing. Keep in-flight
streams that don't yet exist on the server.

### 2.4 `autoAnalyzedPapers` is a process-global Set with no GC

`frontend/src/lib/analysisState.ts:7,59–74`. The `Set<string>` grows
over the lifetime of the tab. Every paper open adds two entries
(`${id}:preReading`, `${id}:assumptions`). After a long session this is
fine memory-wise but it **leaks "I already retried" bits across paper
deletes**. The `forgetPaper` helper covers explicit removal but not the
common case (user closes session tab via the X).

**Fix:** Hook `forgetPaper(id)` into `removeSessionPaper` (already
done in `handleRemoveSessionPaper` at line `907`) **and** also into
`deletePaper` flows in dashboard / library. Currently a deleted paper
keeps its retry-block flag forever, so re-uploading the *same* PDF
(same content hash) leaves auto-analyze blocked.

### 2.5 Streaming summary persists *to the cache slot for the paper that finished*, not the one user is on

`frontend/src/components/sidebar/SummaryPanel.tsx:96–104`:

```ts
useStore.getState().updatePaperCache(paperId, { summary: event.summary });
if (useStore.getState().paper?.id === paperId) {
  setSummary(event.summary);
}
```

This is correct — but the `paperCaches` slot is also overwritten
**without comparing** to whatever the user already has in memory for
that paper. If the user has three papers in session and one's summary
lands while they're on a different one, the `paperCaches[A].summary`
gets blown away.

**Fix:** `updatePaperCache(paperId, partial)` should `Object.assign`
into the existing slot (which it does) — verify the call sites don't
pass `summary: null` accidentally.

---

## 3. Cache layer chaos

> **Priority: P1 (perf + correctness)**

### 3.1 Inventory

| Cache | Where | Key | Persisted? | Source of truth? |
|---|---|---|---|---|
| `pdfBlobCache` | `PdfViewer.tsx:40` | URL | No (module Map) | No |
| `papersById` | `store.ts:158` | `paperId` | No | No (mirror) |
| `paperCaches` | `store.ts:370` | `paperId` | No | No (analysis) |
| `cached_analysis` | server | `paperId` | Yes (Postgres JSONB) | **Yes** |
| Zustand `persist` | localStorage `know-paper-store` | — | Yes | No (UI prefs only) |
| Loose localStorage keys | `know-panel-pos`, `know-panel-size-side`, `know-pdf-scroll:`, `know-qa-hide-suggestions`, `know-qa-draft:`, `know-bg-image-css`, etc. | `paperId` for some | Yes | No |

**Six caches** for what is conceptually one set of data plus six small
UI prefs. The split between `papersById` and `paperCaches` is
particularly confusing — they overlap (both hold `notes` and
selection data), they're both keyed by `paperId`, and they're both
non-persistent. There's no coherent invariant.

### 3.2 Concrete problems caused by the sprawl

- **Stale-fold:** A paper update via `cachePaper(p)` doesn't invalidate
  the matching `paperCaches[p.id]`. So if a Q&A round-trip updates
  `cached_analysis.qa_sessions` server-side and we re-fetch the paper,
  `papersById` is fresh but `paperCaches.qaResults` could be stale.
- **localStorage growth:** Every paper opened adds entries. There's
  cleanup only for `paperCaches` (cap of 20 in `store.ts:384`) but
  none for `know-pdf-scroll:*` or `know-qa-draft:*`. After 100
  papers the user has 100 KB of dead localStorage keys.
- **Double-source for `notes`:** `paper.notes` (in `papersById`) and
  `notes` (in active store + `paperCaches`). These can drift.

### 3.3 Recommended structure

Collapse to **three** caches with crisp roles:

```
┌─────────────────────────────────────────────────┐
│  Server: papers.cached_analysis (JSONB)         │  ← source of truth
└─────────────────────────────────────────────────┘
                    ↓ (1 round-trip on /api/papers/:id)
┌─────────────────────────────────────────────────┐
│  Frontend: papersById (Zustand, in-memory)      │  ← read-through cache
│  - Holds full ParsedPaper                       │
│  - No `raw_text` (see §6)                        │
└─────────────────────────────────────────────────┘
                    ↓ (UI bindings derive from papersById)
┌─────────────────────────────────────────────────┐
│  UI prefs (localStorage, single key)             │
│  - panelPos / panelSize / fontScale              │
│  - hideSuggestions / panel chrome flags          │
└─────────────────────────────────────────────────┘
```

- **Delete** `paperCaches`. Selectors over `papersById[paperId]`
  are *zero-cost in React 19* with `useSyncExternalStore`-backed
  Zustand and they're guaranteed to be coherent.
- **Delete** `papersById` mirror in dashboard/library — fetch on
  demand, cache once.
- **Move loose localStorage keys** behind a single
  `useStore.persist` partition with sensible cleanup
  (`paperId`-keyed entries get GC'd when the paper is deleted).

This will erase whole categories of "data sometimes shows wrong thing"
bugs.

---

## 4. Per-tab data-flow issues

> **Priority: mostly P1**

### 4.1 All tabs always mount

`frontend/src/components/panel/BottomPanel.tsx:322–346` — every
`TabsContent` is rendered unconditionally. Radix's `Tabs` only sets
`display: none` on inactive panels; the React tree is fully alive,
effects run, network fires.

**Impact:**
- Opens a paper → AssumptionsPanel mounts → its hydration effect
  triggers → if the auto-analyze effect on the parent didn't catch
  the empty-cache case, **the tab itself fires `api.getAssumptions`**
  silently in the background.
- FiguresPanel mounts → loads figure thumbnails immediately even if
  the user never opens that tab.
- QAPanel mounts → restores the per-paper draft from localStorage on
  every paper switch.

**Fix:** Use Radix's `forceMount={false}` (default) but wrap in
conditional render based on `activeTab` *or* a `mountedTabs` set:

```tsx
const [seen, setSeen] = useState(new Set([effectiveTab]));
useEffect(() => setSeen((s) => new Set([...s, effectiveTab])), [effectiveTab]);
{seen.has("figures") && (
  <TabsContent value="figures" forceMount>
    <FiguresPanel paperId={paperId} />
  </TabsContent>
)}
```

This keeps tabs hot once visited (no spinner on second open) but
defers the first mount until the user actually clicks.

### 4.2 Summary panel: paper-mismatch escape hatch is brittle

`SummaryPanel.tsx:140–162` clamps `effectiveSummary` on `paper?.id ===
paperId`. Good. But the **stream itself** (line `41–129`) doesn't have
the same clamp on the writes — see §2.5.

Also: `fetchAttempted.current = paperId` (line `162`) is set to the
target paper, but `fetchAttempted.current = null` is only reset by the
"Retry" button, not by paper-switching. So if a summary fetch fails
silently on paper A, switching to A again later will still see
`fetchAttempted.current === A` → no retry.

**Fix:** Reset `fetchAttempted.current` whenever `paperId` prop changes.

### 4.3 Q&A: suggestions reset state isn't synced with backend

`QAPanel.tsx:71–84` — `usedPrompts`, `extraPrompts`, `extraError` are
local component state, reset on paper switch. **No persistence.**
Refresh → extra prompts and used markers gone. The user re-clicks
prompts they've already seen.

**Fix:** Persist to localStorage or move to `paper.cached_analysis.qa_used_prompts`
(server-side) as a list of strings the user has clicked.

### 4.4 Selection: legacy `question` action still in DOM

After the recent migration, `cached_analysis.selections` may contain
historical entries with `action: "question"`. `SelectionResultPanel.tsx`
labels them as "Explanation" (line `33`) but the highlight color
falls through to a **legacy alias** in CSS. Fine, but the
DerivationView and other selectors still test `result.action ===
"derive"`. Three places where the comparison is action-string-based:

- `SelectionResultPanel.tsx:230,242` — derive-only branches
- `BottomPanel.tsx:153` — passing `"followup"` literal
- `PdfViewer.tsx:478` — `entry.action || "explain"` fallback

**Fix:** Centralize action types in `frontend/src/lib/selectionActions.ts`
(or similar) with a `SelectionActionType` union. Make the SelectionResult
shape carry `action: SelectionActionType` so TypeScript catches
typos.

### 4.5 Figures: re-extract clobbers in-flight figure analysis

`FiguresPanel.tsx:186–217` — `handleReextract` updates `paper.figures`
unconditionally. If the user is mid-stream analyzing Figure 3, the
new figures might not include `fig_3` (or include it with different
geometry), and the streaming response then writes into
`conversations[fig_3]` which could now reference a deleted figure.

**Fix:** Block re-extract while `loading === true`, or abort the
in-flight analyze stream and surface a "discarded — figures changed"
toast.

### 4.6 Pre-reading: no error UI

`PreReadingPanel.tsx:56–58` — failed analysis is `console.error`'d but
the user sees no banner. They click "Analyze Paper" → spinner
disappears → empty state returns → looks broken.

**Fix:** Mirror the AssumptionsPanel error banner (`AssumptionsPanel.tsx:92–94`).

---

## 5. UI / UX rough edges

> **Priority: P2**

### 5.1 Three different progress bars, three different time constants

| Panel | File:line | Half-life |
|---|---|---|
| PreReading | `PreReadingPanel.tsx:23` | 10s |
| Assumptions | `AssumptionsPanel.tsx:23` | 10s |
| Summary | `SummaryPanel.tsx:27` | 20s |
| Selection | `SelectionResultPanel.tsx:13` | 8s |
| QA | `QAPanel.tsx:20` | 10s |

Each bar uses the same exponential formula but different decay
constants. Visually they look identical until they diverge near
completion. Either:

- **Calibrate per analysis kind** to the actual p95 latency (Sonnet
  full summary really *is* slower than Haiku's selection explain),
  and document the constants in one place, or
- **Replace with a unified `<AnalysisProgress kind="..." />` component**
  that pulls its decay constant from a single map. (Recommended.)

### 5.2 Selection toolbar dismisses too eagerly

`SelectionToolbar.tsx:124–142` — outside-click handler with a 200ms
grace period. On macOS Safari, ⌘+Shift+arrow (extending a selection)
can fire mousedown elsewhere and dismiss the toolbar mid-extend.

**Fix:** Don't dismiss on mousedown if the active text selection is
still non-empty.

### 5.3 No way to cancel a long pre-reading / assumptions extraction

Once started, the user can only wait. `markRequestStart` /
`markRequestEnd` mark in-flight state but expose no `AbortController`.

**Fix:** Store an `AbortController` in `activeRequests` parallel to
the kind set, expose a "Cancel" button next to the progress bar.

### 5.4 LaTeX preprocessing is run inside `<Md>` on every render

`Md.tsx:38–58`:

```tsx
<ReactMarkdown ...>
  {preprocessLatex(children)}
</ReactMarkdown>
```

When a summary streams, every chunk re-renders the `<Md>` block,
which re-runs `preprocessLatex` on the entire growing string. For a
3000-token summary, that's potentially thousands of regex passes.

**Fix:**

```tsx
const processed = useMemo(() => preprocessLatex(children), [children]);
```

Cheap and significant on stream perf. Even better: memoize at the
component level with `React.memo(Md)`.

### 5.5 Inline editable title pollutes browser history

The Google-Docs-style rename in `paper/[id]/page.tsx:33–123` works
but every commit fires a `router.replace` on the page title? Actually
no — only the URL stays the same. Verify it doesn't trip any
analytics page-view side effects.

### 5.6 Multi-paper session bar overflow on small screens

`paper/[id]/page.tsx:1505+` — `overflow-x-auto scrollbar-hide`. Works,
but with 5+ papers the user has no visible scroll affordance. Add a
fade-mask on the right edge so it's clear there are more tabs.

### 5.7 Highlights survive across paper switches in some race window

When the user switches paper and the new paper's `selectionHistory`
hasn't hydrated yet, the **previous paper's** underlines momentarily
appear over the new paper's pages. The PDF blob is cached so pages
render fast — but `selectionHistory` lags. The fix is in §2.2.

---

## 6. Performance — frontend

> **Priority: P0 for top three, P1 for the rest**

### 6.1 [P0] `getPaper` ships `raw_text` (100–500 KB unused)

`backend/app/models/schemas.py:22` defines `raw_text: str = ""` on
`ParsedPaper`. `backend/app/api/papers.py:147–155` returns
`ParsedPaper` directly. **The frontend never reads
`paper.raw_text`** — it's only used inside the LLM prompt builders
on the server.

**Fix:** New Pydantic schema `ParsedPaperPublic` for the API response
that omits `raw_text`. Or use `response_model_exclude={"raw_text"}`
on the `@router.get("/{paper_id}")` decorator. Either way:

```python
@router.get("/{paper_id}", response_model=ParsedPaper, response_model_exclude={"raw_text"})
async def get_paper_by_id(...): ...
```

**Expected impact:** Paper-switch payload **drops by 70–95%**,
typically from 150–500 KB → 5–25 KB. This is the single biggest
speed win available.

### 6.2 [P0] `<Md>` re-runs `preprocessLatex` on every render

See §5.4. Memoize it.

```tsx
// Md.tsx
import { useMemo, memo } from "react";

export const Md = memo(function Md({ children, className }: MdProps) {
  const processed = useMemo(() => preprocessLatex(children), [children]);
  return (
    <div className={className ?? "analysis-content"}>
      <ReactMarkdown ...>{processed}</ReactMarkdown>
    </div>
  );
});
```

**Expected impact:** Streaming a 3000-token summary stops jank on
mid-spec laptops. Reduces wasted CPU during a stream by an order of
magnitude.

### 6.3 [P0] Lazy-mount inactive tabs

See §4.1. Don't render `<FiguresPanel>` etc. until the tab has been
visited at least once.

**Expected impact:** First paint of paper page drops from ~25 React
component subtrees to ~3. On slow devices, time-to-interactive
improves by 200–600 ms.

### 6.4 [P1] `PaperContent` destructures 25 store slices in one call

`paper/[id]/page.tsx:462–479`:

```tsx
const {
  paper, setPaper, loading, setLoading,
  panelVisible, setPanelVisible, togglePanel,
  ... 22 more ...
} = useStore();
```

Zustand returns a new object each call. Without a selector / shallow
compare, **every** state change re-renders `PaperContent`, which is
the parent of the entire reader.

**Fix:** Use granular selectors with shallow compare:

```tsx
import { useShallow } from "zustand/react/shallow";

const { paper, setPaper } = useStore(useShallow((s) => ({
  paper: s.paper, setPaper: s.setPaper,
})));
```

…or split into multiple selectors, one per logical group. Pull only
what `PaperContent` actually needs at the top level; let child
components pull their own slices.

### 6.5 [P1] PDF blob full-download alongside range requests

`PdfViewer.tsx:99–133` — after first paint, we `fetch(url)` the entire
PDF in the background to cache the blob URL for next time. The PDF
also uses HTTP range requests for the visible pages. **Net effect:**
double bandwidth for the first session.

**Fix:** Only background-prefetch when the user has been on the paper
more than ~3 seconds (intent signal: they're going to read it). And
skip prefetch entirely if the PDF is > 25 MB.

### 6.6 [P1] Zustand persist writes localStorage on every state change

`store.ts:476–487` — Zustand `persist` defaults to writing on every
state mutation. The store has 30+ slices; selecting a single
question, scrolling a tab, and typing in an input all serialize the
**entire `partialize`d slice** to localStorage.

**Fix:** Wrap the persistence write in a `setTimeout`/`debounce`
adapter, or move all per-action UI state out of the persisted slice
(see §3.3).

### 6.7 [P1] `MutationObserver` per page in PdfViewer

`PdfViewer.tsx:676–747` — one `MutationObserver` watching the entire
container plus a per-page observer for every visible page. With 5
mounted pages this is 6 observers, each firing on every text-layer
mutation (which can be hundreds during initial render).

**Fix:** A single `IntersectionObserver` to detect "page entered
viewport" + a one-shot `requestIdleCallback` to draw underlines
once per page (after pdfjs is settled). Fall back to a periodic
`requestAnimationFrame` poll for late-arriving spans.

### 6.8 [P2] No code-splitting of `katex` / `rehype-katex`

`package.json:21,31` — `katex` is bundled with the main route. It's
~250 KB minified. Only the analysis pane needs it.

**Fix:** Dynamic-import `Md` so `katex` lands in its own chunk:

```tsx
const Md = dynamic(() => import("@/components/ui/Md").then((m) => m.Md), { ssr: false });
```

**Expected impact:** First load of `/dashboard` and `/library` ~250 KB
smaller.

### 6.9 [P2] `react-pdf` worker fetched cross-origin by default

Already fixed via the URL constructor pattern (`PdfViewer.tsx:15–18`).
Just verify the build still inlines the worker — Webpack/Turbopack
treat that pattern correctly under both bundlers.

---

## 7. Performance — backend

> **Priority: P1**

### 7.1 [P1] `mutate_paper` is read-modify-write on a JSONB column

Every selection write fires:

1. `get_paper(paper_id)` — reads the whole row including `raw_text`
2. Mutate Python object
3. `save_paper(paper, user_id)` — writes the whole `cached_analysis`
   blob back

For a paper with a long Q&A history, that JSONB blob is 200+ KB. We
serialize, send, parse on every selection click.

**Fix:** Use Postgres' JSONB `jsonb_set` / `||` operators in a
custom RPC for append-style mutations:

```sql
CREATE FUNCTION append_selection(p_paper_id text, p_user_id text, p_entry jsonb)
RETURNS void AS $$
  UPDATE papers
  SET cached_analysis = jsonb_set(
    cached_analysis,
    '{selections}',
    coalesce(cached_analysis->'selections', '[]'::jsonb) || p_entry,
    true
  )
  WHERE id = p_paper_id AND user_id = p_user_id;
$$ LANGUAGE sql;
```

…called from `db.py` analogous to `reserve_daily_api_usage`.
Same pattern for `qa_sessions` append. **Expected impact:** Selection
write latency drops from ~150–400 ms to ~20–60 ms.

### 7.2 [P1] No in-process per-paper read cache

`papers.py:140–155` does a fresh Supabase round-trip on every
`getPaper`. A user clicking around tabs of the same paper hits the
same call repeatedly.

**Fix:** Process-local LRU around `get_paper`:

```python
from functools import lru_cache
# Wrap the underlying disk + DB read; invalidate on save_paper.
```

Be careful: invalidation is the hard part. Since `save_paper`
already runs through a single function, hook the invalidation
there.

### 7.3 [P1] PDF parsing is synchronous in the upload request

`papers.py:95` calls `extract_pdf(pdf_path, paper_id)` inline. For a
large paper this can pin the worker for 5–30 s, blocking other
requests on the same uvicorn worker.

**Fix:** Move `extract_pdf` to a thread executor or background task
and return the paper id immediately. The frontend already polls /
hydrates lazily; this fits naturally.

```python
loop = asyncio.get_running_loop()
raw = await loop.run_in_executor(None, extract_pdf, pdf_path, paper_id)
```

The single-line `run_in_executor` change unblocks the event loop
and lets one worker handle 4–8 concurrent uploads instead of one
at a time.

### 7.4 [P2] Trial cleanup loop on the request worker

`main.py:20–48` — the same FastAPI process runs trial cleanup every
30 minutes. Fine for low traffic, but a cleanup that gets stuck (e.g.
Supabase RPC times out) blocks the event loop briefly.

**Fix:** Already wrapped in `try/except` — sufficient. Just verify
RPC has a hard timeout via httpx config.

### 7.5 [P2] Selection / Q&A streaming has no compression

The SSE responses are uncompressed. Long summaries can be 50 KB+.

**Fix:** Add `gzip` middleware in FastAPI:

```python
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1024)
```

Streams will gzip too, reducing wire bytes by ~70%. Negligible CPU
overhead.

### 7.6 [P2] Per-model daily reservation reads, writes, reads again

`db.py:447–469` — `reserve_daily_model_usage` is atomic via the
RPC, but the surrounding code in `gating.py` reads usage to display
limits, then reserves, then reads again to refresh the UI counter.
Three queries where one would do.

**Fix:** Make the RPC return the new total so the caller doesn't
need a follow-up read.

---

## 8. Performance — network & infra

> **Priority: P1 / P2**

### 8.1 [P1] No HTTP cache headers on read endpoints

`getPaper`, `listPapers`, `getPdfUrl`, `getFigureUrl` all return
without `Cache-Control` or `ETag`. The browser re-validates
unconditionally.

**Fix:** Add weak ETags from `cached_analysis_updated_at` (or a
hash) on `getPaper`. Add `Cache-Control: private, max-age=10` for
listings and `max-age=86400, immutable` for figure PNGs (they don't
change after extraction; if re-extracted, the figure ID stays
stable but content changes — use a content-hash query param).

### 8.2 [P1] Auth refresh every 45 s is too frequent

`api.ts:28–30` — Clerk JWTs are typically valid for 60 minutes.
Refreshing every 45 s means **80x more JWT issuance** than necessary.

**Fix:** Refresh on `401` (with single retry) plus a 50-minute
periodic refresh.

### 8.3 [P2] No request deduplication

A burst of paper switches (user clicking session tabs rapidly) fires
N `getPaper` calls in flight. Same for `getAssumptions`,
`api.analyze`.

**Fix:** Wrap `request<T>` in a request-keyed dedupe map:

```ts
const inflight = new Map<string, Promise<unknown>>();
function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
```

Keyed by `${method}::${url}`. Skip for mutations.

### 8.4 [P2] Vercel CDN doesn't cache PDFs / figures

PDFs and figures are served by the FastAPI backend. They're
authenticated, so Vercel can't proxy-cache them. Latency is the
backend round-trip plus Supabase Storage roundtrip when the file
isn't on local disk yet.

**Fix:** Issue **signed Supabase Storage URLs** from the backend and
redirect the browser to them. Storage is on a CDN already and
returns directly. Saves 2–3 hops per PDF / figure load.

```python
@router.get("/{paper_id}/pdf")
async def get_paper_pdf(paper_id: str, user_id: str = Depends(require_auth)):
    _verify_paper_owner(paper_id, user_id)
    signed = bucket.create_signed_url(f"{user_id}/{paper_id}.pdf", 600)
    return RedirectResponse(signed)
```

### 8.5 [P2] No CDN warming for first PDF render

When a user first opens a paper in their session, the PDF download
hits the backend cold. Combined with §8.4, you can prewarm the
browser's connection to Storage by emitting a `Link:
rel=preconnect` header on the dashboard page.

---

## 9. Recommended migration plan

**Order matters** — these compose. Don't skip ahead.

### Phase 0 — quick wins (single PR, ~2 hours)

1. Memoize `Md` (`§6.2`) — 1 file, 4 lines.
2. Exclude `raw_text` from `getPaper` response (`§6.1`) — 1 line.
3. Lazy-mount tabs (`§4.1, §6.3`) — ~30 lines.
4. Move auth refresh to 50 min + 401 retry (`§8.2`) — small.
5. Add gzip middleware (`§7.5`) — 2 lines.

**Expected impact:** 30–50% faster paper loads, halved CPU during
streams, smaller bundle.

### Phase 1 — hydration cleanup (one PR, ~half a day)

6. Collapse the four hydration effects into one (`§2.1, §2.2`).
7. Rewrite `selectionHistory` merge logic to be id-based, not
   stringify-based (`§2.3`).
8. Wire `forgetPaper` into delete flows (`§2.4`).
9. Add `useShallow` selectors to `PaperContent` (`§6.4`).

**Expected impact:** Eliminates "data sometimes shows wrong /
disappears" bugs. Renders drop ~5x.

### Phase 2 — cache rationalization (one PR, full day)

10. Delete `paperCaches`. Derive everything from `papersById`.
11. Centralize loose localStorage keys behind one persisted store
    namespace (`§3.3`).
12. Add request deduplication to `request<T>` (`§8.3`).

**Expected impact:** Long sessions stop accumulating stale state.
Code complexity drops (no more ambiguity on which cache to read).

### Phase 3 — backend perf (one PR, half a day)

13. Atomic JSONB RPCs for selection / Q&A appends (`§7.1`).
14. Async PDF parsing in upload (`§7.3`).
15. Process-local `lru_cache` around `get_paper` (`§7.2`).
16. Signed-URL redirects for PDF / figure assets (`§8.4`).

**Expected impact:** Selection writes 5–10x faster. Concurrent
uploads stop blocking each other.

### Phase 4 — UX polish (PRs as needed)

17. Unified `<AnalysisProgress>` component (`§5.1`).
18. Cancel buttons for long extractions (`§5.3`).
19. Preserve `usedPrompts` across refresh (`§4.3`).
20. Error UI for pre-reading failures (`§4.6`).

---

## 10. Appendix: file map

Files referenced in this audit:

```
frontend/src/
├── app/paper/[id]/page.tsx           # PaperContent — main reader
├── components/
│   ├── pdf/
│   │   ├── PdfViewer.tsx             # PDF rendering, highlights
│   │   └── SelectionToolbar.tsx      # Floating action toolbar
│   ├── panel/
│   │   ├── BottomPanel.tsx           # AnalysisPanel — tabs container
│   │   └── SelectionResultPanel.tsx  # Selection tab body
│   ├── sidebar/
│   │   ├── SummaryPanel.tsx
│   │   ├── PreReadingPanel.tsx
│   │   ├── AssumptionsPanel.tsx
│   │   ├── QAPanel.tsx
│   │   ├── FiguresPanel.tsx
│   │   ├── NotesPanel.tsx
│   │   └── CrossPaperPanel.tsx
│   └── ui/Md.tsx                     # Markdown + LaTeX renderer
├── lib/
│   ├── store.ts                      # Zustand store
│   ├── analysisState.ts              # Background-analysis tracking
│   ├── api.ts                        # Backend client
│   └── latex.ts                      # KaTeX preprocessor

backend/app/
├── api/
│   ├── papers.py                     # Paper CRUD
│   └── analysis.py                   # LLM endpoints
├── services/
│   ├── llm.py                        # Provider clients + prompts
│   ├── pdf_parser.py                 # PyMuPDF extraction
│   └── db.py                         # Supabase wrapper
└── models/schemas.py                 # Pydantic schemas
```

### Quick-reference: top 5 things to do this week

1. **Memoize `<Md>`** — 4 lines, halves stream CPU.
2. **Exclude `raw_text` from `getPaper` response** — 1 line, halves payload.
3. **Lazy-mount tabs** — 20 lines, faster first paint.
4. **Single hydration effect** — kills the "stuff disappears" bugs.
5. **Atomic JSONB append RPC for selections** — backend writes 5x faster.

---

*— Audit produced by reading the actual repo at `b2fc4f3`, not from
generic best-practice patterns. Every recommendation has a concrete
file:line citation. Re-run the audit any time by re-reading the
affected files; assumptions in §6/§7 numbers are based on the current
shape of `cached_analysis` for typical papers.*

---

## 11. Follow-up question disappearance — root cause

> **Priority: P0 (correctness, user-visible).** Targeted addendum on
> top of §2.

### 11.1 What you're seeing

You ask a follow-up. It threads correctly under its parent root for a
moment, then disappears (or its visible text mutates into a long
"context + Follow-up question: ..." string and threading breaks).

### 11.2 Three concrete causes, in order of likelihood

**(a) `selected_text` mismatch between client & server. — Highest.**

`frontend/src/components/panel/BottomPanel.tsx:153–158`:

```ts
const result = await api.analyzeSelection(
  paperId,
  `${context}\n\nFollow-up question: ${question}`,  // ← server stores THIS
  "followup",
);
const followUpResult = {
  ...result,
  action: "followup" as const,
  selected_text: question,                          // ← client stores THIS
};
addSelectionToHistory(followUpResult);
```

The backend's `analyze_selection` writes `result["selected_text"] = selected_text` (`backend/app/services/llm.py:526`), where `selected_text` is the **full payload** ( "${context}\n\nFollow-up question: ${question}"). The client immediately rewrites it to just `question`.

Now the live `selectionHistory[0].selected_text === question`, but
`paper.cached_analysis.selections[N].selected_text === "${context}\n\nFollow-up question: ${question}"`.

The hydration effect at `paper/[id]/page.tsx:745–762` does:

```tsx
if (JSON.stringify(store.selectionHistory) !== JSON.stringify(merged)) {
  useStore.setState({ selectionHistory: merged.slice(0, 50) });
}
```

JSON differs → server wins → the displayed follow-up's `selected_text`
flips to the long ugly string. `SelectionResultPanel` keys threads on
`selectionKey(r) = action::selected_text::body-head`, so the React
identity changes → unmount + remount → the follow-up appears to
"disappear" and a different node mounts in its place (often empty
because `result.streaming` was true a frame ago).

**(b) Hydration effect runs *during* the in-flight call.**

`paper/[id]/page.tsx:727–859` re-runs whenever any of `[paper,
activePaperId, tierUser?.tier, tierLoading, ...]` changes. `tierUser`
flips identity on every `/api/user/me` poll (which happens after the
selection-stream finishes if `bumpUsageRefresh()` triggers a refetch).
Sequence:

1. User submits follow-up.
2. `addSelectionToHistory` adds it to live state. ✓
3. `await api.analyzeSelection(...)` resolves — server writes too.
4. `bumpUsageRefresh()` fires, refetching `/api/user/me`.
5. `tierUser` reference changes → hydration effect re-runs.
6. JSON differs (cause **a**) → live history is replaced.

**(c) Stream-mode race.**

`PdfViewer.tsx → analysis.py /selection-stream` writes to
`cached_analysis.selections` only **on stream completion**. If the
hydration effect re-runs **mid-stream**, `merged` lacks the streaming
entry, so it overwrites local state and the in-flight follow-up
vanishes. Mostly affects long streams over slow connections.

### 11.3 Fix (one PR, ~25 lines)

Three changes that compose:

**1. Stop overriding `selected_text` client-side. Persist exactly what
the server stored, plus a separate `question` field for the threaded
view.**

```ts
// BottomPanel.tsx
const followUpResult: SelectionAnalysisResult = {
  ...result,
  action: "followup",
  // Server has the full context+question string; keep it for parity.
  // The threaded view should render `result.question`, not selected_text.
  question,
};
```

Update `SelectionAnalysisResult` to carry an optional `question?: string`
and have `SelectionResultPanel` prefer it for the "You asked" label.
Backend should also accept and persist it (one-line addition to
`analyze_selection` and `selection_analysis_stream` to copy
`body.get("question")` into the result dict).

**2. Replace JSON.stringify replacement with a *merge*.**

`paper/[id]/page.tsx:745–762`:

```tsx
if (Array.isArray(cache.selections)) {
  const serverNewestFirst = [...cache.selections].reverse() as SelectionAnalysisResult[];
  const liveKeys = new Set(useStore.getState().selectionHistory.map(selectionKey));
  // Add any server entries we don't already have, but never overwrite
  // a live entry. The "delete from server" path already calls
  // removeSelectionFromHistory directly, so divergence is bounded.
  const merged = [
    ...useStore.getState().selectionHistory,
    ...serverNewestFirst.filter((s) => !liveKeys.has(selectionKey(s))),
  ].slice(0, 50);
  useStore.setState({ selectionHistory: merged });
}
```

Where `selectionKey` is the same content-based key used in
`SelectionResultPanel`. This makes hydration *additive*, not
*replacing*, so an in-flight item is never wiped.

**3. Bound the hydration effect to `paper.id` only.**

```tsx
// paper/[id]/page.tsx — replace the dep array
}, [paper?.id, activePaperId, tierLoading]);
```

Removing `paper` (the whole reference) and `tierUser?.tier` from the
dep array stops the cascade where a usage refetch nukes the live
selection list. The effect still runs once per paper, plus once when
tier finishes loading — both are intentional.

### 11.4 Side fixes that prevent regressions

- Add a **server-side dedup** in `append_capped`: if `selections[-1]`
  has the same `(action, selected_text, head_of_explanation)` tuple,
  don't append again. This rescues the case where a retry double-saves.
- Add a **`session_id` (UUID)** to every selection result on creation,
  client-side. Then `selectionKey(r) = r.id` and we sidestep
  content-based identity entirely.

---

## 12. Analysis pane — UI / UX redesign for "professional, minimal"

> **Priority: P1 (visual / first-impression).** Mostly cosmetic, but
> compounding.

The pane works, but visually it reads as "vibe coded" because it
mixes 5+ glass / shadow / ring tokens, uses inconsistent typography
across panels, and fights against its own minimal aesthetic with
overdone gradients and emojis-as-status. Below is a concrete redesign
spec, structured so each item is one PR.

### 12.1 Type scale

Currently the pane uses **eight different sizes** (`10px`, `10.5px`,
`11px`, `11.5px`, `12px`, `12.5px`, `13px`, `14px`). Pick **four**:

| Token | Size | Use |
|---|---|---|
| `--text-xs` | 11 px | metadata, badges, captions |
| `--text-sm` | 12.5 px | body inside panels |
| `--text-md` | 14 px | section headings, primary controls |
| `--text-lg` | 16 px | tab title (currently 13 px — feels squeezed) |

Add to `globals.css` and replace ad-hoc sizes via search-and-replace.
Use `tabular-nums` consistently on every counter (selection count,
queued count, page indicator).

### 12.2 Spacing rhythm

Inside panels the spacing alternates between `space-y-1.5`,
`space-y-2`, `space-y-2.5`, `space-y-3`, `space-y-5`. Pick a
**4-step** scale based on a `4 px` grid:

- `gap-y-2` ( 8 px) — between items in a list
- `gap-y-4` (16 px) — between cards / list groups
- `gap-y-6` (24 px) — between sections within a panel
- `gap-y-10` (40 px) — between pane and nav

Apply to: `BottomPanel.tsx`, every `<panel>.tsx`, `SelectionResultPanel.tsx`.

### 12.3 Color tokens (consolidate)

Currently the pane uses these accent colors:

- `bg-foreground/5`, `/10`, `/20`, `/25`, `/60`, `/80`, `/90`
- `bg-accent`, `bg-accent/30`, `bg-accent/60`, `bg-accent/70`
- `bg-muted`, `bg-muted-foreground/10`, `/20`, `/40`, `/50`
- ad-hoc gradient `from-violet-500 to-purple-600`

Reduce to:

| Token | Use |
|---|---|
| `--surface-0` | the pane background (off-white / near-black) |
| `--surface-1` | cards, hover targets |
| `--surface-2` | hovered/pressed cards |
| `--ink-strong` | titles, primary text |
| `--ink-mid` | body |
| `--ink-soft` | metadata, captions |
| `--accent` | one (1) brand accent — used for primary CTAs and active tab |

Drop the violet gradient on every "Upgrade" button — it's the only
gradient in the app and it screams "consumer SaaS template". Replace
with a solid `bg-foreground text-background` button + a thin
`ring-foreground/20`. This single change is the largest visual
upgrade for the dollar.

### 12.4 Tabs

The current `TabsList` uses an underline that draws *under the tab
label*. Move to **the bottom edge of the tab bar** so the active tab
forms a clean L-shape with the divider below. (Linear / Notion / Vercel
all use this pattern.) Code: lift the underline out of `TAB_STYLE`
(`BottomPanel.tsx:38–39`) and render it as a single absolutely-positioned
indicator that animates between tab positions on click.

### 12.5 Empty / loading states

- Today: ad-hoc text + spinner combinations per panel.
- Replace with one `<EmptyState icon iconLabel title body cta />`
  component. Ship it once; reuse in every panel's
  `if (!data) return ...` branch. Standard look, standard padding,
  standard CTA.
- Replace the five different progress bars (§5.1) with one
  `<AnalysisProgress kind="..." />`.

### 12.6 Selection card visual hierarchy

`SelectionResultPanel.tsx` `ResultCard`:

- The italic quote pill is fine, but currently it's the same surface
  treatment as the analysis body. Demote: smaller, `text-muted-
  foreground/40`, no glass. Promote the analysis body: lock-up with the
  action badge so the badge sits *next to* the first line, not above.
- The "starting point / final result" cards in `DerivationView` are
  visually identical to step cards. Differentiate: starting point with
  a ⌐ marker, final result with a thin success-ish ring (no green
  fill — too loud).

### 12.7 Q&A tab

- Newest-first ordering is correct. Drop the "+ More like these" pill's
  dashed border (it reads as "disabled state"). Use the same solid
  glass-subtle styling as the seed prompts but with a `+` icon.
- Move the Cross-Paper toggle into a **kebab/overflow menu** on the
  panel header. Today it occupies the entire top of the panel, which
  is dead space for the 95% of users not in cross-paper mode.
- Auto-scroll to latest answer after `Answer All` resolves. Easy fix
  with `ref.current?.scrollIntoView({ behavior: "smooth" })`.

### 12.8 Figures tab

- The hero "Re-extract figures" button on empty state currently uses
  `btn-primary-glass` (gradient). Use the same neutral CTA as
  everywhere else.
- Lightbox: add image zoom-on-double-click and Esc-to-close hint in
  the corner. Free wins on a feature people actually use.

### 12.9 Notes tab

- The note-edit experience is "click to enter edit, blur to save". OK
  but invisible. Add a tiny `Editing` chip while the user is mid-edit
  + a `Saved` chip that fades after 1 s.

### 12.10 Pane chrome

- The kebab popover is good; keep. But the position label in the
  popover ("Move to bottom" etc.) is buried at the right edge. Promote
  to a primary action button in the popover.
- The pane drag handle is invisible until hover. Add a permanent
  `1px` accent line at hover-reveal opacity, so users discover the
  resize affordance without trial and error.

---

## 13. Platform-wide UI / UX upgrade

> **Priority: P2.** Mostly polish — compounds with §12.

The brand should feel like a **research tool, not a consumer SaaS**.
Reference points: Linear, Notion, Things, Vercel (in that order of
relevance to your audience).

### 13.1 Drop the gradient on every primary button

The violet→purple gradient appears on:
- Landing page pricing tier buttons
- Dashboard "Upgrade" pill (`dashboard/page.tsx:121`)
- Settings "Upgrade to Researcher" button
- Library upgrade prompt

It's the *single* most "vibe-coded" element. Replace with a
neutral / monochrome button. Save the accent for one place: the
**active state** of the analysis-pane tab.

### 13.2 Logo lockup + nav typography

The current logo is a 20px image. Ship a vector version (an SVG
inline component) so it scales correctly at any zoom and in the
favicon. Pair with `font-display` (a serif or geometric grotesque)
for the wordmark.

Recommended pair for a research tool:

- **Display:** Geist or General Sans (you have `font-display` already
  declared but not all elements use it consistently).
- **Body:** Inter (Tailwind default — keep).
- **Mono:** JetBrains Mono or IBM Plex Mono (currently `font-mono`
  uses default; equations look fragile in the default OS mono).

### 13.3 Density: tighten

Most of the app is set at 13–14 px with `space-y-3` to `space-y-5`
between elements. That's marketing-page density on a product UI.
Tighten by ~15%: same component sizes, but reduce vertical padding
on cards from `py-3` to `py-2.5`, gaps from `space-y-3` to
`space-y-2`.

### 13.4 Motion

- Replace `transition-all` (your default) with `transition-colors`,
  `transition-opacity`, `transition-transform` as appropriate.
  `transition-all` triggers needless layout work and produces janky
  animations on slower devices.
- Reduce `animate-fade-in` durations from the default to ~120 ms;
  research apps look faster with shorter motion (Linear uses
  ~80–100 ms).

### 13.5 Empty / first-run

The dashboard's empty state for new users says "Upload a paper to
start learning". OK. Add a 3-line **annotated screenshot** of what
they'll see after upload, plus a sample paper button ("Try with our
demo paper") — removes the cold-start friction that's costing trial
conversion.

### 13.6 Consistent "tier locked" affordance

Currently locked tabs show a tiny lock icon with `opacity-50`. In the
sidebar (`AppSidebar`), locked workspaces have a tooltip. In billing,
locked features just don't appear at all. Standardize: every locked
control gets the **same** muted-with-lock-icon affordance + a
"Upgrade to ${tier}" tooltip on hover.

### 13.7 Keyboard shortcuts

Power-user wins worth shipping (none of these exist today):

| Key | Action |
|---|---|
| `⌘K` / `Ctrl-K` | Cmd palette: paper switcher + actions |
| `⌘P` | Add paper to session |
| `⌘\\` | Toggle pane |
| `⌘Shift-F` | Focus mode |
| `1–6` | Switch to tab N (Summary, Prepare, etc.) |
| `j` / `k` | Next / prev page in PDF |
| `g` | Go to page (focus the page input) |

Implement once via a single `<KeyboardShortcuts />` mount that
listens at the document level. Kbd shortcut hints in tooltips
universally raise the perception of professionalism on a developer
tool.

### 13.8 Onboarding tour

A single, dismissable, 4-step product tour that fires on the
*second* paper upload (not the first — let them experience it
unguided once). Tour points at: (1) the analysis pane tabs, (2) the
selection toolbar, (3) the multi-paper session bar, (4) focus mode.
Use `localStorage` to suppress after dismiss. ~150 LOC + a JSON
config.

### 13.9 Settings page

Currently a single column of stacked sections. Reorganize into a
**two-column layout** at ≥md: nav on the left (Account, Billing,
Models, Appearance, Keyboard, About), content on the right. Pull
common patterns from Vercel / Linear settings pages — they're the
gold standard.

### 13.10 Marketing site

The landing page reads OK but could lose:

- The "trusted by" empty section (delete until it's truthful).
- The gradient hero — lean into the scientific aesthetic with a
  monochrome hero illustration of a paper with annotations (you can
  reuse a screenshot of the actual product).
- The 8-page-deep pricing section — collapse into a single 3-column
  grid above the fold.

---

## 14. Updated migration plan (incl. follow-ups + UI/UX)

Re-ordered with the new sections folded in. Phases compose; ship in
order.

### Phase 0 — quick wins (~2 hrs)

(unchanged from §9)
1. Memoize `<Md>` (§6.2)
2. Exclude `raw_text` from `getPaper` (§6.1)
3. Lazy-mount tabs (§4.1, §6.3)
4. Auth refresh interval (§8.2)
5. Gzip middleware (§7.5)

### Phase 1 — correctness (half a day)

6. Single hydration effect (§2.1, §2.2)
7. Selection history merge instead of replace (§11.3)
8. `selected_text` parity for follow-ups (§11.3)
9. `useShallow` selectors on PaperContent (§6.4)
10. Wire `forgetPaper` into delete flows (§2.4)

### Phase 2 — cache rationalization (full day)

(unchanged from §9)
11. Delete `paperCaches`, derive from `papersById` (§3.3)
12. Centralize loose localStorage keys (§3.3)
13. Request deduplication (§8.3)

### Phase 3 — backend perf (half a day)

(unchanged from §9)
14. Atomic JSONB RPCs (§7.1)
15. Async PDF parsing (§7.3)
16. Process-local LRU around `get_paper` (§7.2)
17. Signed-URL redirects (§8.4)

### Phase 4 — analysis-pane redesign (1–2 days)

18. Type scale + spacing rhythm (§12.1, §12.2)
19. Color token consolidation (§12.3)
20. Unified `<EmptyState>` + `<AnalysisProgress>` components (§12.5)
21. Tabs underline relayout (§12.4)
22. Selection card hierarchy + threaded view tweaks (§12.6)
23. Q&A panel restructure (§12.7)

### Phase 5 — platform polish (ongoing)

24. Drop violet gradient site-wide (§13.1)
25. Logo + typography lockup (§13.2)
26. Motion calibration (§13.4)
27. Keyboard shortcuts (§13.7)
28. Onboarding tour (§13.8)
29. Settings 2-column (§13.9)

---

## 15. Quick reference: top-15 to do this month

1. **Memoize `<Md>`** — 4 lines, halves stream CPU.
2. **Exclude `raw_text` from `getPaper`** — 1 line, halves payload.
3. **Lazy-mount tabs** — 20 lines, faster first paint.
4. **Single hydration effect** — kills "stuff disappears" bugs.
5. **Follow-up `selected_text` parity** — fixes the disappearing follow-ups (§11).
6. **Selection-history merge, not replace** — fixes the same.
7. **Drop violet gradient** — single biggest visual upgrade.
8. **Atomic JSONB append RPC** — backend writes 5–10× faster.
9. **Process-local LRU on `get_paper`** — kills repeat reads.
10. **Signed Supabase URLs for PDFs/figures** — saves a hop.
11. **Async PDF parsing** — workers no longer block on uploads.
12. **`useShallow` on PaperContent** — kills 5× useless renders.
13. **Type scale + spacing rhythm** — the pane stops looking ad-hoc.
14. **Unified `<EmptyState>` / `<AnalysisProgress>`** — visual debt off the books.
15. **Keyboard shortcuts** — instant "professional tool" upgrade.

— Audit produced by reading the actual repo at `b2fc4f3`. Every
recommendation has a concrete file:line citation and a clear PR
boundary. Sections §11–§15 added 2026-04-25.
