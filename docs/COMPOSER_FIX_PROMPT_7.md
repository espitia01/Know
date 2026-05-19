# Know — implementation briefing #7 for Composer 2.5

> **Scope**: enable multi-paper **workspaces** for Researcher tier and ship the three reliability fixes that block them from being usable today: analysis-pane info leaking from one paper to another, slow paper switching, and uploading from the in-paper "Add Paper" popover not actually opening the new tab. Plus a perceived-latency rewrite of the Summary pipeline so the user sees a useful overview in <15 s instead of waiting 60–90 s for the deep summary.
>
> **Stack reminders**: Next.js 16 + AI SDK v6 + Zod 4. Streaming + selection/summary/figure routes are migrated to `frontend/src/app/api/papers/[id]/*-stream/route.ts`. Tier gating lives in Python (`backend/app/gating.py`) and frontend mirror (`frontend/src/lib/UserTierContext.tsx::TIER_FEATURES`). Summary stream is `useSummaryStream.ts` + `prompts/summary.ts` + `PaperSummarySchema`. Paper upload is `frontend/src/lib/api.ts::uploadPaper` → Python `/api/papers/upload`.
>
> **Rules to keep in mind** — read first:
> - `.cursor/rules/analysis-pane.mdc` (no new tokens, ≤200 LOC `BottomPanel`, primitives only)
> - `.cursor/rules/architecture.mdc` (streaming on Next, batch on Python, never local model)
> - `.cursor/rules/latex.mdc` (migrated paths use `$...$` / `$$...$$` markdown inside Streamdown — do **not** restore `preprocessLatex` / `remark-math` for the Summary takeaway)
>
> **Test plan**: after each track, `cd frontend && npm run lint && npm run build`. For backend changes, `cd backend && pytest -q tests`. Manually smoke each surface in the IDE preview against at least two papers in a session.
>
> **Order**: A → B → C → D → E (state refactor first because every other track depends on it; flag-flip last so we never ship a half-built workspace experience).

---

## Snapshot of the offending surfaces

| Concern | Files |
|---|---|
| Per-paper analysis state (single source of truth) | `frontend/src/lib/store.ts`, `frontend/src/lib/useSummaryStream.ts`, `frontend/src/lib/useSelectionThread.ts`, `frontend/src/lib/analysisState.ts`, every `frontend/src/components/sidebar/*Panel.tsx`, `frontend/src/components/panel/BottomPanel.tsx`, `frontend/src/app/paper/[id]/page.tsx` |
| Fast paper switching | `frontend/src/app/paper/[id]/page.tsx` (`handleSwitchPaper`, data-fetch effect, auto-extract effects), `frontend/src/components/header/SessionTabs.tsx` (new), `frontend/src/lib/papersFreshness.ts` (new) |
| Upload-from-popover navigation | `frontend/src/app/paper/[id]/page.tsx` (`handleUploadFiles`, `handleAddPaper`) |
| Two-phase summary | `frontend/src/lib/server/schemas.ts`, `frontend/src/lib/server/prompts/summary.ts` (split), `frontend/src/app/api/papers/[id]/summary-lite-stream/route.ts` (new), `frontend/src/app/api/papers/[id]/summary-stream/route.ts`, `frontend/src/lib/useSummaryStream.ts`, `frontend/src/components/sidebar/SummaryPanel.tsx`, `backend/app/api/analysis.py` (cache slot `summary_lite`) |
| Workspace feature flag + tier gate | `frontend/src/lib/workspaceFeatureFlags.ts`, `frontend/src/lib/UserTierContext.tsx`, `frontend/src/app/paper/[id]/page.tsx`, `frontend/src/components/header/PaperHeader.tsx` (header chrome), `frontend/src/app/library/page.tsx` |

Do **not** revert PROMPT_3/4/5/6 patterns (`UserSettingsContext`, `RichContent`, `syncAutoAnalyzeGuardsFromCache`, panel mount safety nets, `formatBibliography` 480-char cap, `OverflowMenu` body portal, math-aware `firstSentence`, Anthropic prompt caching, section-aware Prepare excerpt, Google Drive Picker). Build on top of them.

---

## Track A — per-paper analysis state (single source of truth)

### Reported symptom
> "Analysis pane containing the info of the other paper."

### Root cause
Most analysis slices in zustand are **global singletons**: `summary`, `preReading`, `assumptions`, `selectionResult`, `selectionHistory`, `qaResults`, `notes`, `exercise`, `searchResults`. Only `summaryStreamingByPaper`, `pdfRegionHighlightsByPaper`, `preReadingErrorByPaper`, `summaryErrorByPaper` are keyed. Today's mitigation is "blow them all away on switch (`resetAnalysisState`) + defensive `useStore.getState().paper?.id === pid` checks before each late write." Three concrete failure modes:

1. **Late writes splatter the wrong paper**: e.g. user starts Derive on paper A (`selectionThread.start`), switches to B, the migrated `/selection-stream` finishes and the `onFinish` writer adds the selection to `selectionHistory` *after* the user moved on. Defensive checks catch many but not all paths (e.g. `useSummaryStream` writes `setSummary` if `paper?.id === pid` — true on B but the partial it has *is A's*).
2. **Switch-back wipes**: B→A→B blows away B's state on the second switch even though we already had it cached; we re-hydrate from `papersById[B].cached_analysis` which may be slightly stale.
3. **Visible flicker**: `resetAnalysisState()` → empty pane → server fetch → hydrate. ~200–800 ms of empty space.

### Required fix

#### A1. Move analysis state into per-paper maps inside zustand

In `frontend/src/lib/store.ts` add (do not remove the singletons in the same commit — make singletons **derived selectors** so existing components keep compiling, then migrate panels in A3 to read the maps directly, then delete the singletons in A4):

```ts
// New per-paper maps. Each is `Record<paperId, T>` shaped exactly like the
// old singleton, plus an "owner" guard so writes from a stale paper id
// silently noop.
summaryByPaper: Record<string, PaperSummary | null>;
preReadingByPaper: Record<string, PreReadingAnalysis | null>;
assumptionsByPaper: Record<string, Assumption[]>;
notesByPaper: Record<string, Note[]>;
selectionHistoryByPaper: Record<string, SelectionAnalysisResult[]>;
selectionResultByPaper: Record<string, SelectionAnalysisResult | null>;
qaResultsByPaper: Record<string, QAItem[]>;
exerciseByPaper: Record<string, DerivationExercise | null>;
searchResultsByPaper: Record<string, SearchResult[]>;
preReadingLoadingByPaper: Record<string, boolean>;
assumptionsLoadingByPaper: Record<string, boolean>;
summaryLoadingByPaper: Record<string, boolean>;
selectionLoadingByPaper: Record<string, boolean>;
```

For each slice add an explicit setter that takes `(paperId, value)` as the **first** argument. **Never** mutate a per-paper slot without a paperId argument — that is the bug we're fixing.

#### A2. Active paper is the store's source of truth, not local state

Replace `useState<string>(paperId) → activePaperId` in `paper/[id]/page.tsx` with a store value:

```ts
activePaperId: string | null;
setActivePaperId: (id: string | null) => void;
```

The reader page sets it from the URL once on mount + every time `params.id` changes. Tab clicks call `setActivePaperId(id)` and `router.replace`. Effects keying on `activePaperId` read it from the store. `useSummaryStream(activePaperId)` and `useSelectionThread(activePaperId)` still take the id as a prop so React-key based remount semantics keep working.

#### A3. Panels read from `[paperId]` slot, never the singleton

Refactor each `*Panel` component to read `useStore((s) => s.summaryByPaper[paperId])` etc. The `paperId` prop is **always** present on every analysis panel today (`AnalysisPanel`, `SummaryPanel`, `PreReadingPanel`, `AssumptionsPanel`, `QAPanel`, `NotesPanel`, `SelectionResultPanel`). Panels become pure projections of `(store, paperId) → JSX`.

Concrete change for `SummaryPanel`:
```ts
// before
const cachedSummary = useStore((s) => s.summary) ?? null;
const summaryLoading = useStore((s) => s.summaryLoading);
// after
const cachedSummary = useStore((s) => s.summaryByPaper[paperId] ?? null);
const summaryLoading = useStore((s) => s.summaryLoadingByPaper[paperId] ?? false);
```

#### A4. Delete `resetAnalysisState` entirely

After A3 lands and every panel reads from a per-paper slot, the reset is unnecessary. `handleSwitchPaper` and the URL-driven effect just call `setActivePaperId(id)`. Remove:
- `resetAnalysisState` from `store.ts` (no callers should remain — fail the build if so).
- The `resetAnalysisState()` call in `setPaper`'s same-id branch (no longer needed).
- The `resetAnalysisState()` calls in `paper/[id]/page.tsx` (`handleSwitchPaper` + URL-driven effect).

The `clearSession` action keeps existing semantics — it wipes session list + every per-paper slot it owns.

#### A5. Hydration writes to the active paper's slot, not the singleton

`hydrateFromCachedAnalysis` already takes the cache; it now also takes `paperId` explicitly and writes to `summaryByPaper[paperId]`, `preReadingByPaper[paperId]`, etc. Drop the `paper?.id === paperId` check at the entrypoint — the function is keyed by id, not by "is this still the active paper."

Same change for `useSummaryStream`: every `setSummary` / `setSummaryError` / `setSummaryLoading` becomes `set...(paperId, …)`. Aborts on paper switch are **gone** — let the stream finish into its own slot. The user just doesn't see it while on the other paper. If the user returns to it before it finishes, the partial is already rendered.

#### A6. Persisted store slice update

`store.ts`'s `partialize` currently persists only `sessionPapers`, `pdfRegionHighlightsByPaper`, `headerHidden`, `focusMode`, `analysisFontScale`, `analysisFontFamily`, `uiPrefs`. **Do not** persist any of the new per-paper analysis maps — they are always re-hydrated from server `cached_analysis`. Persisting them would balloon localStorage and risk staleness. Do persist `activePaperId` so a tab close → reopen lands on the last paper.

#### A7. Tests

Add `frontend/src/lib/__tests__/store.test.ts` (Vitest may not be wired up — if not, `.skip` the cases and leave them for the next test sweep):
- Switching from A → B → A reads A's slot, not B's.
- A late `setSummaryByPaper("A", x)` write while user is on B does **not** alter B's panel render path.
- `clearSession()` removes all per-paper slots; switching to a never-seen paper renders empty until hydration lands.

### Acceptance
- In a session of 3 papers, click between tabs rapidly: each tab shows **only** its own summary/prepare/assumptions/selections/notes.
- A slow Derive on paper A completes after switching to B — the result lands in A's selection history, not B's. Switching back to A shows the new result.
- `npm run lint`, `npm run build` pass.

---

## Track B — fast paper switching

### Reported symptom
> "Taking lots of time to switch between papers."

### Root cause
`handleSwitchPaper` aborts streams, wipes state, navigates the URL, and triggers `api.getPaper(id)` again — every switch is a fresh fetch. `papersById[id]` (the in-memory LRU) is **only** used to seed the initial render before `getPaper` overwrites it; the network call still runs.

### Required fix

#### B1. Freshness gate on `api.getPaper`

New module `frontend/src/lib/papersFreshness.ts`:
```ts
const FRESH_FOR_MS = 5 * 60_000;
const lastFetchedAt = new Map<string, number>();
export function markPaperFetched(id: string) { lastFetchedAt.set(id, Date.now()); }
export function isPaperFresh(id: string): boolean {
  const t = lastFetchedAt.get(id);
  return t != null && Date.now() - t < FRESH_FOR_MS;
}
export function invalidatePaper(id: string) { lastFetchedAt.delete(id); }
```

In `paper/[id]/page.tsx`, change the data-fetch effect:
```ts
const cached = useStore.getState().papersById[activePaperId];
if (cached) {
  setPaper(cached);
  initialLoadDone.current = true;
  setLoading(false);
}
// Skip the network call when we have a fresh cached copy.
if (!isPaperFresh(activePaperId)) {
  api.getPaper(activePaperId).then(...).finally(...);
  markPaperFetched(activePaperId);
}
```

Invalidate freshness in:
- `api.updateFolder`, `api.updateTags`, `api.updateTitle` → `invalidatePaper(id)` on success.
- `api.reextractFigures` → `invalidatePaper(id)`.
- `useStore.updateCachedAnalysis` callers (no — we *just* updated the local cache, don't refetch).

#### B2. Do not abort the previous paper's streams on switch

Today `handleSwitchPaper` calls `abortActiveSummaryStream(activePaperId)` and `selectionThread.abort()`. After Track A, those streams write to their own slot — let them run.

Concrete changes in `handleSwitchPaper`:
- Remove `abortActiveSummaryStream(activePaperId)`.
- Remove `selectionThread.abort()`.
- Remove `setSelection(null)`, `setSelectionResult(null)` (per-paper now).
- Remove `if (hasActiveRequest(id, "preReading")) setPreReadingLoading(true);` (loading flags are per-paper now, the slot already has the right value).
- Keep `syncAutoAnalyzeGuardsFromCache(id, ...)` — that's the per-paper retry path.

The function should reduce to:
```ts
const handleSwitchPaper = useCallback((id: string) => {
  if (id === activePaperId) return;
  const nextCache = useStore.getState().papersById[id]?.cached_analysis ?? {};
  syncAutoAnalyzeGuardsFromCache(id, nextCache, nextCache);
  setActivePaperId(id);
  if (typeof window !== "undefined" && id !== paperId) {
    router.replace(`/paper/${id}`);
  }
}, [activePaperId, paperId, router]);
```

#### B3. SessionTabs prefetch on hover

New component `frontend/src/components/header/SessionTabs.tsx` (extracted from the inline session bar in `paper/[id]/page.tsx`). On `onMouseEnter` for a tab, if `!papersById[id]` AND `!isPaperFresh(id)`:
```ts
void api.getPaper(id).then((p) => useStore.getState().cachePaper(p));
markPaperFetched(id);
```

This kills the perceived switch latency: by the time the user clicks, the paper is already in the cache.

#### B4. Acceptance
- In a 3-paper session, switching between tabs feels **instant** (no network round-trip, no spinner) provided each paper has been fetched once in the last 5 minutes.
- Hovering a tab for ~200 ms before clicking warms the cache so even the first switch to a paper feels instant.
- After editing a paper's folder/title, switching to it shows the new value (freshness invalidated).

---

## Track C — upload-from-in-paper popover correctly opens the new paper

### Reported symptom
> "Uploading papers from individual paper never loaded the second."

### Root cause
`AddPaperPopover.handleUploadFiles` calls `onAdd(paper.id, paper.title)` once for the first completed upload. `onAdd` is `handleAddPaper`, which calls `handleSwitchPaper(id)`. `handleSwitchPaper` does `setActivePaperId(id) + router.replace(/paper/${id})`. The URL-driven effect's gate is `if (paperId !== activePaperId)` — both are now the new id, so it noops. Meanwhile the popover closes via `setShowAddPaper(false)`, the data-fetch effect fires on `activePaperId` change, `papersById[id]` exists (we cached it), so `setPaper(cached)` runs. **In theory this works**. In practice users report it doesn't.

Two latent issues:
1. The cached `ParsedPaper` from upload has `cached_analysis = {}`, no figures yet. The reader shows the PDF instantly but the analysis pane shows the empty state, and the auto-extract effect kicks off Prepare/Summary fresh. Users may interpret "Prepare runs again from zero" as "the new paper didn't load."
2. `router.replace` (not `push`) means browser back button cannot return to the previous paper. Users hit back, nothing happens, conclude the switch failed.

### Required fix

#### C1. Use `router.push` for upload-driven navigation

Change `handleAddPaper`:
```ts
const handleAddPaper = useCallback((id: string, title: string) => {
  addSessionPaper({ id, title });
  if (id !== activePaperId) {
    // push (not replace) so browser back returns to the previous paper.
    setActivePaperId(id);
    router.push(`/paper/${id}`);
  }
  setShowAddPaper(false);
}, [addSessionPaper, activePaperId, setActivePaperId, router]);
```

Keep `router.replace` only for **tab clicks** (URL hygiene without polluting history) — that's `handleSwitchPaper`.

#### C2. Pre-seed cache + freshness marker on successful upload

In `AddPaperPopover.handleUploadFiles`, after each `cachePaper(paper)`:
```ts
markPaperFetched(paper.id);
```

so the data-fetch effect doesn't waste a round-trip refetching what the upload already returned.

#### C3. Multi-file uploads — open the first, queue the rest

Current behavior is "open the first that completes." That's fine. Add a small caveat: also call `addSessionPaper` for **every** completed upload (current code already does — keep). The user sees N new tabs and lands on whichever finished first.

#### C4. Acceptance
- Upload one PDF from inside a paper → new tab appears, switches immediately, browser back returns to the previous paper.
- Upload three PDFs simultaneously → all three appear as tabs, first one to finish opens.
- Cancelling the popover mid-upload does **not** abort the upload — completed papers still appear as tabs.

---

## Track D — two-phase Summary (lite first, deep dive on demand)

### Reported symptom
> "See why the summary takes very long in the analysis pane."

### Root cause
`PaperSummarySchema` asks for 10 multi-paragraph fields including `methodology` / `main_results` / `discussion` ("multi-paragraph markdown" × 3). With `maxOutputTokensFor("sonnet", "analysis") = 6000`, Sonnet emits ~20k chars → 60–90 s typical. The "Generating detailed summary…" spinner camps for the entire duration because the panel renders nothing useful until `overview` is non-empty (~3–6 s in) — and even then "Loading the rest" is most of the wait.

### Required fix

#### D1. Split the schema

In `frontend/src/lib/server/schemas.ts`:
```ts
export const PaperSummaryLiteSchema = z.object({
  model: z.string().optional(),
  created_at: z.number().optional(),
  overview: z.string().describe("3–5 sentence high-level overview."),
  tl_dr: z.string().describe("One-sentence takeaway, math-aware ($...$ allowed)."),
  key_contributions: z.array(z.string()).describe("1–2 sentence bullets, 3–5 items."),
  key_equations: z.array(
    z.object({
      equation: z.string(),
      meaning: z.string(),
    })
  ).optional().describe("Up to 3 most important equations."),
});

export const PaperSummaryDeepSchema = z.object({
  model: z.string().optional(),
  created_at: z.number().optional(),
  motivation: z.string().describe("3–5 sentences, why this work."),
  methodology: z.string().describe("1–2 paragraph markdown."),
  main_results: z.string().describe("1–2 paragraph markdown with quantitative numbers in $...$."),
  discussion: z.string().describe("1–2 paragraph markdown."),
  limitations: z.array(z.string()).optional(),
  future_work: z.string().optional(),
  key_figures_and_tables: z.array(
    z.object({ id: z.string(), description: z.string() })
  ).optional(),
});

export type PaperSummaryLite = z.infer<typeof PaperSummaryLiteSchema>;
export type PaperSummaryDeep = z.infer<typeof PaperSummaryDeepSchema>;
export type PaperSummary = PaperSummaryLite & PaperSummaryDeep;
```

Note that the **union** `PaperSummary` is still what panels render — they don't care which slice the field came from. This keeps the existing `SummaryPanel` rendering logic intact.

#### D2. Two prompts, two routes

`frontend/src/lib/server/prompts/summary.ts` exports two builders: `buildSummaryLitePrompt` and `buildSummaryDeepPrompt`. The lite prompt is ~12 lines of rules; the deep prompt is the existing prompt minus `overview`/`tl_dr`/`key_contributions`/`key_equations`.

New route `frontend/src/app/api/papers/[id]/summary-lite-stream/route.ts` — mirrors the current `summary-stream` route but uses `PaperSummaryLiteSchema` and `buildSummaryLitePrompt`. `maxOutputTokensFor("fast", …) = 3000` is plenty for the lite payload (~1.5–2k tokens). Caching:
- System prompt: `ANTHROPIC_CACHE_EPHEMERAL`.
- `paperContextText`: also cached. The deep route can reuse the **same** paper context cache breakpoint (both routes hit the same cache key) so the second call is mostly a cache read.

`frontend/src/app/api/papers/[id]/summary-stream/route.ts` keeps its current shape but with the new (trimmed) deep schema + prompt and `maxOutputTokensFor` adjusted: keep at 6000 to preserve quality on long methods sections.

Both routes accept a `model` body field (already wired) so Researcher can pick Opus for the deep dive if desired.

#### D3. Backend persistence — one slot for each phase

Add two cache slots on the Python side (no migration needed — `cached_analysis` is JSON):
- `cached_analysis.summary` — keep the existing slot for the deep summary.
- `cached_analysis.summary_lite` — new slot for the lite summary.

The Next.js routes write to these via `upsertCachedAnalysis(paperId, key, value)` exactly as today.

The Python `/api/papers/{id}/summary` batch endpoint (used as fallback) returns the deep schema as today. Add `/api/papers/{id}/summary-lite` as a thin Python equivalent of the lite stream for environments where the Vercel route fails — `analyze_paper`-style implementation in `backend/app/services/llm.py::summarize_paper_lite`. Add tests for both.

#### D4. `useSummaryStream` orchestrates both

Rename to `useSummary` and expose two starters:
```ts
const { startLite, startDeep, stopLite, stopDeep, lite, deep, errorByPaper } = useSummary(paperId);
```

Where:
- `startLite()` is auto-kicked from the page-level auto-extract effect (replaces `kickoffSummaryStream`).
- `startDeep()` is auto-kicked **once `lite` has overview** AND the user has the Summary tab mounted/visible (`AnalysisPanel` is the source of truth for tab visibility — see `mountedTabs`).
- Both write into `summaryByPaper[paperId]` as a merge: `{ ...deep, ...lite }` (lite wins because it has the takeaway; deep adds methodology etc).
- 30 s stall fallback: lite falls back to Python `summarize_paper_lite`; deep falls back to existing batch.

#### D5. UI rendering

`SummaryPanel.tsx`:
- Render `tl_dr` + `overview` + `key_contributions` + `key_equations` **as soon as lite finishes** (typically 8–15 s on Sonnet).
- Show a small inline pulse "Loading the deep dive…" under the lite content while deep streams in.
- Show methodology / main_results / discussion / limitations / future_work / figures **only once present**; do not show empty section shells.
- If deep stream fails but lite landed, render lite alone with a small "Couldn't generate the deep dive — [Retry]" line at the bottom. The panel is still useful.

#### D6. Acceptance
- New paper open → useful summary content visible in **<15 s** (lite) instead of 60 s.
- Deep summary continues streaming in and lands without user action.
- Switching away from a paper while its deep summary is mid-stream **does not** abort the stream (per Track A); coming back shows whatever has arrived.
- `cached_analysis.summary_lite` populated separately from `cached_analysis.summary` after the first run.
- On a paper whose deep summary failed once, the lite summary still renders and the deep retry button works.

---

## Track E — enable workspaces for Researcher tier

### Required fix

#### E1. Flag flip + new feature gate

`frontend/src/lib/workspaceFeatureFlags.ts`:
```ts
export const WORKSPACE_FEATURES_TEMPORARILY_DISABLED = false;
// Keep the tooltip export for downstream chrome that disables affordances
// for non-Researcher tiers; rephrase from "coming soon" to "Researcher only."
export const WORKSPACE_FEATURES_TIER_LOCKED_TOOLTIP =
  "Workspaces are part of the Researcher plan. Upgrade in Settings to add papers to a session and save workspaces.";
```

`frontend/src/lib/UserTierContext.tsx::TIER_FEATURES`:
- Add `"workspace"` to the Researcher set only.

Replace every read of `WORKSPACE_FEATURES_TEMPORARILY_DISABLED` with `!canAccess(tier, "workspace")` (rename the local variables for clarity — `workspaceLocked` instead of `workspaceFeaturesComingSoon`). Affected files:
- `frontend/src/app/paper/[id]/page.tsx`
- `frontend/src/components/header/PaperHeader.tsx` (or wherever the session bar/+ Add Paper button lives)
- `frontend/src/app/library/page.tsx`

#### E2. Researcher reader chrome

- Session tabs row visible only when `canAccess(tier, "workspace")` AND `sessionPapers.length > 1` (or the user clicked "+ Add Paper" once — gated).
- "+ Add Paper" button always shown for Researchers; renders `WORKSPACE_FEATURES_TIER_LOCKED_TOOLTIP` and an `UpgradeModal` trigger for Scholar/Free.
- "Save workspace" / "Open workspace" menu items hidden entirely for non-Researcher.

#### E3. Cross-paper QA

The `CrossPaperPanel` is also workspace-gated. Lock it behind `canAccess(tier, "workspace")` (was `multi-qa`). For Scholar/Free tiers, hide the panel rather than show a locked stub.

#### E4. Library page

`/library` → "Workspaces" tab: visible for everyone, but **read-only** for non-Researcher (they see saved workspaces from a previous Researcher-tier subscription but can't open them; show the upgrade tooltip on click).

#### E5. Acceptance
- Researcher signed in: session tabs, + Add Paper, save/open workspace, cross-paper QA all work.
- Scholar/Free signed in: chrome shows the affordances disabled with the upgrade tooltip; library workspace list is read-only.
- Existing "multi-qa" feature still gates cross-paper QA (Scholar got a regression-safe path — keep the gate for that route specifically).
- `npm run lint` + `npm run build` + `pytest backend/tests -q` pass.

---

## Edge cases to keep in mind

1. **Session with deleted papers**: `handleLoadWorkspace` in `paper/[id]/page.tsx` already skips deleted-paper ids. Keep that logic.
2. **localStorage quota**: `sessionPapers` persists. Cap at **16** session papers in `addSessionPaper` (oldest non-active evicted). Surfacing this with a toast is fine but not required.
3. **PDF blob churn**: switching paper does **not** unmount `PdfViewer` for the previous paper — it's re-keyed on `paperId`. Keep the per-paper scroll position in `uiPrefs.scrollByPaper`.
4. **Selection mid-stream then switch**: `selectionThread.start` writes to `selectionResultByPaper[paperId]` (per Track A). User switches to B mid-stream. Stream finishes, writes to A's slot. User switches back to A → sees the completed selection.
5. **Late summary deep stream**: per D6, no abort on switch. If user has switched away by the time deep finishes, the deep result still upserts to A's `summaryByPaper` slot. No UI surprise.
6. **Free tier in workspace UI**: gating must not break the single-paper experience. Single-paper users see no session bar at all.
7. **Trial flow (`/try`)**: unchanged. Anonymous trial never gets workspaces.
8. **Picker upload from popover**: Google Drive button in `AddPaperPopover` (per PROMPT_6) goes through the same `handleUploadFiles → onAdd` pipeline, so Track C fix benefits it too.
9. **Race on `setActivePaperId`**: persist the active id to localStorage but **only** flush on `window.beforeunload` or visibilitychange to "hidden" — avoid thrashing localStorage on every tab click.
10. **Per-paper progress bars**: `getProgressStart(paperId, kind)` / `clearProgressStart(paperId, kind)` from `analysisState.ts` already paper-keyed — keep using them, just guarantee panels read by paperId.
11. **Streaming summary fallback timer**: keep the 55 s Vercel cap but apply it per phase (lite has its own timer, deep has its own).
12. **Existing `cached_analysis.summary` payloads**: must continue rendering. Treat as "deep" content; `summary_lite` may be missing on old papers — the lite stream auto-runs on first render to fill it.
13. **Tab-key navigation**: `SessionTabs` must be keyboard-accessible (`role="tablist"`, arrow keys move focus, Enter/Space activates). Use the existing `AnalysisTabs` primitive shape where possible.

---

## Final QA checklist

- [ ] `npm run lint` + `npm run build` (frontend) pass.
- [ ] `pytest backend/tests -q` passes including new `test_summarize_lite.py`.
- [ ] In a 3-paper session, switching between tabs is instant on warm cache, ≤300 ms on cold.
- [ ] Slow Derive on paper A completes after switching to B; result lands in A's selection list.
- [ ] Upload from in-paper popover navigates the user to the new paper; browser back returns to the previous one.
- [ ] Lite summary content visible in ≤15 s on a typical 10-page paper (Sonnet, no cache).
- [ ] Deep summary streams in over the lite content without flicker.
- [ ] Researcher tier sees session tabs + save/open workspace + cross-paper QA.
- [ ] Scholar tier sees a locked-tooltip "+ Add Paper" affordance and locked Save Workspace menu items.
- [ ] Free tier sees no workspace chrome (no session bar, no + Add Paper).
- [ ] No regressions in PROMPT_3/4/5/6 features.

---

## Notes for the implementer

- Order matters: A → B → C → D → E. Track A is the largest blast radius; Tracks B/C are small once A is in. Track D is independent of A but easier after A (`useSummary` writes to per-paper slots). Track E is just chrome and gating.
- Migrate panels in A3 one at a time, keep the build green at every step. Use temporary `const summary = useStore(s => s.summaryByPaper[paperId] ?? s.summary)` adapters while singletons still exist; delete the adapters in A4.
- All four reliability bugs are reproducible on the staging environment. Test against a workspace of (1) a fresh paper, (2) a paper with cached_analysis populated, (3) a paper that previously failed Prepare.
- Push to `main` as a single commit titled `feat(workspace): enable Researcher workspaces, fix paper-switching races, two-phase summary` once acceptance passes. Composer 2.5 should not split this into multiple PRs unless the user asks.
