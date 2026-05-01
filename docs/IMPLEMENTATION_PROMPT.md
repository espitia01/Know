# Implementation Prompt — Analysis Pane Audit

A single, self-contained prompt for a coding agent (Claude / GPT / Codex)
to implement every fix from `docs/ANALYSIS_PANE_AUDIT.md` in the right
order, with the right guardrails, and without breaking the live app.

> **How to use this:** Copy the entire `## PROMPT START` block below into
> the agent's first message. The agent will work in phases, opening one
> PR per phase, running lint + typecheck before every commit, and
> asking before touching anything explicitly listed under
> "Stop-and-ask conditions".

---

## Reading order for the agent

1. This file (`docs/IMPLEMENTATION_PROMPT.md`) — the contract.
2. `docs/ANALYSIS_PANE_AUDIT.md` — the spec being implemented.
3. The repo, file by file, **only as referenced** in the audit.

The agent **must not** read or re-organize anything outside the cited
files unless explicitly told to.

---

## PROMPT START

> The text below is what you copy into the agent. Treat everything from
> here to `## PROMPT END` as one prompt.

---

You are implementing the fixes documented in
`docs/ANALYSIS_PANE_AUDIT.md` for the **Know** repo (Next.js 15 + React
19 frontend in `frontend/`; FastAPI + Python 3.13 backend in
`backend/`; Supabase Postgres + Storage; Clerk auth; Stripe billing;
Railway deploy).

Your single job is to ship the fixes from §1 through §15 of that audit
**without regressing the live product**. The audit is your spec; this
prompt is your contract.

### Mission

Implement every numbered fix in `docs/ANALYSIS_PANE_AUDIT.md`, in the
order set by §14 (Phase 0 → Phase 5). Each phase becomes **one git
commit** (or PR if asked). Each phase ends with a clean
`tsc --noEmit` and a clean `eslint --max-warnings 0` on the affected
frontend files, plus `python -m py_compile` on every changed Python
file. Backend SQL migrations get their own phase commit and a smoke
test against a local Supabase if available.

### Success criteria

Per the audit's "Quick reference" (§15):

1. `<Md>` is memoized.
2. `getPaper` no longer ships `raw_text`.
3. Inactive analysis-pane tabs lazy-mount.
4. The four hydration effects collapse into one.
5. Follow-up `selected_text` is preserved server-side and a separate
   `question` field surfaces for the threaded view.
6. `selectionHistory` hydration merges (not replaces).
7. The violet→purple gradient is gone from every primary CTA.
8. JSONB-append RPC for selection / Q&A writes (1 RPC per).
9. `get_paper` has a process-local LRU.
10. PDFs and figures are served via signed Supabase URLs.
11. PDF parsing on upload runs in `run_in_executor`.
12. `PaperContent` reads the store via `useShallow`.
13. Type / spacing tokens are unified.
14. `<EmptyState>` and `<AnalysisProgress>` are unified components.
15. A single `<KeyboardShortcuts>` mount adds ⌘K, ⌘\\, ⌘Shift-F, 1–6,
    j/k/g.

Definition of "done" for any one fix:

- The cited file + line(s) in the audit have been changed in line with
  the recommendation.
- The change is covered by a brief comment that explains the *why*
  (not the *what*).
- `tsc` + `eslint` clean. `python -m py_compile` clean. App runs
  locally.
- A short manual verification (listed under each fix) passes.

### Workflow rules (read these every time)

1. **Work one phase at a time.** Don't start Phase N+1 until Phase N
   is committed and pushed.
2. **Read first, write second.** Open the audit's cited file:line
   ranges with the Read tool. Confirm the code still matches the
   audit's premise. If the file shape has drifted, **stop and report**
   what you observed; do not improvise.
3. **Use the smallest possible diff.** Reformat-only edits are
   prohibited. If you need to add a comment, add a comment — don't
   rewrite the function.
4. **No reformatting outside the changed lines.** Preserve indentation
   and trailing whitespace exactly.
5. **Comment the *why*, not the *what*.** Reference the audit
   section, e.g. `// Per audit §6.2: memoize to avoid re-running
   preprocessLatex on every stream chunk.`.
6. **Verify after every commit.** Run the per-phase verification
   listed below before moving on.
7. **Never break the public API surface.** Frontend `api.ts` exports
   are consumed by 30+ files. If you must change a signature, add an
   overload or deprecated wrapper, don't break callers.
8. **Never run destructive shell commands** (`rm -rf`, `git reset
   --hard`, `git push --force`, DB-truncate, etc.) unless this prompt
   explicitly tells you to.
9. **Never edit secrets / `.env*` / migration files older than the
   newest committed migration**. New migrations get a new
   sequentially-numbered file.
10. **Stop-and-ask** any time:
    - The audit cites a line range that no longer exists.
    - A fix conflicts with a more recent commit on `main`.
    - You'd need to drop a column or change a Stripe price.
    - You'd need to remove or rename a public API endpoint.

### Tooling you will use

- **`Read`** — open files. Always read before edit.
- **`Grep` / `Glob`** — locate cross-file references (don't `find`).
- **`StrReplace` / `Write`** — make changes.
- **`Shell`** — only for `npx tsc --noEmit`, `npx eslint`,
  `python -m py_compile`, `git status`, `git add`, `git commit`,
  `git push`. Nothing else without asking.
- **`TodoWrite`** — keep a live task list for the current phase.

You may run multiple read tools in parallel when the next reads are
independent (e.g. open three audit-cited files at once). Never
parallelize edits.

### Commit style

One commit per phase. Format:

```
<type>(<scope>): <imperative phase summary>

Per docs/ANALYSIS_PANE_AUDIT.md §<phase> — <one-line rationale>.

Changes:
- <file:line> — <one-line description>
- ...

Verified:
- tsc --noEmit (clean)
- eslint --max-warnings 0 (clean on touched files)
- manual: <what you smoke-tested>
```

Examples of `<type>(<scope>)`:

- `perf(frontend): phase 0 quick wins`
- `fix(frontend): phase 1 hydration & follow-up correctness`
- `refactor(frontend): phase 2 cache consolidation`
- `perf(backend): phase 3 jsonb appends + lru + signed urls`
- `feat(ui): phase 4 unified components + tab redesign`
- `feat(ui): phase 5 keyboard shortcuts + polish`

### What "Stop-and-ask" looks like

Reply with the **literal sentence**:

> **Stop-and-ask:** I need confirmation before continuing. <reason>.

Then list:

1. The audit section you're on.
2. The exact text or behavior you observed.
3. Two or three options for how to proceed, with trade-offs.

Do not proceed until the user replies. Do not silently pick one option.

---

## PHASE 0 — Quick wins

> Reference: audit §14 Phase 0. Single PR. Target: ~2 hours of work.

### 0.1 Memoize `<Md>`

**File:** `frontend/src/components/ui/Md.tsx`
**Audit ref:** §6.2

Read the existing component (~60 lines). Wrap with `React.memo` and
hoist `preprocessLatex` into `useMemo`:

```tsx
import { useMemo, memo } from "react";

export const Md = memo(function Md({ children, className }: MdProps) {
  // Per audit §6.2: preprocessLatex was re-running on every parent
  // re-render (every stream chunk on summaries). Memoizing on
  // `children` collapses thousands of regex passes into one.
  const processed = useMemo(() => preprocessLatex(children), [children]);
  return (
    <div className={className ?? "analysis-content"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{ a: /* unchanged */ }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
});
```

Do not change the component's signature, props, or display behavior.

**Verify:** stream a summary on a paper with LaTeX equations. Confirm
nothing visually changed; CPU during the stream should be visibly
lower in DevTools' Performance panel (optional manual check).

### 0.2 Exclude `raw_text` from `getPaper`

**File:** `backend/app/api/papers.py:147–155`
**Audit ref:** §6.1

Read the existing decorator + handler. Add `response_model_exclude` to
the route:

```python
@router.get(
    "/{paper_id}",
    response_model=ParsedPaper,
    response_model_exclude={"raw_text"},  # per audit §6.1: client never reads it
)
async def get_paper_by_id(paper_id: str, user_id: str = Depends(require_auth)):
    ...
```

Then check **frontend usage** with `Grep` for `paper.raw_text`,
`paper?.raw_text`, `cached.raw_text`. **Stop-and-ask if any callers
exist.** Otherwise no further changes are needed.

**Verify:** open the network tab on a paper switch. The
`/api/papers/{id}` response is now ~10–25 KB instead of 100–500 KB.

### 0.3 Lazy-mount inactive tabs

**File:** `frontend/src/components/panel/BottomPanel.tsx:322–346`
**Audit ref:** §4.1, §6.3

Add a `mountedTabs` set; only render `<TabsContent>` for tabs that
have been visited:

```tsx
const [mountedTabs, setMountedTabs] = useState<Set<string>>(
  () => new Set([effectiveTab]),
);
useEffect(() => {
  setMountedTabs((s) => {
    if (s.has(effectiveTab)) return s;
    const next = new Set(s);
    next.add(effectiveTab);
    return next;
  });
}, [effectiveTab]);
```

Wrap each `<TabsContent>` in `{mountedTabs.has(<value>) && (...)}`.
Keep `forceMount` so the active tab survives switching back without
remount.

**Verify:** open a fresh paper. Confirm only the Summary tab's
panel mounts on first paint (DevTools React tree). Click each tab in
turn — they mount on first visit and stay mounted afterwards.

### 0.4 Auth refresh interval + 401 retry

**File:** `frontend/src/lib/api.ts:24–30, 49–60`
**Audit ref:** §8.2

Change the 45 s interval to 50 min (`50 * 60 * 1000`). Add a single
401-driven retry inside `request<T>`:

```ts
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders();
  let res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...headers },
  });
  // Per audit §8.2: refresh once and retry on 401 instead of polling
  // every 45s — Clerk JWTs are valid for ~60 minutes.
  if (res.status === 401 && _getToken) {
    await refreshToken();
    const retryHeaders = await authHeaders();
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...retryHeaders },
    });
  }
  // ... existing error handling ...
}
```

**Verify:** sign in, leave the tab open for ≥1 minute, hit any API.
Confirm a single token refresh in the network tab (not 80).

### 0.5 Gzip middleware

**File:** `backend/app/main.py` (after `CORSMiddleware`)
**Audit ref:** §7.5

```python
from fastapi.middleware.gzip import GZipMiddleware
# Per audit §7.5: long summaries / JSON responses save ~70% wire bytes.
app.add_middleware(GZipMiddleware, minimum_size=1024)
```

**Verify:** `curl -H 'Accept-Encoding: gzip' -i
http://localhost:8000/api/papers/<id>/summary-stream` returns
`Content-Encoding: gzip` for non-trivially-sized responses.

### Phase 0 verification + commit

```bash
cd frontend && npx tsc --noEmit && npx eslint src --max-warnings 0
python -m py_compile backend/app/main.py backend/app/api/papers.py
```

Commit message:

```
perf(frontend, backend): phase 0 quick wins from analysis-pane audit

Per docs/ANALYSIS_PANE_AUDIT.md §14 Phase 0 — five low-risk changes
that compose for ~30-50% perceived speed improvement.

Changes:
- Md.tsx — memoize component + preprocessLatex (§6.2)
- papers.py — exclude raw_text from getPaper response (§6.1)
- BottomPanel.tsx — lazy-mount inactive tabs (§4.1, §6.3)
- api.ts — auth refresh on 401 + 50min interval (§8.2)
- main.py — gzip middleware (§7.5)

Verified: tsc + eslint clean; smoke-tested paper switch + summary stream.
```

---

## PHASE 1 — Correctness (hydration & follow-ups)

> Reference: audit §14 Phase 1, §11. Single PR. Target: half a day.

### 1.1 Single hydration effect

**File:** `frontend/src/app/paper/[id]/page.tsx:491–510, 665–679,
681–712, 727–859`
**Audit ref:** §2.1, §2.2

Read each effect. Verify line ranges still match. Then collapse:

- Keep the URL→activePaperId effect as-is.
- Keep the `paperCaches` initial-restore effect.
- Keep the `getPaper` data-fetch effect.
- **Replace the server-hydration effect (the big one) with two
  smaller effects**:

```tsx
// (a) Hydrate per-paper state from cached_analysis. Runs ONCE per paperId.
const hydratedFor = useRef<string | null>(null);
useEffect(() => {
  if (!paper || paper.id !== activePaperId) return;
  if (hydratedFor.current === paper.id) return;
  hydratedFor.current = paper.id;
  hydrateFromCachedAnalysis(paper.cached_analysis ?? {});
}, [paper?.id, activePaperId]);

// (b) Auto-trigger pre-reading / assumptions ONCE tier is known.
useEffect(() => {
  if (!paper || paper.id !== activePaperId) return;
  if (tierLoading) return;
  // ... the existing canAccess + autoAnalyzedPapers + markRequestStart logic
  // moved here verbatim, no JSON.stringify checks ...
}, [paper?.id, activePaperId, tierLoading, tierUser?.tier]);
```

`hydrateFromCachedAnalysis` is a new helper inside the component that
encapsulates the "if (cache.summary) setSummary(...)" / "if
(cache.qa_sessions) ..." reads. It does **not** include the
`selectionHistory` merge — that moves to §1.3.

**Stop-and-ask** if either of:

- `restorePaperCache` is now never called (we want to keep it for
  fast tab-switching).
- A test or storybook references the old effect's behavior.

### 1.2 Follow-up parity (`selected_text` + `question`)

**Files:**
- `frontend/src/lib/api.ts` (interface `SelectionAnalysisResult`)
- `frontend/src/components/panel/BottomPanel.tsx:142–169`
- `frontend/src/components/panel/SelectionResultPanel.tsx`
- `backend/app/services/llm.py` (`analyze_selection`)
- `backend/app/api/analysis.py` (`selection_analysis`)
**Audit ref:** §11.3 step 1

(a) Add `question?: string` to `SelectionAnalysisResult` in `api.ts`.

(b) Frontend `handleFollowUp`: stop overriding `selected_text`. Send a
new `question` field; persist exactly what the server stores:

```ts
const result = await api.analyzeSelection(
  paperId,
  `${context}\n\nFollow-up question: ${question}`,
  "followup",
  { question },                       // ← new optional payload
);
const followUpResult: SelectionAnalysisResult = {
  ...result,
  action: "followup",
  question,                           // ← surface for threaded view
};
addSelectionToHistory(followUpResult);
```

(c) `api.analyzeSelection` accepts an optional 4th arg `extra?:
{question?: string}`. Pass through to the request body.

(d) Backend `selection_analysis` endpoint reads `body.get("question")`
and writes it onto the result dict before persistence:

```python
question = (body.get("question") or "").strip()[:2000]
result = await analyze_selection(...)
if question:
    result["question"] = question
```

(e) `SelectionResultPanel` renders `result.question ?? selected_text`
in the "You asked" label of the threaded follow-up view. Update
`selectionKey()` to prefer `question` over `selected_text` for
follow-ups so identity is stable across re-hydration.

**Verify:** post a follow-up. Refresh the page. Confirm:

- The follow-up still appears under the same root.
- The "You asked" label shows the *short* user question, not the
  long context+question string.
- The threaded grouping survives the refresh.

### 1.3 Selection history merge instead of replace

**File:** `frontend/src/app/paper/[id]/page.tsx:745–762`
(now part of `hydrateFromCachedAnalysis` after §1.1)
**Audit ref:** §11.3 step 2

Replace the JSON.stringify clobber with an additive merge:

```tsx
function mergeSelectionHistory(serverList: SelectionAnalysisResult[]) {
  const live = useStore.getState().selectionHistory;
  const liveKeys = new Set(live.map(selectionKey));
  // Server is appended chronologically; reverse to newest-first.
  const serverNewestFirst = [...serverList].reverse();
  const additions = serverNewestFirst.filter(
    (s) => !liveKeys.has(selectionKey(s)),
  );
  if (additions.length === 0) return;
  useStore.setState({
    selectionHistory: [...live, ...additions].slice(0, 50),
  });
}
```

`selectionKey` lives in `SelectionResultPanel.tsx` — export it from
there or move to `frontend/src/lib/selectionActions.ts` (preferred —
see §1.4).

**Stop-and-ask** if exporting `selectionKey` would create an import
cycle.

### 1.4 Centralize selection action types

**File (new):** `frontend/src/lib/selectionActions.ts`
**Audit ref:** §4.4, §11

Create:

```ts
export type SelectionActionType =
  | "explain"
  | "derive"
  | "assumptions"
  | "followup";

export const ACTION_LABELS: Record<SelectionActionType, string> = {
  explain: "Explanation",
  derive: "Derivation",
  assumptions: "Assumptions",
  followup: "Follow-up",
};

export function selectionKey(r: { action?: string; selected_text?: string;
  question?: string; explanation?: string }): string {
  const head = (r.explanation || "").slice(0, 64);
  const id = r.question?.trim() || r.selected_text?.trim() || "";
  return `${r.action ?? "explain"}::${id}::${head}`;
}
```

Update consumers:

- `SelectionResultPanel.tsx` — import `ACTION_LABELS`, `selectionKey`,
  `SelectionActionType`. Drop the local copies.
- `BottomPanel.tsx:153` — use the type for the literal `"followup"`.
- `PdfViewer.tsx:478` — annotate `entry.action` as
  `SelectionActionType | undefined`.

Treat the legacy `"question"` string by mapping it to `"explain"` at
the boundary (the existing aliasing CSS rule covers it; no behavior
change).

**Verify:** `tsc` clean. Selection history shows correct labels for
existing entries (`question` → "Explanation", `followup` →
"Follow-up").

### 1.5 `useShallow` selectors on `PaperContent`

**File:** `frontend/src/app/paper/[id]/page.tsx:462–479`
**Audit ref:** §6.4

Replace the single `useStore()` destructure with split selectors:

```tsx
import { useShallow } from "zustand/react/shallow";

const { paper, setPaper, loading, setLoading } = useStore(
  useShallow((s) => ({
    paper: s.paper,
    setPaper: s.setPaper,
    loading: s.loading,
    setLoading: s.setLoading,
  })),
);
const { panelVisible, setPanelVisible, togglePanel } = useStore(
  useShallow((s) => ({
    panelVisible: s.panelVisible,
    setPanelVisible: s.setPanelVisible,
    togglePanel: s.togglePanel,
  })),
);
// ...split the rest into 3-4 logical groups...
```

Group rule of thumb: pull together fields that change *together*
(e.g. `selectionResult` + `setSelectionResult` +
`addSelectionToHistory`). Avoid grouping unrelated fields.

**Verify:** smoke-test paper switching, selection toolbar, focus
mode, header hide. Compare React DevTools' `Profiler` output before
and after — `PaperContent` should re-render dramatically less.

### 1.6 Wire `forgetPaper` into delete flows

**Files:**
- `frontend/src/app/dashboard/page.tsx` (paper delete handler)
- `frontend/src/app/library/page.tsx` (paper delete handler)
**Audit ref:** §2.4

`Grep` for `api.deletePaper(`. After every successful delete, call
`forgetPaper(paperId)` (import from `@/lib/analysisState`).

**Verify:** delete a paper that had a failed pre-reading attempt.
Re-upload the same PDF. Confirm pre-reading auto-triggers (i.e. the
sticky retry-block flag is gone).

### Phase 1 verification + commit

```bash
cd frontend && npx tsc --noEmit && npx eslint src --max-warnings 0
python -m py_compile backend/app/api/analysis.py backend/app/services/llm.py
```

Manual smoke tests required (in order):

1. Paper switch — preReading + assumptions both visible from cache.
2. Post a selection. Refresh. Selection persists; threaded.
3. Post a follow-up. Refresh. Follow-up persists under root with
   short label.
4. Delete a paper. Re-upload the same file. Auto-analysis fires.

Commit message:

```
fix(frontend, backend): phase 1 hydration + follow-up correctness

Per audit §11 + §2 — collapses four hydration effects into one,
fixes the disappearing follow-up bug by preserving selected_text
parity and merging server history additively, centralizes
selection-action types.

Changes:
- paper/[id]/page.tsx — single hydration effect (§2.1, §2.2, §11.3)
- selectionActions.ts (new) — ACTION_LABELS + selectionKey (§4.4)
- BottomPanel.tsx, SelectionResultPanel.tsx — use new helpers + question field (§11.3)
- api.ts (SelectionAnalysisResult) — add question?: string (§11.3)
- analysis.py, llm.py — accept + persist question separately (§11.3)
- PaperContent — useShallow split (§6.4)
- dashboard/page.tsx, library/page.tsx — forgetPaper on delete (§2.4)

Verified: tsc + eslint clean; manual smoke (paper switch, follow-up,
re-upload).
```

---

## PHASE 2 — Cache rationalization

> Reference: audit §3, §14 Phase 2. Single PR. Target: full day.

This phase is **destructive**: deletes the `paperCaches` slice and
migrates per-paper localStorage keys behind a single namespace.

**Stop-and-ask before starting.** Show the user the full list of
files and call sites you intend to touch. Get a thumbs-up.

### 2.1 Delete `paperCaches`

**File:** `frontend/src/lib/store.ts`
**Audit ref:** §3.3

Steps in order:

1. **`Grep`** for `paperCaches`, `savePaperCache`, `restorePaperCache`,
   `updatePaperCache`, `clearPaperCache`. List every call site.
2. **Stop-and-ask** with that list.
3. After approval:
   - Replace `restorePaperCache(id)` callers with **selectors over
     `papersById[id]`** (which already exist). The `cached_analysis`
     blob has everything; just read from `papersById[id].cached_analysis`.
   - `savePaperCache(id)` → no-op (state is already in `papersById`).
   - `updatePaperCache(id, partial)` → callers (just SummaryPanel)
     should write to a new `mutateCachedAnalysis(id, partial)` action
     that updates `papersById[id].cached_analysis` directly.
   - `clearPaperCache(id)` → callers (deletePaper, removeSessionPaper)
     should `delete papersById[id]` instead.
4. Drop the `PaperCache` type, `paperCaches: Record<string, PaperCache>`,
   and the four actions from the store interface.
5. Drop `paperCaches:` from the `clearSession` reset and `partialize`.

**Verify:** ALL of:
- App still loads.
- Paper switching is fast (instant — `papersById` is in-memory).
- Refresh on a paper page rehydrates from server within <1 s.
- No TypeScript errors.

### 2.2 Centralize loose localStorage keys

**Files:**
- `frontend/src/lib/store.ts` (new persisted UI prefs slice)
- `frontend/src/components/panel/BottomPanel.tsx` (panelPos / size /
  fontScale)
- `frontend/src/components/sidebar/QAPanel.tsx`
  (hide-suggestions, draft)
- `frontend/src/components/pdf/PdfViewer.tsx` (scroll position)

**Audit ref:** §3.3

Define a `uiPrefs` slice:

```ts
interface UiPrefs {
  panelPos: PanelPosition;
  panelSizeBottom: number;
  panelSizeSide: number;
  fontScale: number;
  hideQaSuggestions: boolean;
  scrollByPaper: Record<string, number>;
  qaDraftByPaper: Record<string, string>;
}
```

Replace every loose `localStorage.getItem("know-…")` /
`setItem("know-…", …)` with a Zustand selector. Persist via the
existing `partialize`. Add cleanup hooks to drop entries from
`scrollByPaper` and `qaDraftByPaper` whenever a paper id is
forgotten (call from `forgetPaper`).

**Stop-and-ask** if any loose key is read from a place that *isn't*
already inside React (e.g. a Cypress test, a service worker).

**Verify:** sign in, set a custom font scale, scroll a PDF, type a
draft Q. Refresh. Confirm all three survive. Delete the paper.
Confirm scroll & draft are GC'd from localStorage.

### 2.3 Request deduplication

**File:** `frontend/src/lib/api.ts:request<T>`
**Audit ref:** §8.3

Add per-key dedupe wrapping `request<T>`:

```ts
const _inflight = new Map<string, Promise<unknown>>();
function dedupedRequest<T>(method: string, path: string, init?: RequestInit): Promise<T> {
  // Only dedupe idempotent reads.
  if (method !== "GET") return request<T>(path, { ...init, method });
  const key = `${method} ${path}`;
  const existing = _inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = request<T>(path, { ...init, method }).finally(() => {
    _inflight.delete(key);
  });
  _inflight.set(key, p);
  return p;
}
```

Route every `GET`-style helper (`getPaper`, `listPapers`,
`getAssumptions`, `getMe`, `listWorkspaces`, …) through it. Mutations
keep going through `request<T>` directly.

**Verify:** rapid-click 5 session tabs in 1 second. DevTools network
shows ONE `getPaper` per id, not 5.

### Phase 2 verification + commit

```bash
cd frontend && npx tsc --noEmit && npx eslint src --max-warnings 0
```

Manual smoke tests:

1. Paper switch (×3 rapidly).
2. Refresh on a paper page — `papersById` warms within 1 s.
3. UI prefs (panel pos, font scale, scroll) survive refresh; GC on delete.

Commit message:

```
refactor(frontend): phase 2 cache rationalization + request dedupe

Per audit §3 + §14 Phase 2 — deletes paperCaches (data lived in
papersById already), unifies loose localStorage keys behind a single
uiPrefs slice, dedupes in-flight GET requests.

Changes:
- store.ts — drop paperCaches slice; new uiPrefs slice; mutateCachedAnalysis
- BottomPanel.tsx, QAPanel.tsx, PdfViewer.tsx — read uiPrefs from store
- api.ts — dedupedRequest for GETs
- analysisState.ts — forgetPaper now also clears uiPrefs by paperId

Verified: tsc + eslint clean; manual smoke (rapid switch, refresh, delete).
```

---

## PHASE 3 — Backend perf

> Reference: audit §14 Phase 3. Single PR (or two: one Python, one
> SQL migration). Target: half a day.

### 3.1 Atomic JSONB-append RPCs

**Files:**
- `backend/supabase/migrations/011_jsonb_append_rpcs.sql` (new)
- `backend/app/services/db.py`
- `backend/app/api/analysis.py` (selection_analysis,
  selection_analysis_stream, qa)
- `backend/app/services/pdf_parser.py` (`mutate_paper`)

**Audit ref:** §7.1

(a) Write the migration. It must be idempotent (`CREATE OR REPLACE
FUNCTION`). Functions to add: `append_selection`, `append_qa_session`.
Use the SQL template from audit §7.1.

(b) Add to `db.py`:

```python
def append_selection(paper_id: str, user_id: str, entry: dict) -> bool:
    client = get_db()
    if not client:
        return False
    res = client.rpc("append_selection", {
        "p_paper_id": paper_id,
        "p_user_id": user_id,
        "p_entry": entry,
    }).execute()
    return bool(res and res.data is not None)
```

Same for `append_qa_session`.

(c) Update `selection_analysis` and `selection_analysis_stream` in
`analysis.py` to call `append_selection` instead of `mutate_paper`.
Update `qa` similarly.

(d) Keep `mutate_paper` for non-append mutations (deletion of a
selection, settings, etc.).

**Stop-and-ask** if you can't apply the migration locally to verify.
The agent must NOT push this commit until the migration is verified.

**Verify (local):**
- `supabase migration apply` (or paste SQL into Supabase SQL editor).
- Post a selection. Verify `cached_analysis.selections` grew by one.
- Post a Q&A. Verify `cached_analysis.qa_sessions` grew.
- Compare backend log timing — selection writes should drop from
  150–400 ms to 20–60 ms.

### 3.2 Async PDF parsing on upload

**File:** `backend/app/api/papers.py:95`
**Audit ref:** §7.3

Replace the inline `extract_pdf` with `run_in_executor`:

```python
import asyncio
loop = asyncio.get_running_loop()
raw = await loop.run_in_executor(None, extract_pdf, pdf_path, paper_id)
```

That's the entire change. **Don't** background-task it (the audit
notes that the simpler executor change is sufficient at current scale).

**Verify:** start a 30 MB PDF upload + a separate API call (e.g. ping
`/api/health`). Confirm `/api/health` returns immediately even
during the upload — previously it would wait.

### 3.3 Process-local LRU on `get_paper`

**File:** `backend/app/services/pdf_parser.py:get_paper`
**Audit ref:** §7.2

Wrap with a TTL-aware cache. Use `cachetools.TTLCache` if available;
otherwise hand-roll:

```python
from cachetools import TTLCache
_paper_cache: TTLCache = TTLCache(maxsize=256, ttl=60)
_paper_cache_lock = threading.Lock()

def get_paper(paper_id: str, *, user_id: str | None = None) -> ParsedPaper | None:
    key = (paper_id, user_id or "")
    with _paper_cache_lock:
        cached = _paper_cache.get(key)
    if cached is not None:
        return cached
    paper = _get_paper_uncached(paper_id, user_id=user_id)
    if paper is not None:
        with _paper_cache_lock:
            _paper_cache[key] = paper
    return paper

def invalidate_paper_cache(paper_id: str, user_id: str | None = None) -> None:
    with _paper_cache_lock:
        for key in list(_paper_cache.keys()):
            if key[0] == paper_id and (user_id is None or key[1] == user_id):
                del _paper_cache[key]
```

`save_paper`, `delete_paper_meta`, and `mutate_paper` must call
`invalidate_paper_cache(paper_id)`.

`cachetools` is not in `requirements.txt`. **Stop-and-ask**: do you
prefer (a) add `cachetools>=5.3,<7.0` to requirements, (b) hand-roll
a tiny TTL Map?

**Verify:** click 3 tabs quickly on a paper. Backend logs show ONE
`get_paper` Supabase round-trip, not 3.

### 3.4 Signed-URL redirects for PDFs / figures

**Files:**
- `backend/app/api/papers.py` (`/{paper_id}/pdf`, `/{paper_id}/figures/{fig_id}`)
- `backend/app/services/storage.py` (add `create_signed_url`)
**Audit ref:** §8.4

(a) `storage.py`:

```python
def create_signed_url(user_id: str, path: str, expires_in: int = 600) -> str | None:
    bucket = _get_bucket()
    if not bucket:
        return None
    full_path = f"{user_id}/{path}"
    try:
        res = bucket.create_signed_url(full_path, expires_in)
        return res.get("signedURL") if isinstance(res, dict) else None
    except Exception as e:
        logger.error("Storage create_signed_url failed for %s: %s", full_path, e)
        return None
```

(b) PDF route — fall back to local serve if storage isn't configured
or signing fails (we don't want to break self-host):

```python
@router.get("/{paper_id}/pdf")
async def get_paper_pdf(paper_id: str, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    signed = cloud_storage.create_signed_url(user_id, f"{paper_id}.pdf", 600)
    if signed:
        return RedirectResponse(signed, status_code=302)
    # Fallback path: existing local-disk serve.
    pdf_path = settings.papers_dir / f"{paper_id}.pdf"
    if pdf_path.exists():
        return FileResponse(...)
    pdf_bytes = cloud_storage.download_file(user_id, f"{paper_id}.pdf")
    if pdf_bytes:
        ...
    raise HTTPException(status_code=404, detail="PDF not found")
```

Same shape for figures.

**Stop-and-ask** if the Supabase Storage bucket signing is disabled
in config.

**Verify:** open a paper. Network tab shows `302 → supabase.co/...`
for the PDF; the actual bytes come from Supabase, not the backend.

### Phase 3 verification + commit

```bash
python -m py_compile backend/app/api/papers.py backend/app/api/analysis.py \
  backend/app/services/db.py backend/app/services/pdf_parser.py \
  backend/app/services/storage.py
# If you added cachetools to requirements.txt:
pip install -r backend/requirements.txt
```

Commit message:

```
perf(backend): phase 3 jsonb appends + async parse + lru + signed urls

Per audit §14 Phase 3 — backend writes 5–10× faster, uploads stop
blocking workers, repeated reads hit LRU, PDFs/figures bypass the
backend roundtrip.

Changes:
- migrations/011 — append_selection, append_qa_session RPCs (§7.1)
- db.py — append_selection, append_qa_session client wrappers
- analysis.py — selection / qa endpoints use atomic appends
- papers.py — extract_pdf via run_in_executor (§7.3)
- pdf_parser.py — TTL LRU around get_paper (§7.2)
- storage.py + papers.py — signed Supabase URL redirects (§8.4)

Verified: migration applies; selection write ~30ms (was ~250ms);
upload no longer blocks /api/health.
```

---

## PHASE 4 — Analysis pane redesign

> Reference: audit §12, §14 Phase 4. 1–2 days. **Single PR per item**
> if the diff is large; otherwise group cosmetically related items.

### 4.1 Type scale + spacing rhythm

**Files:**
- `frontend/src/app/globals.css` (token definitions)
- Search-and-replace across `frontend/src/components/sidebar/*.tsx`,
  `frontend/src/components/panel/*.tsx`

**Audit ref:** §12.1, §12.2

Add to `globals.css`:

```css
:root {
  --text-xs: 11px;
  --text-sm: 12.5px;
  --text-md: 14px;
  --text-lg: 16px;
}
```

Find every literal `text-[10.5px]`, `text-[11.5px]`, `text-[12.5px]`
inside the analysis-pane components. Map them onto the four tokens
(round to closest):

- 10–11.5 → `var(--text-xs)`
- 12–12.5 → `var(--text-sm)`
- 13–14 → `var(--text-md)`
- 15+ → `var(--text-lg)`

**Stop-and-ask** before mass-replacing: show 5 sample diffs and get
approval.

For spacing: replace `space-y-1.5`, `space-y-2.5`, `space-y-3` with
`space-y-2`, `space-y-2`, `space-y-3` (collapse to 4-step scale).

**Verify:** visual regression — open every panel and confirm nothing
"looks wrong". Type and spacing should feel more consistent.

### 4.2 Color tokens + drop the gradient

**Files:**
- `frontend/src/app/globals.css`
- All files using `from-violet-500 to-purple-600`
- `frontend/src/components/panel/BottomPanel.tsx` (active tab styling)

**Audit ref:** §12.3, §13.1

Add token CSS vars (`--surface-0` through `--accent`). The accent
should be a single hex; pick one and use it ONLY for:

- Active analysis-pane tab indicator.
- Primary CTA in `<EmptyState>` and the upgrade flow.

Replace every `from-violet-500 to-purple-600` with a neutral
`bg-foreground text-background hover:opacity-90` button.

`Grep` for `gradient-to-r` → expect ~6 hits across landing,
dashboard, settings, library, and modal CTAs. Replace all.

**Verify:** no gradient remains in the app. Run a screenshot diff if
you have one set up; otherwise eyeball every page.

### 4.3 Tabs underline relayout

**File:** `frontend/src/components/panel/BottomPanel.tsx:33–215`
**Audit ref:** §12.4

Move the active-tab underline from inside the tab to the bottom edge
of `<TabsList>`. Implementation: render a single absolutely-positioned
`<div>` inside the list container; track active tab's bounding box on
click + on resize via a `ref`-keyed map and a single `useLayoutEffect`.

Keep the existing tab keyboard-nav and accessibility behavior intact.

**Verify:** keyboard nav still works (arrow keys); active-tab
underline animates smoothly between tabs.

### 4.4 Unified `<EmptyState>` and `<AnalysisProgress>`

**Files (new):**
- `frontend/src/components/ui/EmptyState.tsx`
- `frontend/src/components/ui/AnalysisProgress.tsx`

**Audit ref:** §12.5, §5.1

`<EmptyState>` props: `icon`, `title`, `body`, `cta?: { label,
onClick, loading? }`.

`<AnalysisProgress>` props: `kind: "preReading" | "assumptions" |
"summary" | "selection" | "qa"`. Pull half-life from a single
`KIND_HALF_LIFE` map. Use `getProgressStart` / `clearProgressStart`
from `analysisState.ts`.

Then refactor:

- `PreReadingPanel.tsx`, `AssumptionsPanel.tsx`, `SummaryPanel.tsx`,
  `QAPanel.tsx`, `SelectionResultPanel.tsx` — replace local progress
  bars with `<AnalysisProgress kind="…" />`.
- All five panels' "no data yet" branches → `<EmptyState … />`.

**Verify:** every progress bar uses the same width/height; every
empty state has consistent padding.

### 4.5 Q&A panel restructure

**File:** `frontend/src/components/sidebar/QAPanel.tsx`
**Audit ref:** §12.7

- Move Cross-Paper toggle into a kebab/overflow menu in the panel
  header (mirror `BottomPanel.tsx`'s portal-menu pattern).
- Drop the dashed border on "More like these"; use the same solid
  `glass-subtle` style as the seed prompts with a `+` icon.
- Auto-scroll the Answers section to the latest item after
  `handleAnswerAll`.

### 4.6 Selection card visual hierarchy

**File:** `frontend/src/components/panel/SelectionResultPanel.tsx`
**Audit ref:** §12.6

- Demote the italic quote pill (`text-muted-foreground/40`, no
  glass).
- Promote the analysis body — sit the action badge inline with the
  first line.
- `DerivationView`: add a `⌐` marker for "starting point", a thin
  ring (no fill) for "final result".

### Phase 4 verification + commit

```bash
cd frontend && npx tsc --noEmit && npx eslint src --max-warnings 0
```

Visual smoke test: open every analysis pane tab on a paper that has
data in each. Confirm no unintended visual regression.

Commit message (multi-line, one per item if you split):

```
feat(ui): phase 4 analysis pane redesign

Per audit §12. Type scale + spacing tokens unified, violet gradient
removed from primary CTAs, tabs underline relayout, EmptyState +
AnalysisProgress unified components, Q&A panel restructure,
selection card hierarchy refresh.

Verified: tsc + eslint clean; visual smoke pass.
```

---

## PHASE 5 — Platform polish

> Reference: audit §13, §14 Phase 5. Multiple small PRs.

Pick from this list. Each is independent and can ship on its own
schedule.

### 5.1 Logo + typography

`frontend/src/app/layout.tsx`, `frontend/src/components/Brand.tsx`
(new).

Replace the `<Image src="/logo.png">` with an inline SVG component.
Audit fonts: ensure `font-display`, body, mono are all set
consistently from a single Tailwind config.

### 5.2 Motion calibration

`Grep` for `transition-all`. Replace with the most specific
alternative (`transition-colors`, `transition-opacity`,
`transition-transform`).

Audit `animate-fade-in` durations in `globals.css` — drop to
~120 ms.

### 5.3 Keyboard shortcuts

**File (new):** `frontend/src/components/KeyboardShortcuts.tsx`

A single mount inside `frontend/src/app/paper/[id]/page.tsx` that
listens at `document` level for the bindings in audit §13.7. Use a
small array config (don't hard-code each).

Show a `<KeyboardShortcuts.Hints />` floating affordance in the
help/settings popover. Bind `?` to open it.

### 5.4 Onboarding tour

**File (new):** `frontend/src/components/OnboardingTour.tsx`

Trigger on the user's *second* paper page mount (track via
`localStorage.know-paper-mounts`). 4 steps:

1. The analysis pane tabs.
2. The selection toolbar (highlight any 4 words to show).
3. The session tab bar.
4. Focus mode.

Use `localStorage.know-tour-dismissed` to suppress after dismiss.

### 5.5 Settings 2-column

**File:** `frontend/src/app/settings/page.tsx`

At `≥ md`, render a two-column layout: nav left, content right. Move
existing sections (Account, Billing, Models, Appearance, Keyboard,
About) into separate route segments under `/settings/[section]` (or
a single page with `?section=` query param — your call).

### 5.6 Marketing site cleanup

**File:** `frontend/src/app/page.tsx`

- Remove the "trusted by" empty section if any.
- Replace gradient hero with monochrome.
- Collapse pricing into one fold above the screen height.

---

## VERIFICATION APPENDIX

### Frontend — every commit

```bash
cd frontend
npx tsc --noEmit
npx eslint src --max-warnings 0
npm run build         # only if you changed bundling-relevant code (next.config, package.json)
```

Pre-existing eslint warnings in unrelated files: do **not** "fix" them
in your PRs. They're tracked separately. Run with
`--max-warnings 0` only against files you touched, e.g.:

```bash
npx eslint src/components/ui/Md.tsx --max-warnings 0
```

### Backend — every commit

```bash
python -m py_compile $(find backend -name '*.py' | head -20)
# Spot-check: run the dev server, hit /api/health.
```

### After every phase — manual smoke

Minimum smoke test, in order:

1. **Sign in.**
2. **Upload a paper** (PDF ≥10 MB) — confirm reader opens.
3. **Run a Selection (Explain).** Confirm result + history entry.
4. **Run a Selection follow-up.** Confirm threading + label.
5. **Switch to a 2nd paper** in session, then back. Confirm state.
6. **Refresh the page.** Confirm `selectionHistory` rehydrates with
   correct labels and threading.
7. **Open Q&A → suggest more questions.** Confirm new pills.
8. **Cancel + resume subscription** (test mode).
9. **Sign out + back in.** Confirm clean state.

---

## STOP-AND-ASK CONDITIONS (cumulative)

Stop and surface to the user before doing any of these:

1. The audit cites a line range that no longer matches the file.
2. A fix conflicts with a more recent commit on `main`.
3. A change would touch `.env*` or any pre-existing migration file.
4. A change would drop or rename a public API endpoint or schema field.
5. A change would change a Stripe price, product, or webhook config.
6. You'd need to add a runtime dependency not listed in
   `frontend/package.json` or `backend/requirements.txt`.
7. You can't apply a SQL migration locally to verify.
8. The `npx tsc --noEmit` shows pre-existing errors (not introduced by
   your edits).
9. ANY destructive shell command would help (`rm`, `git reset --hard`,
   etc.).
10. You're about to delete more than 100 lines in a single edit.

When stopping, use the literal phrase **"Stop-and-ask:"** at the
start of your message. This is the user's signal that you're paused.


---

## PROMPT END

> The agent should not read past this line on the first pass.

---

### Notes for the human reviewing this prompt

- **Customize** the smoke test list under "VERIFICATION APPENDIX" if
  you have specific bugs you want re-verified after each phase
  (e.g. "the highlight underline still appears after a refresh").
- **Set a budget**: tell the agent up front "you have 4 hours of
  wall-clock for Phase 0–1; if you hit a wall, stop." Models tend to
  drift on multi-hour tasks; explicit budgets help.
- **Don't let the agent skip Phase 2's stop-and-ask.** Cache
  consolidation is the riskiest change in this plan; review the call
  sites before approving.
- **Pin the model** at the top of the prompt if you have a
  preference: e.g. "Use Claude Opus for Phase 1's debugging-heavy
  work; Codex / Sonnet is fine for the cosmetic phases."
- **Don't ship Phase 5 in the same week as Phase 0–3**. Polish
  changes invite visual regressions; ship them on a quieter week
  when you can revert easily.

— Prompt produced from `docs/ANALYSIS_PANE_AUDIT.md` 2026-04-25.
Re-generate from the audit any time the audit changes.
