# Know — bug‑fix briefing for Composer 2.5

> **Scope**: four post‑upload UX defects in the authenticated reader pane (`/paper/[id]`). You will run an investigate → diagnose → fix → verify loop on each one. Do **not** start a rewrite of the analysis‑pane primitives, keep within the workspace `.cursor/rules/*.mdc` (analysis‑pane, architecture, latex). Read those rules first.
>
> **Stack reminders that bit prior models**:
> - Next.js 16 (canary‑style file routing). Read `frontend/node_modules/next/dist/docs/` if you’re unsure about a routing or request API.
> - AI SDK v6 + Zod 4. `streamObject({ schema: zodSchema(z.object({...})) })` is mandatory — bare Zod 4 schemas silently emit invalid JSON Schema and the model has nothing to call (cf. commit `a4d30db`). Do **not** un‑wrap.
> - Model calls go through Vercel AI Gateway when `AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN`) is set; fallback is direct `@ai-sdk/anthropic`. Slugs: `MODEL_ANALYSIS` (`claude-sonnet-4-6`), `MODEL_FAST` (`claude-haiku-4-5`), `MODEL_VISION` (`claude-sonnet-4-6`). One env change = one model swap.
> - Tier gating is the **Python** source of truth. Never duplicate `gating.py`. Stream routes hit `POST /api/internal/usage/reserve` then `release` on failure.
> - Streaming UX (cursor + “streaming…” badge + pulse) lives **only** in `frontend/src/components/analysis/StreamingMarkdown.tsx`. Do not reinvent it.
> - Math: `$...$` inline, `$$...$$` display — Streamdown’s `@streamdown/math` plugin with `singleDollarTextMath: true`. The legacy `Md`/`preprocessLatex` chain is kept exclusively for the Notes path.
>
> **Test plan owner**: the assistant runs `npm run lint` + a manual smoke run after each bug. Do **not** open a PR until all four bugs have green acceptance criteria.

---

## Snapshot of the offending surfaces (where to start reading)

| Concern | File(s) |
|---|---|
| Summary stream + auto‑fire | `frontend/src/components/sidebar/SummaryPanel.tsx`, `frontend/src/app/api/papers/[id]/summary-stream/route.ts`, `frontend/src/lib/server/schemas.ts`, `frontend/src/lib/server/prompts/summary.ts` |
| Auto‑kickstart on upload | `frontend/src/app/paper/[id]/page.tsx` (~L905–L1001 hydration effect + AppearancePopover upload handler), `frontend/src/components/panel/BottomPanel.tsx` (mounted‑tabs gate L86–L102), `frontend/src/lib/analysisState.ts` |
| Persistence of every tab output | `frontend/src/lib/server/internalApi.ts::upsertCachedAnalysis`, `backend/app/api/internal.py::internal_cached_analysis_upsert` (L211–L249), `frontend/src/components/sidebar/AssumptionsPanel.tsx`, `frontend/src/components/sidebar/QAPanel.tsx`, `frontend/src/components/sidebar/FiguresPanel.tsx`, `frontend/src/app/api/papers/[id]/figure-qa-stream/route.ts` |
| Related tab UI | `frontend/src/components/sidebar/RelatedWorkPanel.tsx`, `frontend/src/lib/formatBibliography.ts`, `frontend/src/lib/priorWorkLinks.ts` |
| Notes math hint + parser | `frontend/src/components/notes/NoteMarkdownEditor.tsx` (L42–L44 hint), `frontend/src/lib/latex.ts::remapNoteMathDelimiters` (L11–L25), `frontend/src/components/ui/Md.tsx` (`latexMode === "note"`) |

Read each file top‑to‑bottom **before** editing. If something looks weird (e.g. an effect with three guard refs), assume the original author had a reason; preserve the comment block.

---

## Bug 1 — Summary tab shows spinner forever, never renders anything

### Reported symptom
On a fresh paper upload the Summary tab displays the “Generating detailed summary…” progress bar and the spinner never resolves. No object ever appears, the empty state never appears, the error state never appears. Network panel has not yet been inspected.

### Where to look first
1. `frontend/src/components/sidebar/SummaryPanel.tsx` — the `experimental_useObject` hook. The auto‑fire effect at L81–L88 runs `submitRef.current({})` on mount when the panel is active and there is no cached summary.
2. `frontend/src/app/api/papers/[id]/summary-stream/route.ts` — uses `streamObject({ model: getModel("analysis"), schema: zodSchema(PaperSummarySchema), ... }).toTextStreamResponse({...})`.
3. `frontend/src/lib/server/llm.ts` — Gateway preference logic.
4. `frontend/node_modules/@ai-sdk/react/dist/index.mjs` (search for `useObject`): the client reads the body via `response.body.pipeThrough(new TextDecoderStream()).pipeTo(...)` and calls `parsePartialJson(accumulatedText)` on each chunk. Until `accumulatedText` parses to **something not equal to** the previous value, the React state never updates and `isLoading` stays true. If the server emits **nothing** (model returned empty) or emits **non‑JSON text** the client looks frozen.
5. `vercel.json` already sets `maxDuration: 300` for the route, so Vercel function timeout is not the proximate cause locally.

### Required diagnostic pass (do this BEFORE touching code)
Add temporary, structured logs (delete them once the bug is closed) so the next reproduction tells us exactly which of the three failure modes we have:

- **A.** the model returned zero tokens (Gateway/Anthropic outage, bad slug, prompt rejected),
- **B.** the model returned text but `streamObject` couldn’t coerce it into a tool call (Zod adapter / structured output regression),
- **C.** the stream worked server‑side but the response body never reached the browser (proxy/buffering, missing `Cache-Control: no-store, no-transform`, gateway response object mutated).

Concretely:

1. **Server‑side trace block** in `summary-stream/route.ts` just before the `return result.toTextStreamResponse(...)`:
   ```ts
   // TEMP DIAGNOSTIC — remove once Bug 1 closed.
   const traceId = `sum-${paperId}-${Date.now().toString(36)}`;
   console.log(JSON.stringify({ tag: "summary-stream.kickoff", traceId, paperId, userId: user.userId, model: getModel("analysis").modelId ?? "unknown", promptLen: prompt.length, ctxLen: paper.raw_text.length }));
   // Tee the textStream so we can count emitted bytes without breaking the body.
   const teed = result.textStream.tee?.(); // if available
   void (async () => {
     try {
       let bytes = 0;
       for await (const chunk of result.textStream) bytes += chunk.length;
       console.log(JSON.stringify({ tag: "summary-stream.bytes", traceId, bytes }));
     } catch (err) {
       console.log(JSON.stringify({ tag: "summary-stream.bytes_err", traceId, err: String(err).slice(0, 400) }));
     }
   })();
   ```
   **Important**: `result.textStream` is a single‑consumer `AsyncIterable`. If `toTextStreamResponse()` already consumed it you’ll need to log via `onFinish` (`event.usage.completionTokens`) plus a `ReadableStream.pipeThrough(new TransformStream())` byte counter inserted between the SDK and the response. Pick whichever path the AI SDK build actually supports — read `frontend/node_modules/ai/dist/index.d.ts` around line 5430–5470 (`StreamObjectResult`) before writing.

2. **Client‑side trace block** in `SummaryPanel.tsx`:
   - Log when `submitRef.current({})` fires, including `paperId` and `Date.now()`.
   - In `onError`, log full `err`, including the parsed `detail.code` / `detail.message` if present.
   - In `onFinish`, log `finishError` AND `Object.keys(finalObject || {})`.
   - Add a `useEffect(() => { console.log("summary.object snapshot", Object.keys(object || {})) }, [object]);` so we see whether partial deltas are even arriving.

3. Reproduce: upload a paper that takes >30 s to summarize and watch the server console + browser console + the function logs in Vercel. Capture:
   - `summary-stream.kickoff` + `summary-stream.finish` server logs (already present from commit `d74f9e8`).
   - `summary-stream.bytes` count.
   - Whether the client `object snapshot` ever fires.

### Likely root causes — fix one or all that match the diagnostic readout

> **Do not “fix” all of these blind.** Pick the matching one(s).

- **(A) Empty model output.**
  - Confirm `MODEL_ANALYSIS` env actually resolves to `claude-sonnet-4-6` (or whatever is configured) and that it’s a valid Gateway slug. Hit `getModel("analysis").modelId` in the diagnostic log and confirm the route is `anthropic/claude-sonnet-4-6` when Gateway is used.
  - If the prompt is consistently producing zero output: bump the prompt’s **paper context budget** down to `8000` chars (currently `12000` in `buildSummaryPrompt`) for the summary route. Sonnet 4.6 sometimes refuses very long contexts followed by an oversized JSON schema; the migrated selection route runs at ≤4k of selected text and works.
  - Verify `maxOutputTokens: 8000` matches the model’s actual cap; if Gateway is rejecting it, drop to `4096` and confirm.
  - As a last resort, add `temperature: 0.3` (defaults can be 1.0) — too‑hot temperature with strict tool calls is a documented failure mode.

- **(B) Structured output adapter regression.**
  - Re‑verify the `zodSchema(PaperSummarySchema)` wrap exists (it does in `a4d30db`). Confirm the schema does not contain any field with `z.literal(...)` that Zod 4 might mis‑emit. (It doesn’t today — all fields are `string` / `array` / `nested object`.)
  - Add `output: "object"` explicitly if not the default, to force `streamObject` into the object output strategy and away from any v6 auto‑detection edge case.
  - If `event.error` in `onFinish` is a `TypeValidationError`, log `event.error.cause` and consider relaxing the schema (e.g. making every nested `key_equations[i].equation` `.optional()` so a partially populated object passes).

- **(C) Stream made it server‑side but never reached the client.**
  - Add an explicit `'Content-Type': 'text/plain; charset=utf-8'` header on `toTextStreamResponse`. AI SDK already sets it but a downstream Vercel transform can drop it; being explicit is free.
  - Confirm `runtime = "nodejs"` (already set) — `streamObject` cannot run on Edge with vision content; even though Summary has no vision, keep Nodejs for parity with the other migrated routes.
  - Try running the route locally with `next dev` and curling it via `curl -N -X POST http://localhost:3000/api/papers/<id>/summary-stream -H "Cookie: __session=<clerk_session_cookie>"`. If the body streams there but not in production, the issue is a Vercel buffering layer — file under the (rare) `X-Accel-Buffering: no` cargo‑culted from nginx and re‑confirm the route runs on `nodejs` (not `edge`).

### Acceptance criteria for Bug 1
- Uploading a fresh paper and **not** clicking anything causes the Summary tab’s first heading (`Overview`) to start populating within ≤ 8 s and full summary to land within ≤ 90 s on the standard test paper (`papers/<any>`).
- Vercel function logs show `summary-stream.kickoff`, **at least one non‑zero `bytes` log**, `summary-stream.finish` with `hasObject: true`, AND `cached-analysis upsert` returning 200.
- After page reload the Summary tab shows the cached value instantly without re‑streaming.
- Switching paper mid‑stream still aborts cleanly (no “zombie” summary written to the wrong paper). The existing `stopRef.current()` cleanup must keep working.
- All temporary diagnostic logs **removed** once the fix lands.

---

## Bug 2 — Auto‑kickstart on upload + persist every tab’s output

### Reported behavior
- Sometimes Prepare runs but Assumptions doesn’t (or vice‑versa). The user wants every analyzable tab to begin streaming/loading the moment the paper is opened (whether via upload handoff or library click), with no need to “poke” a tab. Researcher tier; everything tier‑allowed should fire.
- Outputs should be persisted server‑side (`cached_analysis`) so a page reload **never** re‑runs anything that already produced a result. Re‑run only the missing/failed tabs.

### Auto‑kickstart, the contract

Tabs to auto‑fire (Researcher tier — gate each behind `canAccess(tier, feature)`):
1. **Prepare** (`api.analyze`)
2. **Assumptions** (`api.getAssumptions`)
3. **Summary** (streamed via `/api/papers/[id]/summary-stream`)
4. **Related** — derived from Prepare’s `prior_work_topics`, so it inherits Prepare’s kickoff; no separate request.

(Q&A, Figures, Notes are user‑initiated; do **not** auto‑fire them.)

Sequencing rule: fire all three in parallel **as soon as** `loadedPaperId === activePaperId && !tierLoading`. The current effect at `paper/[id]/page.tsx` L917–L1001 already does Prepare + Assumptions; **add a third arm** for the streamed Summary that:
- Calls the streaming route directly via `fetch('/api/papers/<pid>/summary-stream', { method: 'POST', body: '{}' })` and pipes the body through the same `parsePartialJson` loop `useObject` uses, **OR** (preferred) refactors so that `SummaryPanel` no longer owns the “first kickoff” effect — instead, the panel just **reads** the streaming state from the global store + `activeSummaryStreams` map in `analysisState.ts`, and the page‑level effect owns the kickoff.

The page‑level kickoff path is the right one because:
- It already serializes intent (`autoAnalyzedPapers`, `hasActiveRequest`, `allowAutoAnalyzeRetry`).
- The current `SummaryPanel` race (described in commit `c19cecd`) keeps recurring because mount/unmount during paper switching can re‑fire `submit` before the abort lands.

Suggested implementation:

1. Extend `frontend/src/lib/analysisState.ts`:
   - `activeSummaryStreams` already exists. Add a corresponding map keyed by paperId that stores `{ partial: DeepPartial<PaperSummary> | null }`. Expose `subscribeToSummary(paperId, listener)` / `getSummaryPartial(paperId)`.
   - Or, cheaper: stuff streamed partials directly into Zustand via a new `summaryStreamingByPaper: Record<string, DeepPartial<PaperSummary> | null>` slice. Update on every parsed chunk.

2. New helper `frontend/src/lib/streamSummary.ts` that:
   ```ts
   export async function streamSummaryForPaper(paperId: string, signal?: AbortSignal): Promise<PaperSummary | null>
   ```
   - POSTs to `/api/papers/${paperId}/summary-stream` with `Content-Type: application/json` and an empty body.
   - Reads the body via `response.body.pipeThrough(new TextDecoderStream())`, accumulating text, calling `parsePartialJson` (re‑export it from `ai` package — it’s the same function `useObject` uses).
   - On every parse update, writes the partial into the store (`summaryStreamingByPaper[paperId]`).
   - On close, validates final against `PaperSummarySchema`; on success, calls `setSummary(finalObject)` + `updateCachedAnalysis(paperId, { summary: finalObject })`.

3. In `paper/[id]/page.tsx` add a third parallel kickoff (right next to Prepare and Assumptions):
   ```ts
   const hasSummary = !!cache.summary || !!sessionCache.summary || !!storeSnap.summary;
   if (
     !hasSummary &&
     canAccess(tierUser?.tier || "free", "summary") &&
     !hasActiveRequest(pid, "summary") &&
     !autoAnalyzedPapers.has(`${pid}:summary`)
   ) {
     const ac = new AbortController();
     activeSummaryStreams.set(pid, ac);
     markRequestStart(pid, "summary");
     setSummaryLoading(true);
     streamSummaryForPaper(pid, ac.signal)
       .then((s) => {
         if (useStore.getState().paper?.id !== pid) return;
         if (s) {
           setSummary(s);
           useStore.getState().updateCachedAnalysis(pid, { summary: s });
         }
         autoAnalyzedPapers.add(`${pid}:summary`);
       })
       .catch(() => {})
       .finally(() => {
         markRequestEnd(pid, "summary");
         clearProgressStart(pid, "summary");
         activeSummaryStreams.delete(pid);
         if (useStore.getState().paper?.id === pid) setSummaryLoading(false);
       });
   }
   ```
   - Extend `allowAutoAnalyzeRetry(paperId)` to also delete `${pid}:summary`.

4. Refactor `SummaryPanel.tsx`:
   - Drop the `useObject` call.
   - Render from `useStore((s) => s.summaryStreamingByPaper[paperId] ?? s.summary)` (or whatever shape you settle on).
   - Keep the `streamingCursorField` logic so the caret still advances across sections.
   - Manual “Generate Summary” button on the empty state calls the same `streamSummaryForPaper(pid)` helper (with a fresh AbortController and a `triggered.current` style guard so re‑clicking while in flight is a no‑op).
   - The panel must continue to honour the “current paper guard” — write back only if `useStore.getState().paper?.id === paperId`.

5. `BottomPanel.tsx` (L86–L102): the “lazy‑mount tabs on first visit” code keeps the Assumptions and Q&A panels unmounted until the tab is selected. That’s correct UX. **Don’t** force every tab to mount on upload — keep the kickoff at the page level so the data is loading whether or not the tab is mounted. The panels themselves should be pure “render whatever the store has” when mounted.

6. **Failure inconsistency** (“sometimes Prepare or Assumptions doesn’t work”): the current `paper/[id]/page.tsx` hydration effect catches the failure (`.catch(() => {})`) and **does** clear `markRequestEnd` in `finally`, but it does NOT add to `autoAnalyzedPapers` on failure, so subsequent renders re‑try indefinitely. That part is fine. The actual race comes from:
   - The effect dependency array includes `loadedPaperCache` — a refetch of the paper triggers re‑evaluation while the original kickoff is still in flight.
   - `hasActiveRequest` reads `activeRequests` AND, for kind === "summary", reads `activeSummaryStreams`. Confirm both branches are accurate. (Reading `analysisState.ts`: `hasActiveRequest("summary")` returns `activeSummaryStreams.has(paperId)`, which is correct — but you have to **register** the AbortController BEFORE the async kickoff returns control, otherwise a fast double‑render fires the request twice. Wrap the registration in the same synchronous block as `markRequestStart`.)
   - Add a dedicated `tryKickoff` helper that takes a `kind` plus a synchronous guard `() => boolean` and ensures only one in‑flight request per `paperId × kind`.

### Persist every tab’s output to `cached_analysis`

The backend `/api/internal/cached-analysis/upsert` endpoint already accepts any `key`. Audit and close gaps:

- **Summary** — persisted (`route.ts` already calls `upsertCachedAnalysis({ key: "summary" })`). No change once Bug 1 is fixed.
- **Selections** — persisted (selection‑stream route).
- **Figure analyses** — figure‑qa‑stream route persists with `key: "figure_analyses"`. **Gap**: the backend handler only appends for `key in {"selections", "qa_history"}` (`backend/app/api/internal.py` L236). `figure_analyses` therefore **overwrites** each call — last figure wins. **Fix**: add `"figure_analyses"` to the appended set, and have the route post `{ figure_id, question, ...finalObject }` (it already does). On the client, deduplicate by `(figure_id, question)` when rendering. Also update the matching set in any other writer.
- **Q&A** — already appended to `cached_analysis.qa_sessions` by `backend/app/api/analysis.py::answer_questions`. **Verify**: cross‑paper Q&A also persists per‑paper (or, if it’s legitimately cross‑paper, persist to each paper or to a workspace‑scoped row). The store hydrates from `qa_sessions[].items` in `paper/[id]/page.tsx::hydrateFromCachedAnalysis` L885–L890 — confirm new sessions show up after reload.
- **Assumptions** — `getAssumptions` already persists. Confirm the cooldown timestamp logic in `cached_analysis.assumptions_cooldown_until` still works.
- **Pre‑reading** — `api.analyze` persists.
- **Notes** — `addNote` / `updateNote` already persist server‑side. No change.

### Acceptance criteria for Bug 2
- Uploading a paper triggers, **in parallel**, exactly one in‑flight Prepare, one Assumptions, and one Summary request. Other tabs do **not** auto‑fire.
- Page logs (server) show `summary-stream.kickoff`, `analyze` complete, `assumptions` complete within the same paper session — no duplicate kickoffs for the same `paperId × kind`.
- Reloading the page after the three jobs complete:
  - shows summary/prepare/assumptions instantly from cache,
  - does **not** issue any of those three POSTs again (verify in DevTools network),
  - the Q&A panel and Figures panel show whatever was previously generated.
- Uploading a second paper while the first is still streaming aborts the first’s in‑flight summary cleanly (no “zombie” cache write to the new paper).
- Tier gating: spoof `tier === "free"` and confirm Prepare and Assumptions do **not** auto‑fire (free tier is summary/qa/selection only per `FEATURE_TIER_FLOOR` in `frontend/src/lib/server/auth.ts`).
- A failed first kickoff (kill the backend, reload) is retried automatically on next mount — `autoAnalyzedPapers` does NOT permanently latch on a failed paper.

---

## Bug 3 — Related tab visual treatment is “yucky”

### Reported symptom
The Related tab renders citations from `preReading.prior_work_topics` (themed clusters) or falls back to a flat `prior_work` list. The user finds the layout messy: theme headings, cluster blurbs, numbering chips, and verbatim citations don’t cohere visually.

### Constraints (from `.cursor/rules/analysis-pane.mdc`)
- No new colors, no new shadow tokens, no new motion durations.
- Card bg `bg-card/30 dark:bg-card/22`, borders `border-border/50`, spacing `space-y-8` between sections / `space-y-3` inside / `space-y-2` for list items.
- Use `AnalysisSection` / `AnalysisCard` for any new titled blocks. Do not hand‑roll a `<section>` if a primitive exists.
- Display math is irrelevant here — keep math handling unchanged.

### What to redesign in `RelatedWorkPanel.tsx`

Current behavior (read L150–L217 first):
- A leading `RELATED_TAB_INTRO` paragraph.
- Either themed clusters (rounded card per cluster, theme heading, optional cluster summary, numbered list) **or** a flat numbered list.
- Each citation row: a small filled badge with the global index, plus a hyperlinked verbatim citation.

Redesign (the constrained, “quiet, scholarly” direction the rest of the analysis pane uses):

1. **Drop the cluster card chrome.** Replace each themed cluster with:
   ```tsx
   <AnalysisSection title={theme} count={items.length}>
     {summary ? (
       <p className="text-[var(--text-sm)] leading-relaxed text-muted-foreground">
         {sanitizeRelatedClusterSummaryMarkdown(summary)}
       </p>
     ) : null}
     <ol className="mt-3 space-y-2">
       {items.map(...)}
     </ol>
   </AnalysisSection>
   ```
   - Theme headings become real `<h3>` via `AnalysisSection` (consistent with Summary, Prepare).
   - Skip the heading row entirely when the theme is missing or matches `/^other references?$/i`.
   - Cluster summary becomes a single muted paragraph — render the cluster summary through `<StreamingMarkdown>` only if it actually contains math/links/markdown; otherwise plain text.

2. **Tighten the citation row**:
   - Replace the heavy filled badge with a quiet `tabular-nums` index prefix (`<span className="mt-px shrink-0 w-6 text-right text-[var(--text-xs)] text-muted-foreground/70">{n}.</span>`) — matches the way the Summary tab numbers contributions.
   - Citation text: `text-[var(--text-sm)] leading-relaxed text-foreground/90`.
   - Hyperlink decoration: `underline decoration-border hover:decoration-foreground/60 underline-offset-[3px]`. Drop the primary‑color treatment — these are *links to search*, not first‑class actions.

3. **One global index across clusters** is fine; keep the existing `clusterGlobalStarts` math.

4. **Strip leftover orphan tokens** the LLM still leaks. Audit `sanitizeCitationForDisplay` in `frontend/src/lib/formatBibliography.ts` (L160+). It already strips common patterns; if you find a real failing reference during smoke testing, add a regex case here (do not branch inside the panel component).

5. **Empty / loading states** keep the existing `EmptyState` + `AnalysisProgress` patterns. No new spinners.

6. **Footer** — keep the “Refresh from Prepare…” button but move it inside a small `AnalysisSection`‑adjacent footer row using `text-[var(--text-xs)] text-muted-foreground hover:text-foreground`; drop the heavy `border-t border-border/50 pt-3` rule that visually doubles up next to the last cluster card.

7. **No new tokens.** Every Tailwind class you add must already exist somewhere in the codebase (grep first). If you genuinely need a one‑off, add a one‑line comment justifying it (per analysis‑pane rule).

8. **LOC budget**: `RelatedWorkPanel.tsx` should stay ≤ 230 LOC after the change (current ≈ 220 LOC).

### Acceptance criteria for Bug 3
- Themed‑cluster rendering uses `AnalysisSection` (no bespoke section wrapper).
- No more filled badges on citation rows; numeric prefix matches the Summary `key_contributions` numbering style.
- A paper whose `prior_work_topics` is empty falls back gracefully to a flat numbered list with the same visual style.
- The “Tap a citation to search Google Scholar.” intro reads as a small muted help line, not a card.
- Visual smoke test against three sample papers (papers/* in repo): no obvious orphan numbers, no duplicated long sentences, no broken `\` escapes in the rendered citation text.
- `npm run lint` clean; no new color/shadow/animation tokens introduced.

---

## Bug 4 — Notes tab: `$$$$…$$$$` should be `$$…$$`

### Reported symptom
The Notes preview hint reads literally:
```
Math: $…$ inline · own-line blocks $$$$…$$$$
```
The user wants two dollar signs on each side both **in the hint** and **as the actual parser convention**. The four‑dollar hack is non‑standard and confuses readers.

### Files
- `frontend/src/components/notes/NoteMarkdownEditor.tsx` — L42–L44, hint string in the preview header.
- `frontend/src/lib/latex.ts` — `remapNoteMathDelimiters` (L11–L25) is the only place that special‑cases the four‑dollar convention. Call site: `Md.tsx` when `latexMode === "note"`.
- `frontend/src/components/ui/Md.tsx` — `latexMode="note"` path in `NoteMarkdownEditor` is the only place that uses note mode.

### Fix
1. **Hint string** — replace the offending JSX block:
   ```tsx
   <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[10px]">$$…$$</code>
   ```
   Use plain ASCII `$$…$$` (with the existing horizontal ellipsis). Both sides have **two** dollars.

2. **Parser** — `remapNoteMathDelimiters` currently does:
   ```ts
   // $$$$ → display, $$ → inline
   ```
   Change it so that `$$ … $$` is **display** (already standard remark‑math), and inline math uses `$ … $`. Concretely:
   - Delete `remapNoteMathDelimiters` (or convert it to a no‑op stub kept for the call site) so the persisted note body passes straight to remark‑math with default semantics.
   - Update the function comment block and the surrounding JSDoc in `latex.ts` and `Md.tsx` that documents the old `$$$$` convention. The `Md.tsx` JSDoc at L24–L27 must be rewritten:
     ```ts
     /**
      * `note` skips the analysis-content heuristics that promote inline math
      * to display. Math delimiters follow the standard convention: $...$ inline,
      * $$...$$ display.
      */
     ```
   - Confirm `preprocessLatex` still does the rest of its work (PDF junk strip, `\(`→`$`, `\[`→`\n$$\n`, etc.) — only the `noteMode` branch that called `remapNoteMathDelimiters` is gone.

3. **Migration of existing notes** — if any user notes in production already use the `$$$$ … $$$$` convention, leaving them as‑is would render the literal `$$ … $$` plus surrounding stray `$$`. Two safe options; pick (a) unless you find evidence of pre‑existing notes in the `notes` table:
   - **(a)** Trust that no one has been writing four‑dollar math in production yet (the convention is undocumented outside the hint). Do nothing.
   - **(b)** Add a one‑shot remap: when a note string is loaded, if it contains `$$$$...$$$$`, automatically collapse each pair to `$$...$$`. Implement once in `NoteMarkdownEditor` (or `Md.tsx` note mode) as `value.replace(/\$\$\$\$([\s\S]*?)\$\$\$\$/g, "$$\n$1\n$$")` so legacy notes still render correctly without re‑authoring. Document the deprecation in the function comment.

   The user requested the second behavior implicitly (“just fix it everywhere”), so implement **(b)**.

### Acceptance criteria for Bug 4
- The hint string in the Notes preview reads `…inline · own-line blocks $$…$$`.
- Typing a fresh note with `$$ x^2 + y^2 $$` renders display KaTeX in the preview.
- Typing inline `$\alpha$` renders inline KaTeX.
- Loading any pre‑existing four‑dollar note still renders display math (one‑shot remap).
- No call site of `remapNoteMathDelimiters` remains other than the migration shim (or the function is deleted entirely).
- `Md.tsx` JSDoc no longer references the legacy convention.

---

## Cross‑cutting workflow rules

1. **Touch every file you change with a one‑line rationale comment if non‑obvious.** Don’t add narrative comments. Heed `.cursor/rules/*.mdc`.
2. **Do not introduce new dependencies.** All required packages (`ai`, `@ai-sdk/react`, `@ai-sdk/provider-utils`, `streamdown`, `katex`, `zustand`, `zod`, `clerk`, `supabase`, etc.) are present.
3. **Console logging in production paths is banned** (`.cursor/rules/architecture.mdc`). Diagnostic logs in Bug 1 must be removed before the change lands. Use structured `console.log(JSON.stringify({tag, ...}))` only — never bare strings — while debugging.
4. **Lint, type‑check, smoke**:
   ```
   cd frontend && npm run lint
   cd frontend && npm run build      # full type-check
   ```
   Both must pass before opening a PR.
5. **Manual reproduction script** (run after fixes):
   1. `npm run dev` from `frontend/`.
   2. Sign in as a Researcher‑tier test user.
   3. Upload a fresh PDF.
   4. Without clicking any tab, wait ≤ 90 s. The Summary tab content, Prepare tab content, and Assumptions tab content should all be present when each tab is clicked.
   5. Open the Related tab — citations render in the new layout.
   6. Open the Notes tab — preview hint shows `$$…$$`. Add a note with `$$ x^2 $$` and confirm display math.
   7. Hard refresh the page. Nothing re‑streams; everything is present from cache.
   8. Upload a second paper. Switch back to the first. Both still show full state, no missing tabs.
6. **PR layout** — one PR with four commits, one per bug, in this order: Bug 4 (smallest), Bug 3, Bug 2, Bug 1. Each commit message must include a “Why” sentence and an “Acceptance verified by” bullet list.

---

## What you must NOT do

- Do not migrate or rebuild any panel primitive (`AnalysisSection`, `OverflowMenu`, `StreamingMarkdown`, `AnalysisAccordionRow`, `AnalysisCard`, `useSelectionThread`, `useStreamingObject`) — these are workspace‑owned per `.cursor/rules/analysis-pane.mdc`. Use them as‑is. If `AnalysisCard` / `useStreamingObject` aren’t in the tree yet, **do not create them as a side quest**.
- Do not reintroduce the deprecated `Md` / `preprocessLatex` chain in any new migrated path. It is only allowed in the Notes path per `.cursor/rules/latex.mdc`.
- Do not touch the Python `gating.py` / `internal.py` security model. Only the appended‑key set in `internal_cached_analysis_upsert` is in scope.
- Do not change Anthropic model slugs without an explicit env variable plan.
- Do not add a new `ContentBlock[]` schema; migrated paths use markdown strings + Streamdown math (per `.cursor/rules/latex.mdc`).
- Do not commit `.env` or other secrets.
- Do not open a PR for a partial set of fixes — finish all four bugs in one PR. (If you can’t close Bug 1 with confidence, surface a written hand‑off note and stop; do not paper over with a fake fix.)

---

## Quick orientation checklist (read before writing code)

- [ ] `.cursor/rules/architecture.mdc`
- [ ] `.cursor/rules/analysis-pane.mdc`
- [ ] `.cursor/rules/latex.mdc`
- [ ] `frontend/AGENTS.md` (the “This is NOT the Next.js you know” reminder)
- [ ] `frontend/src/app/api/papers/[id]/summary-stream/route.ts`
- [ ] `frontend/src/app/api/papers/[id]/selection-stream/route.ts` (reference impl)
- [ ] `frontend/src/components/sidebar/SummaryPanel.tsx`
- [ ] `frontend/src/components/panel/BottomPanel.tsx`
- [ ] `frontend/src/app/paper/[id]/page.tsx` (auto‑kickoff effect)
- [ ] `frontend/src/lib/analysisState.ts`
- [ ] `frontend/src/lib/store.ts`
- [ ] `frontend/src/components/sidebar/RelatedWorkPanel.tsx`
- [ ] `frontend/src/lib/formatBibliography.ts`
- [ ] `frontend/src/components/notes/NoteMarkdownEditor.tsx`
- [ ] `frontend/src/lib/latex.ts`
- [ ] `frontend/src/components/ui/Md.tsx`
- [ ] `backend/app/api/internal.py`

Acknowledge each bug in the assistant turn before you start writing code so the user can stop you if your plan diverges from the brief. Then proceed bottom‑up: Bug 4 → Bug 3 → Bug 2 → Bug 1.
