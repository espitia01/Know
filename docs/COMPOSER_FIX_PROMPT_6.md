# Know — bug‑fix briefing #6 for Composer 2.5

> **Scope**: five reader bugs plus a cost‑reduction track. Two of the bugs are simple UX gaps (figure model invisibility, follow‑up menu clipping off the page). One is a rendering regression in `SummaryPanel` (key takeaway shows raw `$(\theta, 0, -\theta)$` instead of rendered math). One is a Prepare‑tab reliability issue that survived PROMPT_5 (auto‑extract silently fails on some papers and never retries). One is a selection‑toolbar heuristic gap: the **Derive** button doesn't appear for matrix selections or other math the heuristic misses, leaving users with no way to ask for a step‑by‑step. The cost track lands real savings without a model downgrade: Anthropic prompt caching across migrated streaming routes, tighter `maxOutputTokensFor` budgets, and a section‑aware paper excerpt for the Python `analyze_paper` prompt.
>
> **Stack reminders**: Next.js 16 + AI SDK v6 + Zod 4. Streaming + Q&A routes are migrated to `frontend/src/app/api/papers/[id]/*-stream/route.ts` and go through `@ai-sdk/anthropic` (or Gateway). Batch endpoints (`/api/papers/{id}/analyze`, `/api/papers/{id}/assumptions`, `/api/papers/{id}/qa`) still run on Python (`backend/app/services/llm.py`). Tier gating + model resolution remain Python‑authoritative (`gating.py`, `resolve_*_model`). Anthropic key lives in **both** Vercel and Railway env.
>
> **Rules to keep in mind** — read first:
> - `.cursor/rules/analysis-pane.mdc` (no new tokens, ≤200 LOC `BottomPanel`, primitives only)
> - `.cursor/rules/architecture.mdc` (streaming on Next, batch on Python, never local model)
> - `.cursor/rules/latex.mdc` (migrated paths use `$...$` / `$$...$$` markdown inside Streamdown — do **not** restore `preprocessLatex` / `remark-math` for the Summary takeaway; render through `StreamingMarkdown`)
>
> **Test plan**: after each bug, `cd frontend && npm run lint && npm run build`. For the backend changes, `cd backend && pytest -q backend/tests`. Manually smoke each surface in the IDE preview.
>
> **Order**: 2 → 3 → 4 → 6 → 1 → 5 (UX wins first, persistence last, cost track last since it touches every migrated route).

---

## Snapshot of the offending surfaces

| Concern | Files |
|---|---|
| Prepare tab fails silently on some papers | `backend/app/services/llm.py` (`analyze_paper`, `_safe_parse_json`), `backend/app/api/analysis.py` (`/analyze`), `frontend/src/lib/analysisState.ts` (`syncAutoAnalyzeGuardsFromCache`), `frontend/src/app/paper/[id]/page.tsx` (auto‑Prepare effect), `frontend/src/components/sidebar/PreReadingPanel.tsx` |
| Key takeaway in Summary doesn't render LaTeX | `frontend/src/components/sidebar/SummaryPanel.tsx`, `frontend/src/lib/text.ts` (`firstSentence`) |
| Figure analysis hides which model is running | `frontend/src/components/sidebar/FiguresPanel.tsx`, `frontend/src/components/analysis/CardMeta.tsx`, `frontend/src/components/analysis/ModelOverridePill.tsx` |
| Follow‑up model menu clips off the right edge of the page | `frontend/src/components/analysis/OverflowMenu.tsx`, `frontend/src/components/analysis/ModelOverridePill.tsx`, `frontend/src/components/panel/SelectionResultPanel.tsx` |
| Derive button missing on matrix / Greek‑math selections | `frontend/src/lib/selectionMathHeuristic.ts`, `frontend/src/components/pdf/SelectionToolbar.tsx`, `frontend/src/lib/__tests__/selectionMathHeuristic.test.ts` (new) |
| Cost reduction without quality loss (Anthropic prompt caching, output budgets, section‑aware excerpt) | `frontend/src/lib/server/llm.ts`, `frontend/src/lib/server/prompts/*.ts`, `frontend/src/app/api/papers/[id]/*-stream/route.ts`, `backend/app/services/llm.py`, `backend/app/services/anthropic_provider.py` (or wherever `AnthropicProvider.complete` lives), `backend/app/services/paper_excerpt.py` (new) |

Do **not** revert PROMPT_3/4/5 patterns (`UserSettingsContext`, `RichContent` for migrated paths where applicable, `syncAutoAnalyzeGuardsFromCache`, panel mount safety nets, `formatBibliography` 480‑char cap, `OverflowMenu` body portal). Build on top of them.

---

## Bug 1 — Prepare tab silently fails on some papers ("works on this paper, breaks on that paper")

### Reported symptom
> "Sometimes the prepare tab fails randomly in some papers."

Re‑opening the same paper later may also work. Other papers consistently break and the tab is stuck on either "Analyze Paper" or an empty state without ever showing a real error.

### Root cause — two layered bugs

#### 1a. Backend persists an empty `pre_reading` payload, which masks failures
`backend/app/services/llm.py::analyze_paper` calls `_safe_parse_json(raw)` (also in `llm.py`). When the model emits truncated JSON or wraps it in markdown code fences in an unrecoverable way, `_safe_parse_json` swallows the `JSONDecodeError` and **returns `{}`**. `analyze_paper` then builds a `PreReadingAnalysis(definitions=[], research_questions=[], prior_work=[], prior_work_topics=[], concepts=[])` and the `/analyze` endpoint's `finally:` block writes that empty object into `cached_analysis.pre_reading`.

On the next paper open, the FE's `syncAutoAnalyzeGuardsFromCache` (post‑PROMPT_5) sees `cache.pre_reading !== undefined` and **sets** the auto‑Prepare guard, blocking the retry that would otherwise re‑extract. Tab is stuck.

A second failure mode: `analyze_paper` uses `max_tokens=8192` (line ~846). For papers with long bibliographies, Sonnet sometimes truncates the JSON mid‑bib entry. `_safe_parse_json` does brace/bracket repair, but the recovered payload can still be missing `definitions` / `research_questions` / `concepts`, which is the *useful* part of Prepare.

#### 1b. Frontend auto‑Prepare swallows errors
`frontend/src/app/paper/[id]/page.tsx` ~L948 the auto‑Prepare branch calls `api.analyze(pid).then(...).catch((err) => s.setPreReadingError(pid, msg))`. The `analyze` endpoint never raises for empty payloads — it returns 200 with empty arrays — so the error path never fires. The Prepare panel's mount safety net also bails because `cache.pre_reading` exists on disk.

### Required fix

#### 1a. Backend: validate, do not persist empty Prepare output, surface 503

1. In `backend/app/services/llm.py::analyze_paper`, after `result = _safe_parse_json(raw)`:
   - Compute `is_usable = bool(result.get("definitions")) or bool(result.get("research_questions")) or bool(result.get("concepts"))`.
   - If `not is_usable` **and** `len(raw.strip()) < 200`: log a warning with the slug (`provider.model`) and the first 200 chars of `raw`, then raise `ValueError("Prepare returned empty payload")`. The existing handler in `analysis.py` already maps `ValueError → 503`.
   - If `not is_usable` **and** raw is long (i.e. model emitted *something* but the JSON parser failed): try one repair pass — strip leading ` ```json ` and trailing ` ``` ` if present, retry `json.loads`. If that still fails, raise `ValueError`.

2. Bump `max_tokens` for `analyze_paper` from `8192` to `12000`. Bibliographies of ~50 entries plus definitions / concepts / questions routinely hit the old cap. The output cap is the most expensive lever, so don't raise it further than necessary — 12k is the sweet spot for Sonnet 4.6 on this prompt.

3. In `backend/app/api/analysis.py::analyze`, change the `finally:` persistence to only run when `analysis_payload` is non‑empty *and* at least one of `definitions / research_questions / concepts` has items. Concretely:
   ```python
   def _is_usable(payload: dict) -> bool:
       return bool(
           payload.get("definitions")
           or payload.get("research_questions")
           or payload.get("concepts")
       )
   ```
   Wrap the existing `mutate_paper` call with `if analysis_payload is not None and _is_usable(analysis_payload):`. Empty payloads should not poison the cache.

4. Add tests in `backend/tests/test_prepare_analyze.py`:
   - `test_analyze_paper_raises_on_empty_payload` — monkeypatch the provider to return `""` and expect `ValueError`.
   - `test_analyze_paper_raises_on_no_useful_fields` — provider returns `{}` (or a string that parses to `{}`), expect `ValueError`.
   - `test_analyze_paper_accepts_partial_payload` — provider returns `{"definitions": [...], "concepts": []}`, expect a `dict` with `definitions` populated.
   - `test_analyze_endpoint_does_not_persist_empty` — full‑stack fixture: empty payload → 503, `cached_analysis.pre_reading` unchanged.

#### 1b. Frontend: allow retry when the persisted Prepare payload is empty

1. In `frontend/src/lib/analysisState.ts::syncAutoAnalyzeGuardsFromCache`, **only** set the `preReading` guard when the cached payload is *populated*. Empty `{}` cached pre_reading from older deploys (or pre‑fix sessions) should still clear the guard so we can retry once. Mirror this for `assumptions`. Concretely:
   ```ts
   const hasPre = isPreReadingPopulated(cache.pre_reading) || isPreReadingPopulated(sessionCache.pre_reading);
   if (hasPre) autoAnalyzedPapers.add(`${paperId}:preReading`);
   else autoAnalyzedPapers.delete(`${paperId}:preReading`);
   ```
   Drop the `hasPreKey` branch — sticky guard from an empty payload was the source of the "Prepare tab stuck" symptom.

2. In `frontend/src/app/paper/[id]/page.tsx`, the auto‑Prepare effect's `.catch` already calls `s.setPreReadingError`. Also call `autoAnalyzedPapers.delete(`${pid}:preReading`)` inside `.catch` so the **next** mount of the panel can retry — without this, a transient failure leaves the user stuck until they click Retry.

3. In `frontend/src/components/sidebar/PreReadingPanel.tsx`, the mount safety net already runs `handleAnalyze` on empty `preReading`. Make sure it also runs when `cache.pre_reading` is set but empty (already handled by the `isPreReadingPopulated` check inside).

4. In `frontend/src/lib/preReading.ts::isPreReadingPopulated`, drop `prior_work` from the OR — Prepare is "populated" only when at least one of `definitions / research_questions / concepts` is non‑empty. Bibliography (`prior_work`) is built server‑side from the references section even when the model returned nothing useful, so it should not be enough to mark Prepare as "done".

5. **No retry storms.** Surround the auto‑Prepare in‑page effect with a session‑local cooldown of 30 s: if a previous attempt for the same `pid` failed within 30 s, skip the auto‑retry (the user can still hit the Retry button). Use a new `Map<string, number>` keyed by paper id in `analysisState.ts`.

### Acceptance
- Manually corrupting `cached_analysis.pre_reading = {}` in Supabase for a test paper and reloading the reader triggers a fresh `/api/papers/{id}/analyze` call exactly once (not a loop), persists a populated payload, and renders Prepare normally.
- A monkeypatched provider returning `""` shows the Prepare empty‑state with a Retry button and a visible error message.
- `npm run lint`, `npm run build`, and `pytest backend/tests/test_prepare_analyze.py -q` all pass.

---

## Bug 2 — Key takeaway in Summary renders raw `$(\theta, 0, -\theta)$` instead of math

### Reported symptom
> "Key takeaways does not render latex: `$(\theta, 0, -\theta)$`."

### Root cause
`frontend/src/components/sidebar/SummaryPanel.tsx` ~L134 renders the takeaway as a plain `<p>`:
```tsx
<p className="mt-1 text-[var(--text-sm)] leading-relaxed text-foreground/90">{takeaway}</p>
```
The takeaway is `firstSentence(s.tl_dr ?? s.overview)` — a slice of the same markdown string the rest of the panel runs through `StreamingMarkdown` (which uses Streamdown + KaTeX). Plain `<p>` doesn't process `$...$`. The migrated Summary path already enforces `$...$` / `$$...$$` in its prompt (see `frontend/src/lib/server/prompts/summary.ts`), so the model emits valid LaTeX delimiters that the takeaway then prints verbatim.

A secondary issue: `firstSentence` in `frontend/src/lib/text.ts` can truncate mid‑`$...$` block on long takeaways, producing an unmatched `$` that KaTeX then refuses to render and Streamdown shows as the literal `$`.

### Required fix

1. **Render the takeaway through `StreamingMarkdown`.**
   ```tsx
   {takeaway && (
     <div className="rounded-[var(--radius-lg)] border border-border/50 bg-card/35 px-4 py-3 dark:bg-card/22">
       <p className="text-[var(--text-xs)] font-medium uppercase tracking-[0.12em] text-muted-foreground/85">
         Key takeaway
       </p>
       <div className="mt-1 text-[var(--text-sm)] leading-relaxed text-foreground/90">
         <StreamingMarkdown>{takeaway}</StreamingMarkdown>
       </div>
     </div>
   )}
   ```
   No new tokens. The wrapping element flips from `<p>` to `<div>` because `StreamingMarkdown` may emit block‑level children.

2. **Make `firstSentence` math‑aware.** In `frontend/src/lib/text.ts`:
   - Before applying the sentence regex, find all `$...$` and `$$...$$` spans (a simple state machine: walk the string, toggle `inMath` on each unescaped `$` boundary, remembering whether the run is `$` or `$$`).
   - When the chosen sentence cut falls *inside* a math span, extend it to the next `$` (or `$$`) close so the result is always balanced. If extending past `maxLen + 80` chars, fall back to dropping the trailing partial math span entirely (strip from the last opening `$` onward) so we never emit an unmatched delimiter.
   - Same logic for the length‑based truncation at the bottom of the function.
   - Add unit tests in `frontend/src/lib/__tests__/text.test.ts` (create the file if needed) covering:
     - "We show that `$(\theta, 0, -\theta)$` is the…" — sentence ends after the math span, no truncation needed.
     - A long sentence with `$$E = mc^2$$` in the middle truncated at `maxLen` falls back to dropping the partial math.
     - A sentence with an *unclosed* `$` returns text without the dangling delimiter.

3. **No new tokens / no animation.** The takeaway is non‑streaming (it's computed after the stream finished — `stillStreaming` short‑circuits to `""`), so no cursor / pulse needed.

### Acceptance
- `$(\theta, 0, -\theta)$` in the takeaway renders as italic three‑tuple via KaTeX, identical to inline math elsewhere in the panel.
- `firstSentence` unit tests pass.
- A summary whose first sentence is "We show that $\\frac{a}{b} = c$ holds." renders the fraction inline.

---

## Bug 3 — Figure analysis hides which model is running

### Reported symptom
> "In figures, when asking to analyze a figure, also show the models."

### Root cause
`frontend/src/components/sidebar/FiguresPanel.tsx` ~L670 reads the model only from `paper?.cached_analysis?.figure_analyses?.find(...)?.model`. That field is **only populated after `onFinish` writes the cached entry** (see `figure-qa-stream/route.ts` line ~158 — `upsertCachedAnalysis(... model: fastModel)`). During the streaming pass, `CardMeta` falls back to nothing and the user sees no pill.

Selection (`SelectionResultPanel`) already solved this via PROMPT_3 + PROMPT_5 by using `useUserSettings().fastModel` as a provisional pill (`<ModelPill slug={resolvedModel} pending={isStreaming && !result.model} />`). Figures lags behind.

### Required fix

1. **Hoist the resolved model to the panel state.** Add `const [streamModel, setStreamModel] = useState<string | null>(null);` to `FiguresPanel`. In `handleAnalyze`, *before* the `fetch`, set `setStreamModel(fastModel)` where `fastModel` comes from `useUserSettings()` (already imported elsewhere; add the hook call near the top of `FiguresPanel`). Reset to `null` on `setSelected(null)` and on `paperId` change.

2. **Read `X-Know-Model` from the response and override.** The existing code already does `const streamModel = res.headers.get("X-Know-Model") ?? undefined;` inside `handleAnalyze`. Promote that local to the state: `if (streamModel) setStreamModel(streamModel)`.

3. **Render the pill while streaming.** Below the `AuthImage` figure preview, render the `CardMeta` whether or not a cached analysis exists. Show the live model with a `pending` flag while `loading` is true:
   ```tsx
   <CardMeta
     model={
       streamModel ??
       paper?.cached_analysis?.figure_analyses?.find((a) => a.figure_id === selected.id)?.model ??
       fastModel
     }
     pending={loading}
     createdAt={
       paper?.cached_analysis?.figure_analyses?.find((a) => a.figure_id === selected.id)?.created_at
     }
     extra={<span className="text-muted-foreground/75">{selected.caption ? `Fig. · page ${selected.page + 1}` : `Page ${selected.page + 1}`}</span>}
   />
   ```
   Make sure `CardMeta` (`frontend/src/components/analysis/CardMeta.tsx`) accepts `pending?: boolean` and forwards it to `ModelPill` (already done for Summary/Selection per PROMPT_3).

4. **Per‑figure model override (parity with follow‑ups).** Add a `<ModelOverridePill model={…} allowed={allowedModels} onChange={(slug) => setFigureModelOverride(slug)} />` directly to the right of the "Analyze This Figure" button **and** in the figure follow‑up input row (same pattern as `FollowUpInput` in `SelectionResultPanel.tsx`). Pass the override through `body: JSON.stringify({ figure_id, question, model: overrideOrFast })` to `/figure-qa-stream`. The route already calls `resolveStreamModelOverride(...)` (see `figure-qa-stream/route.ts` line 89) — verify that body field name is `model` (it is). Reset the override after each send.

5. **Pre‑run hint.** Before the user clicks "Analyze This Figure", render a compact "Model: <ModelPill>" caption above the button so users see which model *will* be used:
   ```tsx
   {chat.length === 0 && !loading && (
     <div className="flex flex-col gap-2">
       <div className="flex items-center gap-2 text-[var(--text-xs)] text-muted-foreground/85">
         <span>Model</span>
         <ModelOverridePill
           model={figureModelOverride ?? fastModel}
           allowed={allowedModels}
           onChange={setFigureModelOverride}
         />
       </div>
       <button onClick={() => handleAnalyze(selected, "", figureModelOverride ?? undefined)} className="btn-primary-glass …">
         Analyze This Figure
       </button>
     </div>
   )}
   ```
   `handleAnalyze` gains an optional third `model?: string` parameter — pipe it into the fetch body.

### Acceptance
- Selecting a figure shows the model pill *before* clicking Analyze.
- Clicking Analyze keeps the pill visible during streaming with `pending` styling, then "confirms" to the actual server model after `X-Know-Model` lands.
- Switching the override pill to Opus and clicking Analyze runs Opus (the response `X-Know-Model` header confirms it).
- `cached_analysis.figure_analyses[].model` reflects the model that actually ran (including overrides), since the route already stamps `model: fastModel` on the persisted entry.

---

## Bug 4 — Follow‑up model menu clips off the right edge

### Reported symptom
> "In follow up questions, I can see a menu exists to change the model. However it goes out of the page."

### Root cause
`frontend/src/components/analysis/OverflowMenu.tsx::updatePosition` always honors `align`. For `align="end"` it sets:
```ts
setMenuStyle({ top, left: rect.right, transform: "translateX(-100%)" });
```
For the follow‑up composer, the `ModelOverridePill` lives at the **left** edge of the input row (`FollowUpInput`, `SelectionResultPanel.tsx` ~L286). The menu (`w-56` = 224 px) ends up with effective `left = rect.right - 224`. If `rect.right < 224` (any narrow analysis pane), the menu hangs off the page.

The PROMPT_5 implementation also doesn't account for vertical clipping near the bottom of the viewport — opening the menu near the bottom of the screen pushes the menu off the bottom.

### Required fix

Make `OverflowMenu` viewport‑aware. Keep the current API.

1. **Measure the popup after layout**, then clamp to viewport. After the first paint, read `menuRef.current.getBoundingClientRect()` and adjust if either edge is offscreen. Use a `ResizeObserver` on the popup so width changes (e.g. content swaps) re‑clamp.

2. **Concrete algorithm** (in `updatePosition`):
   ```ts
   const PADDING = 8;
   const viewportW = window.innerWidth;
   const viewportH = window.innerHeight;
   const triggerRect = el.getBoundingClientRect();
   const menuW = menuRef.current?.offsetWidth ?? 224;
   const menuH = menuRef.current?.offsetHeight ?? 0;

   let left: number;
   if (align === "end") left = triggerRect.right - menuW;
   else if (align === "start") left = triggerRect.left;
   else left = triggerRect.left + triggerRect.width / 2 - menuW / 2;

   left = Math.max(PADDING, Math.min(left, viewportW - menuW - PADDING));

   let top = triggerRect.bottom + sideOffset;
   if (menuH > 0 && top + menuH > viewportH - PADDING) {
     // Flip above the trigger if there isn't room below.
     const flipTop = triggerRect.top - sideOffset - menuH;
     if (flipTop >= PADDING) top = flipTop;
     else top = Math.max(PADDING, viewportH - menuH - PADDING);
   }

   setMenuStyle({ top, left });
   ```
   Drop the `transform` (we apply real `left` now). Keep `position: fixed` via the existing className.

3. **Re‑measure on content size changes.** After the first effect that opens the menu, schedule a `requestAnimationFrame` re‑run of `updatePosition` so the post‑mount height is used (the first pass uses 0 because the popup hasn't laid out yet). Add a `ResizeObserver(menuRef.current)` that fires `updatePosition` on entries; tear down on close.

4. **Keep the trigger discoverable.** `ModelOverridePill` should always render visibly even when the menu is closed — verify that `flex` layout in `FollowUpInput` doesn't squish it. If the pane width is < 360 px, the pill should still be tappable (use `shrink-0`).

5. **Optional polish — anchor by side**. Add an `OverflowMenu` prop `side?: "top" | "bottom"` defaulting to `"bottom"`. The follow‑up input's pill is near the *bottom* of the panel, so passing `side="top"` would prefer to open upward. (The auto‑flip above handles this already; the prop is a cleaner explicit signal.) Optional — skip if it complicates the API.

6. **Tests.** Add a Vitest + Testing Library test for `OverflowMenu` that mounts in a 320 px wide container, opens it via `align="end"`, and asserts the computed `left` is ≥ 8 (the padding). If Vitest is not configured for this repo, skip the test but include a manual smoke note in the PR description: "open follow‑up menu in narrow right‑pane → menu stays on screen".

### Acceptance
- In a 300 px‑wide right‑pane, opening the follow‑up model pill renders the menu fully inside the viewport.
- Opening the same pill near the bottom of the viewport flips the menu above the trigger.
- The existing analysis‑pane sliders dropdown still opens correctly (regression check).

---

## Bug 6 — Derive button missing for matrix / Greek‑math selections

### Reported symptom
> "Sometimes equations are not recognized and I CANNOT SEE THE OPTION TO DERIVE IN SELECT. For example, in matrices."

The selection toolbar shows Explain / Derive / Save Note for math passages, Explain / Save Note for prose. The user is highlighting math content (matrices, Greek‑letter expressions) and the **Derive** chip never appears, so there is no path to ask for a step‑by‑step.

### Root cause

`frontend/src/lib/selectionMathHeuristic.ts::selectionLooksLikeEquationSnippet` is the single gate (`SelectionToolbar.tsx` line 104). Today it returns `true` only when one of these matches:

1. `\command` LaTeX commands (`\frac`, `\nabla`, …)
2. `^digit|{|(|[` or `_digit|{|(|[` (typeset super/subscripts)
3. A small Unicode math set: `[∑∫√∂∇∞±×·÷≤≥≠≈≡∼∈∧∨∀∃⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]`
4. ASCII operator (`+ - * / = ^ _`) **plus** a digit somewhere
5. `(...)` containing an ASCII operator

That misses a wide class of real‑world selections:

- **Bare Greek prose math** like `θ, φ, σ` or `Δ(x, y)` — Greek letters are not in set (3), no digit, and `,` is not an operator. PDF extraction routinely drops subscripts to the baseline so even `θ_1` shows up as `θ1` — still no operator. (Note: `(θ, 0, -θ)` from the user's Summary takeaway example *does* trigger via `-` + `0`, but slight variants like `(θ, φ, -ψ)` do not because there's no digit.)
- **Matrix selections** that PDF.js extracts as multi‑line text without brackets, e.g.
  ```
  a b c
  d e f
  g h i
  ```
  No operators, no digits, no Greek. The shape (multiple short lines of repeated single tokens) is the only signal.
- **Bracket‑delimited matrices** like `[ a₁ a₂ ; b₁ b₂ ]` — has digits, but the subscript Unicode characters (₁ ₂) are actually in set (3) — so this one *does* trigger. Bare‑letter versions (`[ a b ; c d ]`) do not.
- **Pipe‑delimited matrix rows** `|a b c|\n|d e f|` — pipes are not in operator set.
- **Common math relations** beyond the captured set: `≅`, `⊕`, `⊗`, `→`, `↦`, `⇒`, `∝`, `≜`, `⟨ ⟩`. None recognized.

The UX gap compounds the heuristic gap: when the heuristic returns `false`, Derive is **removed from the toolbar entirely** (filter in `SelectionToolbar.tsx` line 107). There is no manual override — even if the user *knows* they selected an equation, they cannot ask for a derivation. The user's report names exactly this scenario.

### Required fix

Two changes that work together: a stronger heuristic *and* an always‑accessible Derive fallback so the heuristic is no longer a hard gate.

#### 6a. Expand `selectionLooksLikeEquationSnippet`

Rewrite `frontend/src/lib/selectionMathHeuristic.ts` so it catches matrices, Greek prose math, bracket‑delimited tuples, and common relation symbols. Keep the existing positives — only add cases.

```ts
/**
 * Rough heuristic for whether a PDF text selection is likely math.
 * PDF extraction is lossy — match LaTeX fragments, math Unicode,
 * sub/sup markers, matrix‑shaped multi‑line text, bracketed tuples,
 * and operator+digit/Greek combinations.
 *
 * False positives are cheap (Derive still asks the model and degrades
 * gracefully on prose). False negatives are expensive (the user has
 * no way to ask for a step‑by‑step) — see Bug 6 in PROMPT_6.
 */
export function selectionLooksLikeEquationSnippet(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 2) return false;

  // 1. LaTeX commands or environments.
  if (/\\[a-zA-Z]+/.test(t)) return true;
  if (/\\begin\{(?:p|b|v|V|small)?matrix\}/i.test(t)) return true;

  // 2. Typeset super/subscripts.
  if (/\^(\d|\{|\(|\[)/.test(t) || /_(\d|\{|\(|\[)/.test(t)) return true;

  // 3. Math Unicode (operators, sets, super/subscripts, common relations).
  if (
    /[∑∫√∂∇∞±×·÷≤≥≠≈≡≅∝∼∈∉⊂⊆⊃⊇⊕⊗⊙∧∨∀∃⇒⇔→↦⟨⟩‖⊢⊨⊥∥∠∇⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/.test(t)
  )
    return true;

  // 4. Greek letters (a single one is a strong signal in a short selection,
  //    or any in a longer one). Match block 0370–03FF (Greek and Coptic).
  const greekCount = (t.match(/[\u0370-\u03FF]/g) || []).length;
  if (greekCount >= 1 && t.length < 40) return true;
  if (greekCount >= 2) return true;

  // 5. ASCII operators + digit OR + variable letter.
  const hasOp = /[+\-*/=^_<>]/.test(t);
  const hasDigit = /\d/.test(t);
  if (hasOp && hasDigit) return true;

  // 6. Parenthesised tuple with an operator or comma‑separated variables.
  if (/\(.*\)/.test(t) && (/[+\-*/=]/.test(t) || /\([a-zA-Z][\s,;]/.test(t)))
    return true;

  // 7. Bracket‑delimited matrix shapes:
  //    [a b c], [a b; c d], { a, b ; c, d }, |a b|
  if (/[\[\{|]\s*[A-Za-z\u0370-\u03FF\d]+(?:[,;\s]+[A-Za-z\u0370-\u03FF\d]+){1,}\s*[\]\}|]/.test(t))
    return true;
  if (/[\[\{|][^\]\}\n|]{0,40}(?:;|\\\\)\s*[^\]\}\n|]{0,40}[\]\}|]/.test(t))
    return true;

  // 8. Matrix‑shaped multi‑line dump: 2+ lines, each line ≤ 40 chars,
  //    each line mostly short tokens. Strong signal that the user
  //    grabbed a matrix whose brackets PDF.js dropped.
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2 && lines.length <= 8) {
    const matrixy = lines.every((l) => {
      if (l.length > 40) return false;
      const tokens = l.split(/[\s,;]+/).filter(Boolean);
      if (tokens.length < 2 || tokens.length > 8) return false;
      // Tokens should be short alphanumerics (≤ 6 chars) — typical
      // matrix entries. Allow a leading sign.
      return tokens.every((tok) => /^[\-+]?[A-Za-z\u0370-\u03FF\d_.]{1,6}$/.test(tok));
    });
    if (matrixy) return true;
  }

  // 9. Inline differential / derivative notation: "d/dx", "∂x", "df/dx", "dy/dx".
  if (/\b(?:d|D|∂)\s*[a-zA-Z]\s*\/\s*(?:d|D|∂)\s*[a-zA-Z]\b/.test(t)) return true;

  return false;
}
```

Notes:

- The Unicode set in (3) is expanded with more relation symbols and arrows. Keep `±×·÷` etc. (don't drop existing positives).
- The Greek block in (4) covers θ, σ, μ, λ, Δ, ∑ (literal capital sigma)… "1 in a short selection OR 2 anywhere" tunes precision/recall sensibly.
- The matrix‑shape rule in (8) is the heart of the fix: split on newlines, require ≥ 2 short rows of ≤ 8 short tokens, each token a plausible matrix entry. PDF.js text layer for matrices is exactly this shape after the bracket layer is rendered separately.
- (7) catches bracketed shapes that survive PDF extraction.

Do **not** lower the bar so far that prose like "I have 3 + 4 ideas" trips Derive — that already triggers via (5) and is acceptable.

#### 6b. Always‑accessible Derive via an overflow

The heuristic is now wider, but heuristics are heuristics. Add a manual override so the user can never be locked out of Derive.

1. In `frontend/src/components/pdf/SelectionToolbar.tsx`, keep the existing behavior where `showDerive` controls which actions render *prominently*. Drop the `if (a.id === "derive" && !showDerive) return false;` filter so Derive is always in `visibleActions` — but render it with a quieter affordance when `!showDerive` (smaller label, no icon stroke change). Concretely:
   ```tsx
   const visibleActions = actions.filter((a) => {
     if (a.id === "note") return canAccess(tier, "notes");
     if (a.id === "explain" || a.id === "derive") return canAccess(tier, "selection");
     return true;
   });
   ```
   Then mark Derive as `data-secondary={!showDerive ? "" : undefined}` and style it as muted (existing token: `text-muted-foreground/65` over `text-muted-foreground`). It is still tappable, still calls `onAction("derive", text)`, but visually says "we don't think this is math, but ask anyway if you want".

2. Update the tooltip text so users understand the affordance: when `!showDerive`, append "(also works on prose — step‑by‑step argument)" to the hint. The Derive prompt on the server already handles non‑math selections per `prompts/selection.ts` ("Step‑by‑step reconstruction of the math (or argument, for non‑technical papers)" — verify and don't change the prompt copy unnecessarily).

3. Do **not** add a separate "More" menu — three actions in one row is still fine. The point is to keep Derive visible always; muting is the only cue we change.

#### 6c. Tests for the heuristic

Add `frontend/src/lib/__tests__/selectionMathHeuristic.test.ts` with the following cases (if Vitest is wired up in the repo; if not, add the file anyway under a `.skip` so the next test‑runner sweep picks it up). Use plain assertions, no fixtures.

| Input | Expected |
|---|---|
| `"the sun is bright"` | `false` |
| `"E = mc^2"` | `true` (operator+digit) |
| `"\\sum_{i=0}^{n} a_i"` | `true` (LaTeX) |
| `"(θ, 0, -θ)"` | `true` (operator+digit) |
| `"(θ, φ, -ψ)"` | `true` (Greek + operator) |
| `"θ"` (alone) | `true` (single Greek in short text) |
| `"Δ(x, y)"` | `true` (Greek + parens) |
| `"a b c\nd e f\ng h i"` | `true` (matrix shape, 3 rows of 3) |
| `"a b c\nis a list"` | `false` (second row not matrix‑shaped) |
| `"[a b; c d]"` | `true` (bracket matrix) |
| `"[1, 2]"` | `true` (bracket tuple) |
| `"[apple, banana]"` | `false` (token > 6 chars; not matrixy) |
| `"d/dx"` | `true` (derivative) |
| `"x → y"` | `true` (Unicode arrow) |
| `"a ⊗ b"` | `true` (tensor product) |

### Acceptance

- Selecting a matrix block on a PDF page surfaces the **Derive** chip prominently.
- Selecting a Greek‑letter expression (e.g. `θ → φ`) surfaces Derive prominently.
- Selecting prose like "as we have seen" still hides Derive prominently, but the muted Derive chip is present in the toolbar and clicking it routes to `/selection-stream` with `action="derive"`.
- `npm run lint` and `npm run build` pass.
- `selectionMathHeuristic.test.ts` cases all pass (or are `.skip`d with the test list filed for follow‑up).
- No regression: the existing Explain / Save Note layout is unchanged.

---

## Bug 5 — Reduce model costs without sacrificing quality

### Question being answered
> "Is there a way to reduce model costs without reducing quality?"

### Levers I evaluated (background context for the implementer)

| Lever | Estimated cost saving | Quality risk | Implementation effort | Verdict |
|---|---|---|---|---|
| **Anthropic prompt caching** on system + paper‑context blocks | **40–80%** on input cost for repeated calls against the same paper | None — same model, same prompt | Low (per‑route `providerOptions.anthropic.cacheControl`) | **Do** |
| **Lower per‑route `maxOutputTokens` to realistic ceilings** | 10–25% on output cost | None as long as ceilings stay above observed p99 output | Low | **Do** |
| **Section‑aware paper excerpt** instead of `raw_text[:N]` for Python `analyze_paper` | 20–40% input cost on long papers + better quality (model sees abstract + intro + headings instead of running off the cliff at char N) | Slight — needs heading detection (already partially present in `markdown_text.py`) | Medium | **Do** |
| **Embedding‑based retrieval for selection / Q&A on long papers** | 30–60% input on >20k‑char papers | Possibly *higher* quality (focused context) but adds infra (vector store, embeddings call per upload) | High | Skip this PROMPT — track separately |
| **Anthropic Batch API** for Prepare / Assumptions / Summary | 50% (Batch discount) | High UX cost — batch returns are not real‑time (24 h SLA), kills perceived speed | Medium | Skip — UX regression |
| **Cheaper provider tier (Haiku) for selection** | 60–80% on selection cost | Quality dip on derivations / assumptions; user already controls this via Settings → fast vs analysis model | None — already implemented | Verify defaults |
| **De‑duplicate calls (cache hits, already done in PROMPT_5)** | Variable | None | Already done | Keep |

The big three to implement here are **prompt caching**, **output budget tightening**, and **section‑aware excerpting**. Together they typically cut steady‑state cost ~50% on Sonnet without touching the model or visible UX. Do not lower per‑call quality (the visible outputs the user sees stay identical or improve).

### Required fix

#### 5a. Enable Anthropic prompt caching on every migrated streaming route

The AI SDK Anthropic provider supports prompt caching via `providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } }` set on a message part. Anthropic charges 25% of base input cost for cache writes and 10% for cache reads; once the cache is warm (any repeat call within 5 min on the same paper) you pay ~10% of the input you paid before. For the typical "user lands on a paper and runs Summary → Selection → Q&A within minutes" flow, that's a massive saver because the system prompt **and** the paper context are reused.

**Where to mark blocks for caching**:

1. The **system prompt** is identical across every call to the same route. Mark it `ephemeral`.
2. The **paper context** is identical across every selection / summary / figure call for the same paper within a session. Mark it `ephemeral`.

The AI SDK exposes per‑message cache breakpoints. The pattern looks like this (`figure-qa-stream/route.ts`):
```ts
result = streamObject({
  model: getModelFromSlug(fastModel),
  schema: zodSchema(FigureAnalysisSchema),
  schemaName: "FigureAnalysis",
  system, // string is fine; for explicit cache, see option B below
  providerOptions: {
    anthropic: {
      // Mark the system prompt cacheable.
      cacheControl: { type: "ephemeral", ttl: "5m" },
    },
  },
  maxOutputTokens: maxOutputTokensFor(fastModel, "vision"),
  messages: [
    {
      role: "user",
      content: [
        { type: "image", image: figure.bytes, mediaType: figure.mediaType },
        // Cache breakpoint *after* the paper context so subsequent calls can reuse.
        {
          type: "text",
          text: paperContextBlock, // the long, stable part
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
        },
        { type: "text", text: questionBlock }, // the short, varying part — uncached
      ],
    },
  ],
  ...
});
```

**Refactor each prompt builder** in `frontend/src/lib/server/prompts/{selection,summary,figure}.ts` to return **`{ system, paperContextText, taskText }`** instead of a single concatenated `{ system, prompt }`. The route then composes the user message with the paper context marked cacheable and the task text uncached. Concretely for selection:
```ts
// prompts/selection.ts
return {
  system,
  paperContextText: `Paper title: ${title}\n\nPaper content (truncated):\n"""\n${paperContext}\n"""`,
  taskText: `Selected text:\n"""\n${selectedText}\n"""\n\nAction: ${action}.\n\nReturn the structured object …`,
};
```
Then in `selection-stream/route.ts`:
```ts
messages: [{
  role: "user",
  content: [
    {
      type: "text",
      text: paperContextText,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
    },
    { type: "text", text: taskText },
  ],
}],
providerOptions: {
  anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } }, // caches `system`
},
```

Do the same for `summary-stream` (paper context cacheable, task text uncached) and `figure-qa-stream` (paper context cacheable, image + question uncached — image already changes per figure so caching it is pointless; the AI SDK Anthropic provider won't cache image parts anyway).

**Important caveats**:
- Anthropic requires the cached block to be at least 1024 tokens (≈4096 chars) for Sonnet/Opus and 2048 for Haiku. Our `PAPER_CONTEXT_CHAR_BUDGET = 6000` and `PAPER_CHAR_BUDGET = 8000` are above this, so we're safe. The figure route uses `PAPER_CHAR_BUDGET = 4000` for paper context — bump it to 6000 to clear the threshold (this is `prompts/figure.ts`). Quality improves anyway.
- The cache is **per provider**, **per Anthropic account**, **per content hash**. Gateway proxying preserves this. Verify in Vercel logs after deploy that `Anthropic-Beta: prompt-caching-2024-07-31` (or the current version the SDK chooses) appears on outbound calls.
- Cache hits show up in the response as `usage.cache_read_input_tokens` vs `usage.cache_creation_input_tokens`. Log both in `onFinish` of each route under a `console.info("[stream] usage", …)` line so Vercel logs can verify caching is working.

#### 5b. Tighter `maxOutputTokens` budgets

`frontend/src/lib/server/llm.ts::maxOutputTokensFor` is over‑provisioned. Lower the ceilings to match observed p99 output sizes (output tokens cost ~5× input on Sonnet — the biggest single cost lever).

```ts
export function maxOutputTokensFor(slug: string, role: ModelRole): number {
  const isOpus = slug.includes("opus");
  const isSonnet = slug.includes("sonnet");
  if (role === "analysis") {
    // Summary / Prepare: ~3–4k tokens typical, 6k worst case.
    if (isOpus) return 8000;
    if (isSonnet) return 6000;
    return 4000;
  }
  if (role === "fast") {
    // Selection: ~1–2k typical, 3k worst case.
    if (isOpus) return 4000;
    if (isSonnet) return 3000;
    return 2000;
  }
  // Vision (figure): ~2k typical.
  if (isOpus) return 4000;
  if (isSonnet) return 3000;
  return 2000;
}
```

After this change, **monitor for truncation** — if any route starts producing partial JSON (e.g. unclosed brackets that the Zod schema rejects), bump that role's budget back up. The migrated routes use `streamObject` which is strict on the final assembly; truncation surfaces as a Zod validation error in `onFinish`. Surface those errors to the client as an `incomplete_result` `detail.code` (already wired up in `useSelectionThread` / `useSummaryStream`).

For the Python batch endpoints, do the symmetric change in `backend/app/services/llm.py`:
- `analyze_paper`: `max_tokens=8192` → `12000` (Bug 1 raised this — leave it at 12000 for safety on long bibliographies).
- `extract_assumptions`: leave at current value (8192 is fine — assumptions emit shorter JSON than Prepare).
- `analyze_selection`, `explain_term`, `find_skipped_steps`: lower to `3000`.
- `analyze_figure`: lower to `3000`.

#### 5c. Section‑aware paper excerpt for Python `analyze_paper`

`analyze_paper` currently does `paper_text = paper_text_full[:15000]`. On long papers this cuts off mid‑paragraph somewhere inside Methods, so the model never sees Results / Discussion. The Prepare prompt asks for *definitions, research questions, concepts* — fields whose ground truth is mostly in the abstract + intro + conclusions, not Methods.

1. **New module `backend/app/services/paper_excerpt.py`** with `build_prepare_excerpt(raw_text: str, *, max_chars: int = 15000) -> str`. Algorithm:
   - Use a simple heading regex (`re.compile(r"^\s*(?:\d+(?:\.\d+)*\s+)?(abstract|introduction|background|related work|method[s]?|approach|model|theor(?:y|etical)|experiment[s]?|result[s]?|evaluation|discussion|conclusion[s]?|future work|limitations)\b", re.I | re.MULTILINE)`) to locate section starts.
   - Slice each section. Take: full Abstract, full Introduction, first 2 paragraphs of each middle section, full Conclusions / Future Work.
   - If detected sections together exceed `max_chars`, prefer Abstract → Introduction → Conclusion → middle sections in that order. Drop middle sections from the bottom up until under budget.
   - If no sections detected (some pre‑prints, posters, papers with weird formatting), fall back to `raw_text[:max_chars]`.
   - Always include the first ~1000 chars unconditionally (almost always contains title + abstract).

2. Replace the `paper_text = paper_text_full[:15000]` line in `analyze_paper` with `paper_text = build_prepare_excerpt(paper_text_full, max_chars=15000)`. Keep the existing `bib_excerpt` path — `extract_references_section` already operates on the full text.

3. Add tests in `backend/tests/test_paper_excerpt.py`:
   - Document with clear section headings → excerpt contains "Abstract", "Introduction", and "Conclusion" anchors.
   - Document with no headings → excerpt equals `raw_text[:max_chars]`.
   - 200k‑char document with very long Methods → Methods is truncated, Conclusion is present.

4. Do **not** apply this to `analyze_selection` / `explain_term` / streaming routes — those have a different "show the model the local context" requirement and benefit from contiguous text. Only Prepare and (potentially in the future) Summary get section‑aware excerpting.

#### 5d. Backend prompt caching for the Python provider

`backend/app/services/llm.py::AnthropicProvider.complete` should also enable prompt caching. The Anthropic REST API supports `cache_control` on message blocks (HTTP `anthropic-beta: prompt-caching-2024-07-31` header). Concretely:

1. In `AnthropicProvider.complete`, change the request body to send the system prompt as a list of blocks rather than a string:
   ```python
   payload = {
     "model": self.model,
     "max_tokens": max_tokens,
     "system": [
       {
         "type": "text",
         "text": system,
         "cache_control": {"type": "ephemeral"},
       }
     ],
     "messages": [
       {
         "role": "user",
         "content": [
           # The long paper context block — cache breakpoint here.
           # Caller can opt in by passing `cache_context=True`; otherwise skip.
           {"type": "text", "text": user},
         ],
       }
     ],
   }
   headers = {
     "x-api-key": settings.anthropic_api_key,
     "anthropic-version": ANTHROPIC_VERSION,
     "anthropic-beta": "prompt-caching-2024-07-31",
     "content-type": "application/json",
   }
   ```
2. Extend `complete()` to accept an optional `cache_user_prefix: str | None = None`. When set, the first content block carries `cache_control: { type: "ephemeral" }`. Callers that have a long, stable paper context (e.g. `analyze_paper`, `extract_assumptions`) split the prompt into `(prefix, suffix)` and call `complete(system, suffix, max_tokens=..., cache_user_prefix=prefix)`.
3. Log cache hit / miss from the response body: `usage.cache_read_input_tokens` vs `usage.cache_creation_input_tokens`. Emit a single `logger.info("anthropic_usage paper=%s cache_read=%s cache_creation=%s input=%s output=%s")` per call.
4. **Do not break the public `complete()` signature** for existing callers — `cache_user_prefix` is optional and defaults to `None`.
5. Add a small unit test that monkeypatches `httpx.AsyncClient.post` and asserts the body has `system: [{type: "text", text: "...", cache_control: {...}}]` and the right beta header.

### Acceptance (cost track)

1. **Verify caching is on:** Vercel function logs for each migrated route should print `usage.cache_read_input_tokens > 0` on the *second* selection call against the same paper within 5 min.
2. **Verify budgets:** No new `incomplete_result` errors in the FE error console for the migrated routes over a smoke test of ~10 papers (selection, summary, figure each).
3. **Verify section excerpting:** Run `pytest backend/tests/test_paper_excerpt.py`. Spot‑check `/analyze` output on a paper > 30k chars — the JSON should include `definitions` and `concepts` from sections beyond char 15000 (e.g. terms defined in Methods).
4. **Cost dashboard:** No code surface for this; rely on Vercel AI Gateway dashboard + Anthropic console.

### Out of scope (track for a future PROMPT)
- Embedding / vector store for selection retrieval on huge papers.
- Caching figure analyses across sessions in Anthropic prompt cache (image parts can't be cached).
- Auto‑routing easy queries to Haiku based on selected‑text length.

---

## Final QA checklist

- [ ] `npm run lint` passes (frontend) and there are no new TS warnings.
- [ ] `npm run build` passes (frontend).
- [ ] `pytest backend/tests -q` passes, including new tests for `analyze_paper` and `paper_excerpt`.
- [ ] In a clean session: open a long PDF with bibliography → Prepare tab populates without a Retry click. Reopen the paper from dashboard → Prepare is already populated (no flicker, no second call).
- [ ] Summary "Key takeaway" with `$(\theta, 0, -\theta)$` renders the math.
- [ ] Selecting a figure shows the model pill **before** clicking Analyze. Switching to Opus via the override pill runs Opus.
- [ ] Opening the follow‑up model menu in a narrow right pane keeps the menu fully on screen. Opening near the bottom flips the menu upward.
- [ ] Highlighting a matrix or Greek‑math expression in the PDF surfaces the **Derive** chip prominently. Highlighting prose still shows the muted Derive chip and clicking it routes to a derivation card.
- [ ] Vercel logs show `cache_read_input_tokens > 0` for the second selection / summary call on the same paper within 5 minutes.
- [ ] No regressions in PROMPT_3/4/5 features (model lag, background prefs on account, assumptions auto‑extract, bibliography splitter, analysis‑pane sliders dropdown, assumptions not re‑extracting on dashboard return).

---

## Notes for the implementer

- The six tracks are independent — feel free to ship them as one commit if all six lint + build cleanly, or split into 2–3 commits (UX bugs first, then cost track). Don't introduce a feature flag; the cost work is invisible to users.
- Anthropic prompt caching is the single biggest win in this prompt. Even if you have to skip 5b or 5c due to time, ship 5a. Verify cache reads land in logs before claiming success.
- Stay inside the rules — no `motion.div`, no new colors, no `preprocessLatex` revival for migrated paths.
