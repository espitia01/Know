# Know — bug‑fix briefing #4 for Composer 2.5

> **Scope**: five follow‑up bugs that surfaced after `docs/COMPOSER_FIX_PROMPT_3.md` shipped. Two are regressions I introduced, two are pre‑existing rough edges users called out, one is a cleanup pass for an unshipped feature. Stay inside `.cursor/rules/*.mdc` (analysis‑pane, architecture, latex). **Read those rules first.** Reuse existing primitives — no new color / shadow / motion tokens.
>
> **Stack reminders** (same as PROMPT_3): Next.js 16 + AI SDK v6 + Zod 4. Math always flows through Streamdown / KaTeX with `$...$` / `$$...$$` delimiters; the legacy `Md` chain is only for the Notes path. Visual language stays put.
>
> **Test plan**: `npm run lint` + `npm run build` after each bug, smoke each surface in the IDE preview.
>
> **Order**: 5 → 4 → 3 → 1 → 2 (cleanup first because it removes code other bugs touch; memory work last).

---

## Snapshot of the offending surfaces

| Concern | Files |
|---|---|
| Key equations not rendering as math | `frontend/src/components/sidebar/SummaryPanel.tsx`, `frontend/src/lib/server/prompts/summary.ts`, `frontend/src/lib/server/schemas.ts`, `frontend/src/components/analysis/StreamingMarkdown.tsx` |
| Key takeaway truncated mid‑sentence | `frontend/src/components/sidebar/SummaryPanel.tsx` |
| Region highlights missing on scanned PDFs | `frontend/src/components/pdf/PdfViewer.tsx`, `frontend/src/lib/store.ts`, `frontend/src/app/globals.css` |
| Page becomes unresponsive after extended use | `frontend/src/lib/store.ts`, `frontend/src/components/pdf/PdfViewer.tsx`, `frontend/src/lib/useSummaryStream.ts`, `frontend/src/components/sidebar/SummaryPanel.tsx`, `frontend/src/lib/api.ts` |
| Cross‑paper / workspace cleanup (feature is disabled) | `frontend/src/components/sidebar/QAPanel.tsx`, `frontend/src/components/sidebar/CrossPaperPanel.tsx`, `frontend/src/lib/workspaceFeatureFlags.ts`, `frontend/src/app/paper/[id]/page.tsx`, `frontend/src/lib/store.ts` |

If a fix touches a surface I refactored in PROMPT_3, **do not revert** the architectural decisions (overflow menu trigger contract, region effect split, etc.). Restore the missing behavior on top.

---

## Bug 1 — Key equations show as raw LaTeX, not rendered math

### Reported symptom
The Summary "Key equations" card displays the source string verbatim, e.g.

```
(x+y)^n - (x-y)^n = 2\binom{n}{1}x^{n-1}y + 2\binom{n}{3}x^{n-3}y^3 + \cdots + 2\alpha
```

No KaTeX glyphs, no centered formula card — just text.

### Root cause
Three layers conspired:

1. **Schema description** says `Wrap in $$...$$ for display math` (`frontend/src/lib/server/schemas.ts` L92), but the prompt body in `frontend/src/lib/server/prompts/summary.ts` says `"equation": LaTeX (display math)`. The model reads the prompt first; many runs drop the `$$...$$` delimiters and emit bare LaTeX (`\binom{n}{1}x^{n-1}y`).
2. **Renderer** is `<StreamingMarkdown>{eq.equation ?? ""}</StreamingMarkdown>` (`SummaryPanel.tsx` L195). Streamdown only invokes KaTeX when it sees `$...$` / `$$...$$`. A bare TeX string is rendered as literal markdown text.
3. **No client‑side guard.** The renderer trusts the prompt to produce delimited math.

### Required fix
Defense in depth — fix the prompt, the schema description, **and** wrap at render time so older cached entries keep rendering.

1. **Prompt change.** In `frontend/src/lib/server/prompts/summary.ts`, replace the `"key_equations"` bullet with:
   ```
   - "key_equations": array of {"equation": LaTeX wrapped in $$...$$ on its own line (display math, no surrounding prose), "meaning": one-paragraph markdown}. Pick the 3–6 most important equations of the paper. NEVER emit bare LaTeX — always wrap the equation field in $$...$$.
   ```
   The double instruction (wrap + never bare) is intentional — Anthropic models are noticeably better at obeying repeated constraints.
2. **Schema description.** Sharpen `frontend/src/lib/server/schemas.ts` L89–L92:
   ```ts
   equation: z.string().describe(
     "Display-math LaTeX for one of the paper's most important equations. MUST be wrapped in $$...$$ delimiters. Example: \"$$E = mc^2$$\". Never emit bare LaTeX commands.",
   ),
   ```
3. **Render‑time guard.** In `SummaryPanel.tsx` where the equation row renders, normalize the string before handing it to `StreamingMarkdown` so legacy cached entries (and any future model regression) still render. Add a small helper at module scope:
   ```ts
   function ensureDisplayMath(raw: string | undefined): string {
     const s = (raw ?? "").trim();
     if (!s) return "";
     // Already wrapped (any form): leave alone.
     if (/^\${1,2}[\s\S]+\${1,2}$/.test(s) || s.startsWith("$$")) return s;
     // Strip a leading enumerator like "(1)" / "1." / "Eq. 2:" that the
     // model sometimes prepends — preprocessLatex used to do this for the
     // legacy path; we keep the cleanup tiny and explicit.
     const cleaned = s.replace(/^\s*(?:\(\s*\d+\s*\)|\d+\.|Eq\.?\s*\d+:?)\s*/i, "").trim();
     return `$$${cleaned}$$`;
   }
   ```
   Then:
   ```tsx
   <StreamingMarkdown>{ensureDisplayMath(eq.equation)}</StreamingMarkdown>
   ```
   Do **not** import `preprocessLatex` — `.cursor/rules/latex.mdc` forbids it for migrated paths.
4. **Sanity check on the prompt builder.** The prompt depth suffix (`deep` / `standard` / `concise` added in PROMPT_3) is appended after the bullet list. Keep that order — don't insert the new bullet wording past `depthBlock`.

### Acceptance criteria
- For a paper whose summary already exists in cache with bare LaTeX, the Key equations card re‑renders correctly without re‑running the LLM (because of the client wrap).
- For a fresh summary, the model emits `$$...$$`‑delimited strings (verify by tailing `summary-stream.finish` logs and inspecting `cached_analysis.summary.key_equations[].equation` in Supabase).
- The "centered inset card" treatment kicks in (`span.katex-display.know-eq-card` styling in `globals.css` L714) for equations containing a relational sign.
- Equation row meaning text continues to render through `StreamingMarkdown` unchanged.

---

## Bug 2 — "Key takeaway" cuts off mid‑sentence with "…"

### Reported symptom
The Key takeaway card shows a fragment like:
> "We propose a regularizer that …"

…always trailing `…`, never ending at a sentence boundary.

### Root cause
`SummaryPanel.tsx` L102–L106:
```ts
const takeawaySource = (s as PaperSummary & { tl_dr?: string }).tl_dr ?? s.overview;
const takeaway =
  takeawaySource && takeawaySource.length > 180
    ? `${takeawaySource.slice(0, 180).trim()}…`
    : takeawaySource;
```

`slice(0, 180)` cuts at a byte boundary, not a sentence boundary, so users always see a partial sentence. The takeaway is supposed to be a tight one‑liner — truncation should only kick in when the source is genuinely long, and even then should land on punctuation.

### Required fix
Replace the slice with a sentence‑aware extractor. The goal: prefer the first sentence; if that's already short enough, use it whole; if the first sentence is itself too long, fall back to a length cap that ends on a word boundary, no ellipsis.

1. **Add a helper.** In `frontend/src/lib/time.ts` (the same lib utility module added in PROMPT_3) — or in a new file `frontend/src/lib/text.ts` if you prefer to keep `time.ts` time‑only — add:
   ```ts
   /** First-sentence takeaway extractor. Sentence-aware, no mid-word cuts. */
   export function firstSentence(input: string | null | undefined, maxLen = 240): string {
     const s = (input ?? "").trim();
     if (!s) return "";
     // Look for a strong sentence terminator followed by a space and an
     // uppercase letter (or end-of-string). This avoids breaking on "Fig.",
     // "e.g.", "Dr.", "i.e.", etc.
     const m = s.match(/[^.?!]+[.?!](?=\s+[A-Z(]|\s*$)/);
     const first = (m ? m[0] : s).trim();
     if (first.length <= maxLen) return first;
     // Sentence is itself very long — soft-cap at the last whole word
     // before maxLen, no ellipsis (the card already implies "summary").
     const cut = first.slice(0, maxLen);
     const lastSpace = cut.lastIndexOf(" ");
     return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trim();
   }
   ```
   The 60‑char floor guards against single‑word edge cases.
2. **Wire it up.** Replace the takeaway computation in `SummaryPanel.tsx`:
   ```ts
   const takeawaySource =
     (s as PaperSummary & { tl_dr?: string }).tl_dr ?? s.overview ?? "";
   const takeaway = firstSentence(takeawaySource, 240);
   ```
   `240` lets a typical "We propose X that improves Y by Z%." land whole — the previous 180 floor was too tight even for normal sentences.
3. **Streaming behavior.** While `stillStreaming` is true and the overview hasn't filled in, the takeaway will be empty (no first sentence yet). That's fine — the card already short‑circuits on `!takeaway`. **Do not** show a partial mid‑stream takeaway with `…`; it makes the loading state feel broken.

### Acceptance criteria
- For papers whose `overview` starts with a short sentence (≤240 chars), the takeaway is the whole first sentence with the terminal `.` / `?` / `!`, no ellipsis.
- For papers whose first sentence is >240 chars, the takeaway clips at a word boundary, also no ellipsis.
- Streaming‑in summaries: the card hides until the first sentence is complete.
- Lint + build pass.

---

## Bug 3 — Region highlights still don't show on scanned PDFs

### Reported symptom
On a scanned (text‑layer‑empty) PDF, marquee selecting a region creates the figure in the Figures tab but the orange highlight box that should mark the selected region on the PDF page is **missing**. On reload it stays missing.

### Root cause
Three interacting issues:

1. **PROMPT_3 Bug 6 regression.** I removed `drawRegionHighlightsForPage(...)` from the MutationObserver's `drainPending` and moved it to its own `useEffect`. That effect runs once when `pdfRegionHighlights` changes but only walks already‑mounted pages. For virtualized pages that mount **later** (scrollback), nothing re‑paints the overlay. On a scanned PDF the text‑layer mutation event never fires (empty text layer), so the page rendering path doesn't run `handleTextLayerRendered` either — `handlePageRender` (canvas success) is the only redraw trigger, and it does call `drawRegionHighlightsForPage`. So the first render works; subsequent virtualized re‑mounts only redraw if `handlePageRender` fires again. In practice on scanned PDFs, react‑pdf calls `onRenderSuccess` only once per page lifetime.
2. **Not persisted.** `pdfRegionHighlightsByPaper` lives in zustand without `persist` (and isn't echoed to the backend). Reload → highlights gone.
3. **Tint too subtle on canvas.** `--highlight-rgb: 251 146 60` at `0.18` alpha is barely visible against the off‑white scanned page. The legacy underline path used `0.45` for the equivalent emphasis.

### Required fix

#### 3a. Repaint on every page mount + scale change
1. In `frontend/src/components/pdf/PdfViewer.tsx`, the per‑page MutationObserver effect (`useEffect` that arms `pageObservers`) used to draw both underlines and region highlights inside `drainPending`. **Add back the region draw**, but keep the highlight reference shallow so it doesn't re‑arm observers:
   ```ts
   const drainPending = () => {
     raf = null;
     const items = Array.from(pending);
     pending = new Set();
     const regions = useStore.getState().pdfRegionHighlightsByPaper[paperId ?? ""] ?? EMPTY_REGIONS;
     for (const el of items) {
       drawUnderlinesForPage(el, selectionHistory);
       const pageNum = parseInt(el.getAttribute("data-page-number") || "0", 10);
       if (pageNum > 0) drawRegionHighlightsForPage(el, pageNum, regions);
     }
   };
   ```
   Reading from `useStore.getState()` instead of capturing the `pdfRegionHighlights` selector means the observer effect's dep array stays `[selectionHistory, drawUnderlinesForPage, scale, paperId]` — **no React 185 regression**. The dedicated region‑highlights effect I added in PROMPT_3 stays put for the case where regions change without a DOM mutation.
2. **Scale‑aware coordinates.** Today `addPdfRegionHighlight` stores `{x, y, w, h}` in pixels at the current scale. If the user zooms, the overlay drifts. Store as fractions of the page dimensions instead:
   ```ts
   export type PdfRegionHighlight = {
     id: string;
     pageNum: number;
     // Normalized [0,1] page-local box so zoom doesn't move the overlay.
     xPct: number;
     yPct: number;
     wPct: number;
     hPct: number;
   };
   ```
   Convert at marquee‑capture time (divide by `pageEl.offsetWidth` / `offsetHeight`) and convert back inside `drawRegionHighlightsForPage` (multiply). Keep a one‑version migration: when reading `pdfRegionHighlightsByPaper` from persisted storage, if `xPct` is missing but `x` is present, drop the entry (don't try to upgrade — there's no reliable way to recover the original page size).

#### 3b. Persist + restore region highlights
1. Add `pdfRegionHighlightsByPaper` to the zustand `partialize` allowlist in `frontend/src/lib/store.ts`. It's small (≤ a few hundred bytes per highlight) and user‑specific.
2. **Do not** push these to the backend in this PR — the existing selection underlines already round‑trip via `selectionHistory`; region highlights live in browser state only. Add a TODO comment noting the eventual backend sync path (`cached_analysis.region_highlights`).

#### 3c. Make the overlay actually visible on scanned pages
Update `frontend/src/app/globals.css` L585–L592:

```css
.know-region-highlight {
  position: absolute;
  --highlight-rgb: 251 146 60;
  border: 1.5px solid rgb(var(--highlight-rgb) / 0.8);
  background: rgb(var(--highlight-rgb) / 0.28);
  border-radius: 3px;
  pointer-events: none;
  /* Scanned pages tend to render warm-white; a faint amber rim is too easily lost. */
  box-shadow: 0 0 0 1px rgb(var(--highlight-rgb) / 0.18);
}
.dark .know-region-highlight {
  background: rgb(var(--highlight-rgb) / 0.22);
}
```

No new tokens — `--highlight-rgb` already exists. The `box-shadow` is the existing rim‑halo pattern used by `.know-selection-underline`.

### Acceptance criteria
- Marquee‑select on a scanned PDF immediately paints an orange box on the captured region.
- Scrolling that page out of view and back leaves the box in place (virtualized remount path works).
- Page reload restores the box.
- Zooming the PDF keeps the box aligned with the original region (not drifting).
- React DevTools "Profiler → highlight updates" shows no unbounded re‑renders on the `PdfViewer` subtree.
- `npm run lint` + `npm run build` pass.

---

## Bug 4 — Page becomes unresponsive after extended use

### Reported symptom
After a long reading session (multiple papers opened, many selections / Q&A / summaries) the reader UI starts dropping frames; eventually the tab needs a refresh. Most likely a memory + listener accumulation problem.

### Suspect surfaces (in order of likelihood)

1. **`selectionHistory` underline redraws are O(history × textNodes) per change.** Every store update to `selectionHistory` re‑fires the MutationObserver effect's deps (re‑arms observers across every page). The observer effect captures `selectionHistory` directly — large histories rebuild the page text walker on every render.
2. **`papersById` grows unbounded.** Each visited paper stays in memory with its full `raw_text` + `cached_analysis` blob (selections, Q&A, summary, figure analyses). Across a multi‑hour session this can climb tens of MB and the `useStore` selector subscribers re‑evaluate on every set.
3. **`summaryStreamingByPaper` keeps every paper's last streaming partial** even after completion. The cleanup path runs only when the user returns to that paper.
4. **`selectionHistory.slice(0, 50)` cap exists but `qaResults.slice(-200)` is too generous** — Q&A blobs can each be several KB.
5. **`crossPaperResults: …slice(0, 200)`** persists 200 cross‑paper entries to localStorage which compounds on reload (we read them back into memory + zustand snapshots).
6. **MutationObservers + ResizeObservers** detach correctly today; verify with `getEventListeners(document)` in DevTools that the count is stable after navigating between papers.

### Required fix

#### 4a. Cap and trim hot collections
1. `selectionHistory`: tighten cap from 50 → **30** (50 underlines on a single paper already looks busy). In `frontend/src/lib/store.ts`:
   ```ts
   selectionHistory: [r, ...s.selectionHistory].slice(0, 30),
   ```
2. `qaResults`: tighten 200 → **60** per paper. Long sessions don't need 200‑deep Q&A scrollback.
3. `crossPaperResults`: tighten 200 → **80**.
4. Drop `summaryStreamingByPaper` entry on `onFinish` for the *paper that just finished* even if it isn't active. In `useSummaryStream.ts` the `finishSummary` already does `clearSummaryStreamingPartial` when the active paper matches; extend the call to fire unconditionally on `onFinish`/`onError`:
   ```ts
   useStore.getState().clearSummaryStreamingPartial(pid);
   ```
   (Outside the `paper?.id === pid` guard.)

#### 4b. LRU‑bound `papersById`
1. Add a small LRU cap to the in‑memory `papersById` map. 8 entries is plenty for a casual session and far below the unbounded growth that's hurting us today. In the `cachePaper` / `addOrUpdatePaper` action:
   ```ts
   set((s) => {
     const next = { ...s.papersById, [p.id]: p };
     const keys = Object.keys(next);
     if (keys.length > 8) {
       // Drop the entry the user hasn't visited most recently. We don't
       // track timestamps explicitly, so use insertion order as a proxy:
       // delete the first key that isn't the active paper.
       const activeId = s.paper?.id;
       const evict = keys.find((k) => k !== activeId && k !== p.id);
       if (evict) delete next[evict];
     }
     return { papersById: next };
   });
   ```
   Add a one‑line code comment justifying the limit.
2. **Do not** evict from `sessionPapers` (the tab strip) — those are intentionally sticky.

#### 4c. Read store snapshots, not selector‑captured values, inside DOM observers
The MutationObserver effect (`useEffect` around `PdfViewer.tsx` L1270) captures `selectionHistory` in deps. Every history update tears down + rebuilds every per‑page observer. Switch to a stable observer scope:

1. Remove `selectionHistory` from the observer effect's deps.
2. Inside `drainPending`, read history from store fresh:
   ```ts
   const history = useStore.getState().selectionHistory;
   for (const el of items) drawUnderlinesForPage(el, history);
   ```
3. Add a **separate**, lightweight `useEffect` whose dep is `[selectionHistory.length, paperId]` (length, not the array) that schedules a one‑shot redraw of every mounted page:
   ```ts
   useEffect(() => {
     const container = containerRef.current;
     if (!container) return;
     container.querySelectorAll<HTMLElement>(".react-pdf__Page[data-page-number]").forEach((el) => {
       drawUnderlinesForPage(el, useStore.getState().selectionHistory);
       const pageNum = parseInt(el.getAttribute("data-page-number") || "0", 10);
       if (pageNum > 0) {
         drawRegionHighlightsForPage(el, pageNum, useStore.getState().pdfRegionHighlightsByPaper[paperId ?? ""] ?? []);
       }
     });
   }, [selectionHistory.length, drawUnderlinesForPage, drawRegionHighlightsForPage, paperId]);
   ```
   `.length` is a cheap stable dep — adds/removes still re‑paint; in‑place mutations don't.

#### 4d. Watch for ResizeObserver storm
The container `ResizeObserver` calls `scheduleAll()` on every size change. When the analysis pane resizes (e.g. follow‑up streams in and grows the right column), this fires repeatedly. Wrap the callback in a debounce:

```ts
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
const resizeRo = new ResizeObserver(() => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => scheduleAll(), 90);
});
```

(90 ms is enough to coalesce a resize burst without feeling laggy.)

### Acceptance criteria
- After opening 5 papers, generating summaries / Q&A / 20 selections each, the DevTools heap snapshot stays below ~80 MB (today it grows past 200 MB in the same flow).
- Chrome Performance recorder shows main‑thread work per scroll frame back under 8 ms even after extended use.
- `getEventListeners(document)` count is stable across paper switches (no monotonic increase).
- Switching papers stays under 250 ms after eviction kicks in.
- `npm run lint` + `npm run build` pass.

---

## Bug 5 — Hide cross‑paper / workspace surfaces (feature isn't shipped)

### Reported request
> "We do not have workspace and thus no cross‑paper questions right now."

Workspaces and multi‑paper sessions are already gated by `WORKSPACE_FEATURES_TEMPORARILY_DISABLED = true` (in `frontend/src/lib/workspaceFeatureFlags.ts`). The navbar shows a "Coming Soon" pill for Add Paper / Workspace and never grows `sessionPapers` past one. **But the Q&A panel still ships UI that assumes multi‑paper sessions exist**, plus the `CrossPaperPanel` component is still importable. We need to make the gating uniform so the reader never *hints* at cross‑paper functionality.

### Where to look
- `frontend/src/components/sidebar/QAPanel.tsx`
  - `const [crossPaper, setCrossPaper] = useState(false);` (L49)
  - `const canMultiQA = canAccess(tier, "multi-qa");` (L88)
  - `const hasMultiplePapers = sessionPapers.length > 1 && canMultiQA;` (L89) — today always false in production because `sessionPapers.length` is capped at 1 by the flag, **but** the code path still exists, the cross‑paper prompt seeds load on the client, and the toggle / placeholder strings are dead weight.
  - Cross‑paper toggle block (L208–L234)
  - "Cross‑paper session" caption (L410–L412)
  - `placeholder={crossPaper && hasMultiplePapers ? "Ask across all papers..." : ...}` (L318)
  - `crossPaper ? CROSS_PAPER_PROMPTS : ...` (L168–L170)
  - `if (crossPaper && hasMultiplePapers) result = await api.askQuestionsMulti(...)` (L141)
- `frontend/src/components/sidebar/CrossPaperPanel.tsx` — standalone component (`export function CrossPaperPanel`). Not imported by the analysis pane today after PROMPT_2 polish, but it still exists and tempts future re‑wiring.
- `frontend/src/lib/workspaceFeatureFlags.ts` — single source of truth for the gate.
- `frontend/src/app/paper/[id]/page.tsx` — already handles `workspaceFeaturesComingSoon` for navbar Add Paper / Workspace pills.
- `frontend/src/lib/store.ts` — `crossPaperResults` slice + `partialize` entry (L420–L423, L647).

### Required fix
The goal is "behaves as if the feature does not exist" while keeping the flag so we can flip it back when workspaces ship. **Do not delete the workspace code paths** — gate them behind the same flag and remove dead UI in the meantime.

1. **Single import.** In `QAPanel.tsx`, add:
   ```ts
   import { WORKSPACE_FEATURES_TEMPORARILY_DISABLED } from "@/lib/workspaceFeatureFlags";
   ```
2. **Derive `hasMultiplePapers` from the flag too.** Replace L88–L89 with:
   ```ts
   const canMultiQA =
     !WORKSPACE_FEATURES_TEMPORARILY_DISABLED && canAccess(tier, "multi-qa");
   const hasMultiplePapers = sessionPapers.length > 1 && canMultiQA;
   ```
   This is the single line that makes every dependent branch dead under the current flag.
3. **Drop dead local state.** Once `hasMultiplePapers` can never be true, the toggle block (L208–L234) and the `crossPaper` switch are unreachable. Either:
   - **Preferred**: keep the `const [crossPaper, setCrossPaper] = useState(false);` because the same component is shared with future work — but wrap the toggle JSX in `{hasMultiplePapers && (...)}` (it already is) and remove the now‑useless conditionals in `placeholder`, the "Cross‑paper session" caption, and the prompt seed selector by collapsing them to the single‑paper branch:
     ```tsx
     placeholder="Type a question..."
     // remove the {crossPaper && hasMultiplePapers && (...)} caption
     const prompts = [...SEED_PROMPTS, ...extraPrompts];
     ```
     And in `handleAnswerAll`:
     ```ts
     const result = await api.askQuestions(activePaperId, toAnswer);
     // delete the api.askQuestionsMulti branch
     ```
   - Leave a `// TODO(workspaces): restore cross-paper toggle when WORKSPACE_FEATURES_TEMPORARILY_DISABLED flips` comment so the next maintainer knows why those branches are simplified.
4. **Remove the `CROSS_PAPER_PROMPTS` import + array** from `QAPanel.tsx` if it isn't referenced anywhere else (verify with a grep). Same for any `askQuestionsMulti` import.
5. **Mark `CrossPaperPanel.tsx` deprecated.** Add a one‑line header comment to `frontend/src/components/sidebar/CrossPaperPanel.tsx`:
   ```ts
   /**
    * @deprecated Cross-paper Q&A is gated behind WORKSPACE_FEATURES_TEMPORARILY_DISABLED.
    * Do not mount this component in product surfaces. Restore when workspaces ship.
    */
   ```
   And add an `eslint-disable-next-line @typescript-eslint/no-unused-vars`/`no-unused-imports` if needed so the file stays buildable. Don't delete it — it's a working reference for the future feature.
6. **Stop persisting `crossPaperResults`.** In `frontend/src/lib/store.ts`, remove `crossPaperResults: state.crossPaperResults` from `partialize` (L647). The slice itself stays (so future re‑enable is one flag flip), but it doesn't need to round‑trip through localStorage today — it's effectively dead state that wastes quota on every save.
7. **Library + reader navbar.** No further work needed: both already check `WORKSPACE_FEATURES_TEMPORARILY_DISABLED` and render `ComingSoonNavControl`. Verify by visually scanning `frontend/src/app/library/page.tsx` and `frontend/src/app/paper/[id]/page.tsx` — do not duplicate the gate.

### Don't do
- Don't delete the `WORKSPACE_FEATURES_TEMPORARILY_DISABLED` flag or the workspace API functions in `api.ts`. The product roadmap explicitly keeps workspaces — this is hide, not amputate.
- Don't delete `CrossPaperPanel.tsx`. Keep it for the future re‑enable.
- Don't change the `multi-qa` feature in `frontend/src/lib/UserTierContext.tsx` / `auth.ts`. Tier gating is orthogonal to product‑level flags.

### Acceptance criteria
- Q&A panel never shows the cross‑paper toggle, the "Ask across all papers..." placeholder, the cross‑paper prompt seeds, or the "Cross‑paper session" footer caption.
- `api.askQuestionsMulti` is not called from any UI path while the flag is true.
- `localStorage.know-paper-store` does not contain a `crossPaperResults` key after this PR (verify with DevTools after a hard reload).
- Navbar Add Paper / Workspace buttons still show "Coming Soon" as today.
- Flipping `WORKSPACE_FEATURES_TEMPORARILY_DISABLED` back to `false` in a sandbox restores the cross‑paper UI without code edits — the gate is the only change.
- Lint + build pass.

---

## Don't‑touch list

- Notes path (legacy `Md` + `preprocessLatex`). Out of scope.
- Python backend. All four bugs are frontend‑only.
- `internalApi.ts`, `gating.py`. No tier / model changes.
- The OverflowMenu trigger refactor from PROMPT_3. Keep the new `triggerInner` + `buttonProps` API.
- The model badge / output token budget plumbing from PROMPT_3. Don't undo it.

---

## Self‑audit checklist before opening a PR

- [ ] No new color, shadow, or motion tokens introduced (search the diff for `bg-`, `text-`, `shadow-`, `duration-`, `border-` and confirm every match already exists elsewhere).
- [ ] No `console.log` left in production paths.
- [ ] Math always flows through `$...$` / `$$...$$` — no bare LaTeX in any rendered string.
- [ ] React 185 doesn't return. Verify by leaving the reader open for 5 minutes with a streaming Q&A — the error overlay should never appear.
- [ ] Heap delta after the 5‑paper smoke is < 80 MB end‑to‑end.
- [ ] `npm run lint` and `npm run build` are clean.
- [ ] Cross‑paper toggle / placeholder / caption are gone from the Q&A panel under the current flag.
- [ ] Cite this doc in the commit message: `Implements docs/COMPOSER_FIX_PROMPT_4.md (bugs 1–5)`.
