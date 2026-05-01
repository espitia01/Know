# Implementation Prompt — Speed, Figures, Upload Lag, and Hydration Fixes

A focused, agent-ready contract for fixing four user-reported bugs:

1. The application loads slowly.
2. Figures disappear after extraction; the user has to re-extract on every paper open.
3. There is a significant lag between uploading a paper and the reader opening it (especially for "add to workspace" flows).
4. Hydration is still inconsistent: adding multiple papers to a workspace re-fetches data the analysis pane already had populated, and assumptions sometimes silently fail across papers.

This prompt is meant to be pasted into a coding agent. It is grounded in the **actual repo at `2c3f085`** and assumes phases 0–5 of `docs/IMPLEMENTATION_PROMPT.md` are already merged.

---

## Reading order for the agent

1. This file (`docs/SPEED_AND_HYDRATION_FIX_PROMPT.md`) — the contract.
2. `docs/ANALYSIS_PANE_AUDIT.md` — background context and prior recommendations.
3. The cited files only (do not free-roam the repo).

---

## PROMPT START

> Everything between `## PROMPT START` and `## PROMPT END` is what you copy
> into the agent's first message.

---

You are implementing four targeted fixes for the **Know** repo
(Next.js 15 + React 19 frontend in `frontend/`; FastAPI + Python 3.13
backend in `backend/`; Supabase Postgres + Storage; Clerk auth; Stripe
billing; Railway deploy).

Phases 0–5 of the previous implementation prompt
(`docs/IMPLEMENTATION_PROMPT.md`) are already merged on `main`. **Do
not redo those.** Your job is to ship the targeted bug fixes below
without regressing the live product.

### Mission

Ship four bug fixes, each in its **own commit**, in this order:

1. **F-FIGURES** — figures must persist across backend restarts so the
   user never re-extracts after the first successful extraction.
2. **F-HYDRATION** — adding more papers to a workspace must not refire
   already-completed analyses; assumptions must be reliable across
   papers.
3. **F-UPLOAD-LAG** — opening a paper after upload (especially via
   "Add Paper" inside a workspace) must feel snappy.
4. **F-SPEED** — the cold app load and recurring per-page latencies
   must drop materially.

### Definition of "done" for each fix

- The cited file(s) and line ranges are changed in line with the
  recommended fix below.
- Comments reference the **bug code** (`F-FIGURES`, `F-HYDRATION`,
  `F-UPLOAD-LAG`, `F-SPEED`) and explain the *why*, not the *what*.
- `tsc --noEmit`, `eslint --max-warnings 0` on touched files, and
  `python -m py_compile` on touched Python files are all clean.
- A short manual smoke test (listed per fix) passes.
- The fix is committed with the standard commit format below and
  pushed to `origin/main`.

### Workflow rules (read every time)

1. **Read first, write second.** Always open the cited line ranges
   with `Read`. If the shape has drifted, **stop-and-ask** — do not
   improvise.
2. **One fix per commit.** Don't bundle.
3. **Smallest possible diff.** No reformatting outside the changed
   lines.
4. **Comment the *why*** with `// Per F-…:` or `# Per F-…:`.
5. **Never break the public API surface** unless this prompt
   explicitly says to.
6. **Never run destructive shell commands** (`rm -rf`, `git reset
   --hard`, `git push --force`, DB-truncate, etc.).
7. **No new dependencies** unless this prompt says so. If the fix
   needs a dependency, **stop-and-ask first**.
8. **Stop-and-ask** any time:
   - A line range no longer matches.
   - A schema change is needed.
   - A new SQL migration is needed (verify locally before pushing).
   - You'd need to delete >100 lines in a single edit.

### Commit format

```
<type>(<scope>): <imperative summary> [<bug-code>]

Per docs/SPEED_AND_HYDRATION_FIX_PROMPT.md <bug-code> — <one-line rationale>.

Changes:
- <file:line> — <one-line description>
- ...

Verified:
- tsc --noEmit (clean)
- eslint --max-warnings 0 (clean on touched files)
- python -m py_compile <files> (clean on touched files)
- manual: <what you smoke-tested>
```

Examples of `<type>(<scope>)`:

- `fix(backend): persist figures across restarts [F-FIGURES]`
- `fix(frontend, backend): stabilize multi-paper hydration [F-HYDRATION]`
- `perf(frontend): optimistic post-upload navigation [F-UPLOAD-LAG]`
- `perf(frontend, backend): tighten cold-load and switch latency [F-SPEED]`

### Stop-and-ask format

Reply with the literal sentence:

> **Stop-and-ask:** I need confirmation before continuing. <reason>.

Then list:

1. The bug code you're working on.
2. The exact text or behavior you observed.
3. Two or three options with trade-offs.

Do not proceed until the user replies.

---

## CONTEXT — Current state of `main` you must preserve

Phases 0–5 already shipped:

- Phase 0 — quick wins (`5c5fcea`)
- Phase 1 — hydration / follow-up correctness (`1fbf25f`)
- Phase 2 — cache rationalization + GET dedupe (`e905d69`)
- Phase 3 — JSONB append RPCs + LRU + signed Storage URLs (`dbf3a16`)
- Phase 4 — analysis pane redesign foundations (`43753ae`)
- Phase 5 — keyboard shortcuts + reader motion polish (`2c3f085`)

Important contracts you must not break:

- `paperCaches` is gone. `papersById[paperId]` is the single
  in-memory paper cache; `papersById[paperId].cached_analysis` is the
  source of analysis state on the client.
- Selection / Q&A persistence flows through the JSONB append RPCs
  with a local mirror via `append_cached_analysis_local`.
- `request<T>` does single-retry on 401; idempotent GETs are deduped
  via `getRequest`.
- `<Md>` is memoized; the analysis pane uses the
  `--text-xs/sm/md/lg` token scale; tabs lazy-mount on first visit.
- `KeyboardShortcuts` is mounted in the reader.

You may need to invalidate or extend these. **Stop-and-ask** before
removing them.

---

## F-FIGURES — Figures disappear after backend restart

### Symptom

The user uploads a paper, figures are extracted and shown, then
they (eventually) reopen the paper and figures are gone. The user
has to click "Re-extract figures" every time.

### Root cause

Confirmed by reading the repo:

- `backend/app/services/db.py` — `save_paper_meta(...)` (lines
  ~148–172) writes a row that **does not include `figures`**:

```python
row = {
    "id": ..., "user_id": ..., "title": ..., "authors": ...,
    "folder": ..., "tags": ..., "notes": ...,
    "cached_analysis": ..., "raw_text": ...,
}
client.table("papers").upsert(row, on_conflict="id").execute()
```

- `backend/app/services/pdf_parser.py` — `_load_paper_locked(...)`
  (lines ~581–615) rebuilds a `ParsedPaper` from the Supabase row
  with `figures=[]` whenever the disk `paper.json` is missing:

```python
paper = ParsedPaper(
    id=row["id"], ...,
    figures=[],   # <— this is why figures vanish
    ...,
)
```

- Railway containers are ephemeral; the disk `papers_dir/{id}/paper.json`
  does not survive redeploys, scaling events, or worker churn.
- The figure PNGs themselves DO survive (they are uploaded to Supabase
  Storage at `{user_id}/{paper_id}/figures/*.png` from
  `backend/app/api/papers.py` `upload_paper`), but the `FigureInfo`
  metadata (id, caption, page) is lost.

### Required fix

Persist figure metadata to Supabase so figures rehydrate alongside
the paper. Pick **one** of:

**Option A (recommended):** add a top-level JSONB column
`papers.figures` (a list of `FigureInfo` dicts).

1. New migration: `backend/supabase/migrations/012_papers_figures_column.sql`

   ```sql
   ALTER TABLE papers
       ADD COLUMN IF NOT EXISTS figures JSONB NOT NULL DEFAULT '[]'::jsonb;
   ```

   Idempotent. Safe to re-run.

2. **Stop-and-ask** to confirm the user has applied the migration in
   Supabase before pushing the code change.

3. `backend/app/services/db.py` `save_paper_meta(...)`: add
   `"figures": paper_dict.get("figures", [])` to `row`. Keep the
   raw_text-strip retry path; figures should remain in the retry row
   too.

4. `backend/app/services/pdf_parser.py` `_load_paper_locked(...)`:
   when rebuilding from a Supabase row, populate `figures` from the
   row (default `[]`).

   ```python
   figures_raw = row.get("figures") or []
   figures = [FigureInfo(**f) for f in figures_raw if isinstance(f, dict)]
   paper = ParsedPaper(..., figures=figures, ...)
   ```

5. When `paper.json` exists but the disk lost figures (e.g. the user
   started a session before this fix shipped), backfill: if
   `paper.figures` is empty AND the Supabase row has figures, copy
   them in and rewrite `paper.json`. Guard with `if user_id and
   not paper.figures` analogous to the existing `cached_analysis`
   backfill.

**Option B:** keep the schema as-is and store figures inside
`cached_analysis['figures']`. Less ideal because it conflates
extraction outputs with analysis outputs. **Stop-and-ask** before
choosing this; it is the second-best option.

### Verification

1. Apply the migration.
2. Upload a paper, confirm figures show up.
3. Restart the backend (or, locally, delete `backend/papers/{id}/paper.json`).
4. Open the paper. Figures should render without re-extraction.

### Commit

```
fix(backend): persist figures across restarts [F-FIGURES]

Per docs/SPEED_AND_HYDRATION_FIX_PROMPT.md F-FIGURES — store FigureInfo
metadata in Supabase so figures rehydrate on container restarts.

Changes:
- migrations/012_papers_figures_column.sql — add jsonb figures column
- db.py:save_paper_meta — persist figures in the upsert row
- pdf_parser.py:_load_paper_locked — rebuild figures from Supabase

Verified:
- migration applied; redeploy/disk-purge no longer wipes figures
- python -m py_compile (clean)
- manual: open paper → restart backend → reopen → figures still rendered
```

---

## F-HYDRATION — Multi-paper workspace re-fires already-done analyses

### Symptoms reported

- Adding multiple papers to a workspace seems to re-fetch / re-run
  analyses that were already populated.
- Assumptions sometimes silently fails on a paper, then gets stuck.
- The user feels the analysis pane "starts over" in inconsistent ways
  on switch.

### Root causes

Read these files and lines first to confirm before fixing:

- `frontend/src/app/paper/[id]/page.tsx` — paper-fetch effect
  (around L688–L705) and the auto-analysis effect (around L767–L825).
- `frontend/src/lib/analysisState.ts` — `autoAnalyzedPapers` set,
  `allowAutoAnalyzeRetry`, `forgetPaper`.
- `backend/app/api/analysis.py` — assumptions endpoint and its 502
  branch on empty results.
- `frontend/src/components/sidebar/AssumptionsPanel.tsx` — error UI.

Concrete drivers of the bugs:

1. **Background refetch always overwrites with stale analysis on
   slow connections.** The fetch effect calls `setPaper(p)` after
   `getPaper` resolves regardless of whether the cached copy in
   `papersById` was already richer. If the server was rebuilt from
   Supabase between visits and `cached_analysis` is older than what
   the in-memory cache had, the rich state is replaced.

2. **`hydratedForRef.current = loadedPaperId` only short-circuits
   in-process.** When the user switches between papers in a session,
   each new `loadedPaperId` re-runs hydration. That part is correct.
   But when the auto-analysis effect re-evaluates, it inspects
   `cache.pre_reading` / `cache.assumptions.assumptions` from the
   freshly-set paper, which may be empty if `getPaper` returned a
   slimmer Supabase rebuild. That triggers `api.analyze` /
   `api.getAssumptions` again.

3. **Empty assumptions are not cached.** The backend explicitly
   refuses to cache `{"assumptions": []}` (`backend/app/api/analysis.py`
   `assumptions` endpoint). Combined with `autoAnalyzedPapers.add(...)`
   firing in the frontend before the call resolves, every paper switch
   that lands on a paper whose first attempt produced empty
   assumptions will retry, fail, and surface "extraction didn't
   return any results."

### Required fix

Three changes that compose. Implement in this order:

#### 1) Make `setPaper` analysis-state-preserving on refetch

`frontend/src/app/paper/[id]/page.tsx` — paper data fetch effect
(around L685–L705):

```tsx
api
  .getPaper(activePaperId)
  .then((p) => {
    if (stale) return;
    // Per F-HYDRATION: never let a slimmer server payload
    // overwrite an in-memory cached_analysis that already has
    // pre_reading / assumptions / summary populated. The Supabase
    // rebuild path returns whatever was last upserted; if a worker
    // restart loses transient state we don't want the UI to flip
    // back to "Analyze Paper" empty states on the next refetch.
    const prev = useStore.getState().papersById[activePaperId];
    const merged: ParsedPaper = prev
      ? {
          ...p,
          cached_analysis: {
            ...(p.cached_analysis || {}),
            ...(prev.cached_analysis || {}),
            ...(p.cached_analysis || {}),
          },
          figures: p.figures?.length ? p.figures : prev.figures,
          notes: (p.notes && p.notes.length) ? p.notes : prev.notes,
        }
      : p;
    setPaper(merged);
    cachePaper(merged);
    initialLoadDone.current = true;
  })
```

The double-spread is intentional: server fields win for keys it owns,
prev fields fill in keys the server omitted. If you'd rather, do a
shallow `Object.keys(prev.cached_analysis).forEach(...)` merge.

#### 2) Don't auto-trigger analyses while a session paper still has them on the previous load

`frontend/src/app/paper/[id]/page.tsx` — auto-analysis effect (around
L767–L825):

- Read the **session-level cache** (`papersById[pid].cached_analysis`),
  not just `loadedPaperCache`. If `papersById[pid]` has
  `pre_reading`/`assumptions` from earlier in the session, do not
  fire even if the freshly-fetched `paper.cached_analysis` is empty.

```tsx
const sessionCache =
  useStore.getState().papersById[pid]?.cached_analysis || {};
const hasPreReading = !!(cache.pre_reading || sessionCache.pre_reading);
const hasUsableAssumptions =
  Array.isArray(cache.assumptions?.assumptions)
    ? cache.assumptions!.assumptions.length > 0
    : Array.isArray(sessionCache.assumptions?.assumptions)
      ? sessionCache.assumptions!.assumptions.length > 0
      : false;
```

Then gate `api.analyze` on `!hasPreReading` and `api.getAssumptions`
on `!hasUsableAssumptions`.

#### 3) Backend caches "no usable assumptions" with a short cooldown

`backend/app/api/analysis.py` — assumptions endpoint:

- Today the endpoint releases the usage token and raises 502 when the
  LLM returns no items. That guarantees the next visit re-fires.
- Change: still raise 502, but mark the paper with a small marker in
  `cached_analysis['assumptions_cooldown_until']` (UNIX ts, +30
  minutes) on empty results.
- The frontend auto-analysis effect must skip when
  `cache.assumptions_cooldown_until && Date.now()/1000 <
  cache.assumptions_cooldown_until`. Surface a calmer message in the
  panel ("The model didn't find usable assumptions. Try again in a
  few minutes."). Don't keep retrying every paper switch.

This stops the storm of repeated 502s users see across multi-paper
sessions.

#### 4) Persist analyses in a `try/finally` so worker crashes don't lose work

This is the belt-and-suspenders piece that turns "very likely
consistent" into "consistent." Today the per-route shape is:

```python
result = await analyze_paper(paper.raw_text, user_id=user_id)
def _apply(p):
    p.cached_analysis["pre_reading"] = ...
mutate_paper(paper_id, user_id, _apply)
return resp
```

If the worker dies, the connection drops, or any post-LLM
serialization raises **after** `analyze_paper` returns but **before**
`mutate_paper` runs, the user paid for tokens and gets nothing on the
next visit. That is the residual inconsistency the audit could not
eliminate through frontend hydration alone.

Required pattern for **every** non-streaming analysis endpoint
(`analyze`, `assumptions`, `summary`, `qa`, `derivation/exercise`,
`skipped-steps`, `explain`):

```python
@router.post("/{paper_id}/analyze", response_model=PreReadingAnalysis)
async def analyze(paper_id: str, user_id: str = Depends(require_auth)):
    ...
    token = reserve_usage(user_id, paper_id, "api_call", model=...)
    raw_result: dict | None = None
    try:
        raw_result = await analyze_paper(paper.raw_text, user_id=user_id)
        analysis = PreReadingAnalysis(...)
        return analysis
    except ValueError as exc:
        release_usage(token); raise HTTPException(503, ...)
    except HTTPException:
        release_usage(token); raise
    except Exception:
        release_usage(token); logger.exception(...); raise HTTPException(500, ...)
    finally:
        # Per F-HYDRATION step 4: persist anything we already paid for so a
        # post-LLM crash does not force the next visitor to re-extract.
        if raw_result is not None:
            try:
                mutate_paper(
                    paper_id, user_id,
                    lambda p: p.cached_analysis.__setitem__("pre_reading", raw_result),
                )
            except Exception:
                logger.exception("Failed to persist pre_reading in finally")
```

Apply the same shape to every non-streaming analysis endpoint. The
key invariants:

- The variable holding the LLM payload is initialized to `None`
  **before** the `try`.
- The persistence happens in `finally` and is itself wrapped in its
  own `try/except` so a DB hiccup never masks the original return /
  exception.
- `release_usage` stays in the same exception arms as today; the
  finally only writes when the LLM produced output.

For **streaming** endpoints (`selection_analysis_stream`,
`summary_stream`): persistence already happens on the terminal `done`
event. Add a periodic mid-stream flush every 5–10 seconds to the
local-only path, so an aborted SSE still leaves the user with
whatever was generated:

```python
import time as _time
last_flush = _time.monotonic()
PARTIAL_FLUSH_SECONDS = 7
async for chunk in provider.stream_complete(...):
    if await request.is_disconnected():
        disconnected = True
        break
    full_text += chunk
    yield ...
    if _time.monotonic() - last_flush > PARTIAL_FLUSH_SECONDS:
        try:
            append_cached_analysis_local(
                paper_id, user_id, "selections",
                {
                    "action": action,
                    "selected_text": selected_text,
                    "explanation": _normalize_latex_delimiters(full_text),
                    "partial": True,
                },
            )
        except Exception:
            logger.exception("Selection partial flush failed for %s", paper_id)
        last_flush = _time.monotonic()
```

When the stream finishes successfully, the existing terminal
persistence will overwrite the `partial: True` entry via the dedupe
already in `append_capped` — but if you find duplicates in the wild,
filter the `selections` array by `(action, selected_text)` and drop
earlier `partial: True` siblings before the final append.

### Verification

1. Open paper A → wait for assumptions / pre-reading.
2. Add paper B to session.
3. Switch back to paper A. **No** new `api.getAssumptions` /
   `api.analyze` should fire (network tab).
4. Open a paper whose first assumptions extraction produced empty
   results. Confirm the assumptions panel shows the calmer cooldown
   message and the request is **not** auto-fired again on switch /
   refresh.

### Commit

```
fix(frontend, backend): stabilize multi-paper hydration [F-HYDRATION]

Per docs/SPEED_AND_HYDRATION_FIX_PROMPT.md F-HYDRATION — preserve in-memory
cached_analysis across background refetches, gate auto-analysis on the
session-level cache, and add a backend cooldown for empty assumptions.

Changes:
- paper/[id]/page.tsx — merge prev cached_analysis on refetch; gate auto-analysis on session cache
- analysis.py — write assumptions_cooldown_until on empty extraction
- AssumptionsPanel.tsx — show cooldown messaging, don't refire

Verified:
- tsc + eslint touched files (clean)
- manual: switch back to a populated paper without refire
- manual: empty assumptions does not refire across switches
```

---

## F-UPLOAD-LAG — Add Paper to workspace feels slow

### Symptom

Inside a workspace, the user clicks "Add Paper" → file picker → upload
finishes → there is a noticeable lag before the new paper opens in
the reader.

### Root causes

Confirmed in repo:

- `backend/app/api/papers.py` — `upload_paper` does, in this order:
  1. Reserve usage slot.
  2. Read file bytes (in-process).
  3. `extract_pdf` (now in executor — good).
  4. `extract_metadata` (Anthropic call, awaits — **major blocker**).
  5. `save_paper(paper, user_id=user_id)`.
  6. `cloud_storage.upload_file(...)` — blocking PDF upload.
  7. Loop blocking figure PNG uploads.
  8. Return.

- `frontend/src/app/paper/[id]/page.tsx` — `AddPaperPopover`
  `handleUploadFiles` already cachees + adds-session paper, then calls
  `onAdd`. But the upload itself awaits the entire backend pipeline.

### Required fix

Three changes, smallest first.

#### 1) Defer figure / PDF storage upload to a background task

`backend/app/api/papers.py` — `upload_paper`:

- Compute and persist locally first.
- Spawn `cloud_storage.upload_file` calls into `BackgroundTasks` (FastAPI),
  not awaited inline.
- Add `BackgroundTasks` parameter to the route signature; queue the
  uploads after `save_paper`. The endpoint returns immediately after
  the `ParsedPaper` is built and saved locally.

```python
from fastapi import BackgroundTasks
@router.post("/upload", response_model=ParsedPaper)
async def upload_paper(
    request: Request,
    background: BackgroundTasks,
    user_id: str = Depends(require_auth),
):
    ...
    save_paper(paper, user_id=user_id)
    # Per F-UPLOAD-LAG: hand off Storage uploads so the response is not
    # gated on Supabase Storage round-trips. The figure PNGs already exist
    # on disk and the `/pdf` route will proxy + cache before the Storage
    # mirror lands.
    background.add_task(_mirror_to_storage, user_id, paper_id, content, figures_dir)
    slot_reserved = False
    return paper
```

`_mirror_to_storage` is a new helper that does the existing
`cloud_storage.upload_file` PDF + figures loop. It must catch and
log all errors (do not raise out of a background task).

#### 2) Run `extract_metadata` in parallel with the rest

`extract_metadata` is an async LLM call. Today it runs **after**
`extract_pdf`. Restructure so they overlap:

```python
loop = asyncio.get_running_loop()
parse_task = loop.run_in_executor(None, extract_pdf, pdf_path, paper_id)
raw = await parse_task
# Kick off metadata in parallel with figure post-processing if you have any.
meta_task = asyncio.create_task(extract_metadata(raw.raw_text, user_id=user_id))
# ... do other work ...
try:
    meta = await asyncio.wait_for(meta_task, timeout=15)
except (asyncio.TimeoutError, Exception):
    meta = {"title": "", "authors": []}
```

Drop the previously-existing inline `try/except` around
`extract_metadata`. Cap the wait so a slow Anthropic doesn't gate the
whole upload.

#### 3) Frontend: open the reader instantly on first response

`frontend/src/app/paper/[id]/page.tsx` — `AddPaperPopover`:

- After `cachePaper(paper)` and `addSessionPaper`, the `onAdd` flow
  should hand off **immediately** without waiting for the popover's
  fade-out or list refresh.
- In `handleAddPaper`, switch papers via `router.replace` synchronously
  and only then close the popover.
- If `onAdd` is called inside an async loop (multi-file upload), the
  first successful upload should win; subsequent uploads should
  continue silently in the background and surface as session tabs as
  they finish.

### Verification

1. Upload a 10–20 MB PDF inside a workspace. Time from clicking
   "Open" to the reader showing page 1 should be visibly shorter.
2. Network tab: the `upload_paper` response should land before the
   Storage `upload` requests do.
3. The reader page must still be able to render the PDF locally even
   if the Storage mirror is still pending (signed URLs fall back to
   local files; verify the fallback path works).

### Commit

```
perf(frontend, backend): optimistic post-upload navigation [F-UPLOAD-LAG]

Per docs/SPEED_AND_HYDRATION_FIX_PROMPT.md F-UPLOAD-LAG — defer Storage
mirroring to a background task, parallelize metadata extraction, and let
the reader open as soon as the paper row is persisted.

Changes:
- papers.py:upload_paper — BackgroundTasks for storage mirror, parallel metadata
- AddPaperPopover — synchronous router.replace on first success

Verified:
- tsc + eslint touched files (clean)
- python -m py_compile (clean)
- manual: 20 MB PDF upload feels noticeably faster; reader opens before storage mirror
```

---

## F-SPEED — Cold app load and recurring latency

### Symptoms

- The app is slow to first paint.
- Subsequent paper opens still feel laggy.
- Switching tabs in the analysis pane is sometimes janky.

### Root causes

After phases 0–5 these specific items remain on the table:

1. **`katex` is bundled with the main route.** ~250 KB minified.
   `<Md>` is memoized but still imports `katex` synchronously.
2. **`react-pdf` bundle is heavy on the home routes** (dashboard,
   library, settings) because `PdfViewer` is dynamically imported but
   the marketing/dashboard pages still pull in PDF code through
   shared utilities (verify).
3. **Backend cold start on Railway.** Idle workers spin down. First
   request takes seconds.
4. **PDF prefetch fights range requests.** `PdfViewer` already
   schedules a 800 ms timer to background-fetch the full PDF. The
   audit suggests skipping >25 MB and gating prefetch on intent.
5. **Server-side per-request work.** `get_paper` LRU exists. We can
   also add a small in-process cache for `list_papers_meta` since the
   sidebar / library hits it repeatedly.

### Required fix

Pick the changes that don't risk regressions. Implement all three:

#### 1) Lazy-load `Md` (and therefore `katex` + `rehype-katex`)

```tsx
// where Md is currently imported in any route OUTSIDE /paper/[id]:
import dynamic from "next/dynamic";
const Md = dynamic(() => import("@/components/ui/Md").then(m => m.Md), {
  ssr: false,
  loading: () => <span className="opacity-60">…</span>,
});
```

Inside the paper reader leave Md as a static import (it's needed
immediately).

#### 2) Gate the PDF blob prefetch on intent + size

`frontend/src/components/pdf/PdfViewer.tsx`:

- Replace the unconditional `setTimeout(..., 800)` prefetch with an
  intent signal: only background-prefetch if the user has been in the
  reader for at least 3 seconds AND the paper is < 25 MB.

```tsx
useEffect(() => {
  if (!url || cachedBlobUrl) return;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const intent = setTimeout(() => {
    // Per F-SPEED: only prefetch the full PDF when the user actually
    // settles in. Avoid burning bandwidth on quick "just checking" opens.
    timeout = setTimeout(() => doPrefetch(), 0);
  }, 3000);
  return () => {
    clearTimeout(intent);
    if (timeout) clearTimeout(timeout);
  };
}, [url, cachedBlobUrl]);
```

Inside `doPrefetch` skip if `Content-Length > 25 * 1024 * 1024`.

#### 3) Add a tiny TTL cache for `list_papers_meta`

`backend/app/services/db.py` `list_papers_meta(...)`:

- Add a per-(user_id, limit, offset) LRU with 30 s TTL using the same
  pattern as `_paper_cache` in `pdf_parser.py`. Invalidate on
  `delete_paper_meta`, `save_paper_meta`, `update_user_tier`.

Skip if the existing `papersById` Zustand cache already covers your
sidebar use case — check the actual call sites before adding code.

### Verification

1. **Bundle**: run `npm run build`. The route bundle for `/dashboard`
   and `/library` should drop noticeably (KaTeX no longer in main).
2. **Cold open**: open the app from a fresh tab and time first paint;
   it should be visibly faster.
3. **Reader**: switching between session papers stays instant from
   the in-memory cache.
4. **Prefetch**: open the network tab; the full PDF prefetch should
   only fire after a 3 s dwell on the reader page.

### Commit

```
perf(frontend, backend): tighten cold-load and switch latency [F-SPEED]

Per docs/SPEED_AND_HYDRATION_FIX_PROMPT.md F-SPEED — code-split Md so
KaTeX leaves the main bundle, gate PDF prefetch on intent + size,
add a list_papers_meta TTL cache.

Changes:
- ui/Md.tsx + call sites — dynamic import outside the reader
- PdfViewer.tsx — intent + size-gated prefetch
- db.py:list_papers_meta — short-lived LRU cache

Verified:
- npm run build size diff
- tsc + eslint touched files (clean)
- manual: cold-load smoke test
```

---

## VERIFICATION APPENDIX

### Frontend, every commit

```bash
cd frontend
npx tsc --noEmit
npx eslint <touched files> --max-warnings 0
```

Touched-file lint only — do not "fix" pre-existing warnings in
unrelated files in these commits. They are tracked separately.

### Backend, every commit

```bash
python -m py_compile <touched files>
```

### Manual smoke after each commit

1. Sign in.
2. Upload a paper.
3. Open it; figures must show.
4. Restart backend (or remove `paper.json` locally) and re-open.
5. Add a 2nd paper to the session.
6. Switch back to the 1st. No refire of preReading / assumptions in
   the network tab.
7. Refresh once; same observation.

---

## STOP-AND-ASK CONDITIONS (cumulative)

Stop and surface to the user before doing any of these:

1. The cited line range no longer matches the file.
2. A fix conflicts with a more recent commit on `main`.
3. A change would touch any pre-existing migration file.
4. A change requires a new SQL migration that you cannot verify
   locally.
5. A change would drop or rename a public API endpoint or schema
   field.
6. You'd need to add a runtime dependency not listed in
   `frontend/package.json` or `backend/requirements.txt`.
7. The repo-wide `tsc --noEmit` shows pre-existing errors not
   introduced by your edits.
8. ANY destructive shell command would help (`rm`, `git reset --hard`,
   etc.).
9. You'd delete more than 100 lines in a single edit.

When stopping, use the literal phrase **"Stop-and-ask:"** at the
start of your message.

---

## PROMPT END

> The agent should not read past this line on the first pass.

---

### Notes for the human reviewing this prompt

- **Run F-FIGURES first.** It's a real data-loss issue; the others are
  perceptual.
- **Approve the migration before letting the agent push F-FIGURES.**
  Same flow we used for migration 011: the agent will stop and ask.
- **Watch the auto-analysis traffic** (network tab) as you accept
  F-HYDRATION; it's the single best confirmation that this fix
  worked.
- **Don't ship F-SPEED's bundle changes the same week as F-HYDRATION**
  unless you're comfortable shipping two perf-touching changes in
  rapid succession.

— Prompt produced from the live repo at `2c3f085`. Re-generate from
the audit and current `main` any time the cited line ranges drift.
