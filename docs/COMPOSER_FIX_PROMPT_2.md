# Know — bug‑fix briefing #2 for Composer 2.5

> **Scope**: five UX defects in the authenticated reader pane (`/paper/[id]`) plus a refinement pass on the analysis pane. Run an investigate → diagnose → fix → verify loop on each one. Stay inside the rules in `.cursor/rules/*.mdc` (analysis‑pane, architecture, latex). **Read those rules first.** Re‑use the existing primitives — do **not** add new shadow tokens, motion durations, colors, or animation classes; any new className you add must already exist somewhere in the codebase or carry a one‑line comment justifying it.
>
> **Stack reminders that bit prior models**:
> - Next.js 16 (canary‑style file routing). Verify routing / request APIs by reading `frontend/node_modules/next/dist/docs/` if you're unsure.
> - AI SDK v6 + Zod 4. `streamObject({ schema: zodSchema(z.object({...})) })` is mandatory. (Not relevant to most of this prompt, but the same constraint applies if you touch a stream route.)
> - `@ai-sdk/react`'s `experimental_useObject` is the streaming client. Don't roll your own SSE parser.
> - Streaming UX (cursor, "streaming…" badge, pulse footer) lives **only** in `frontend/src/components/analysis/StreamingMarkdown.tsx`. Do not reinvent it.
> - Math: `$...$` inline, `$$...$$` display — Streamdown's `@streamdown/math` plugin with `singleDollarTextMath: true`. The legacy `Md`/`preprocessLatex` chain is kept exclusively for the Notes path.
> - Visual language: card bg `bg-card/30 dark:bg-card/22`, chrome `bg-muted/[0.08]`, borders `border-border/50` (chrome `border-border/40`), section spacing `space-y-8`, inner `space-y-3`, list `space-y-2`, body `text-[var(--text-sm)]`, heading `font-display tracking-[-0.02em]`, motion `motion-safe:duration-150` only.
>
> **Test plan**: after each bug, run `npm run lint` + smoke‑test by uploading a paper and exercising the relevant flow. Do not open a PR until all five bugs hit their acceptance criteria.

---

## Snapshot of the offending surfaces (read these first)

| Concern | Files |
|---|---|
| Selection result panel | `frontend/src/components/panel/SelectionResultPanel.tsx`, `frontend/src/components/panel/SectionHeader.tsx`, `frontend/src/components/analysis/AnalysisSection.tsx` |
| PDF text selection + highlight | `frontend/src/components/pdf/PdfViewer.tsx`, `frontend/src/app/globals.css` (`.react-pdf__Page__textContent`, `.know-selection-*`), `frontend/src/lib/store.ts` (`marqueeMode`) |
| Figures empty state + preview | `frontend/src/components/sidebar/FiguresPanel.tsx` (`AuthImage`, `Lightbox`, grid + detail) |
| Q&A panel | `frontend/src/components/sidebar/QAPanel.tsx` |
| Analysis pane visual polish | `frontend/src/components/panel/BottomPanel.tsx`, every `frontend/src/components/sidebar/*Panel.tsx`, `frontend/src/components/analysis/*`, `frontend/src/components/panel/AnalysisAccordionRow.tsx`, `frontend/src/app/globals.css` (`.analysis-pane-v2`, `.analysis-content`) |

Read each file top‑to‑bottom before editing. If something looks weird (e.g. a multi‑step word‑snap fallback with comments mentioning Safari/WebKit), assume the original author had a reason and preserve that branch — refactor, don't rip.

---

## Bug 1 — Selection results: add an "Assumptions" header above the assumption list

### Reported symptom
On a `derive` (or `explain` with assumptions) result, the assumption rows appear at the bottom of the card with no label. Users don't know what they're looking at — the rows just start. Add a clear "Assumptions" header above that block.

### Where to look
- `SelectionResultPanel.tsx::ResultCard` (~L370–L396). The `result.assumptions` block is rendered as a single rounded list with no `SectionHeader` / `AnalysisSection` wrapping.
- Same panel already uses `SectionHeader` for "Follow‑ups" and "History"; this is a missing primitive call.

### Required fix
1. Wrap the `result.assumptions` block in `<AnalysisSection title="Assumptions" count={result.assumptions.length}>` (import from `@/components/analysis/AnalysisSection`).
2. Drop the now‑redundant outer `rounded-lg border` because `AnalysisSection` provides the chrome — the inner row treatment (per‑assumption `border-b` divider, `Badge`, body text) stays exactly as it is. Keep `motion-safe:transition-colors motion-safe:duration-150 hover:bg-accent/40` on each row.
3. Inside the section, render the list inside a card container that matches sibling lists in the pane:
   ```
   <div className="overflow-hidden rounded-lg border border-border/50 bg-card/45 divide-y divide-border/50 dark:bg-card/22">
     {result.assumptions.map(...)}
   </div>
   ```
   (the `bg-card/45 dark:bg-card/22` + `border-border/50` pair already appears in `SelectionResultPanel.tsx`'s history block — use the same tokens, don't invent new ones.)
4. Each assumption row's `data-type` should be exposed (`<div data-type={a.type} ...>`) so future styling can target explicit vs implicit without re‑measuring the badge.
5. When `result.assumptions` is empty/undefined, **do not** render the section at all (no "0 assumptions" empty state — keeps the panel terse).
6. In the **accordion (follow‑up) variant** of `ResultCard` (`hideHeader && hideQuote`), keep the assumptions header but use the same `AnalysisSection` primitive — it scales down to the accordion body width via its `space-y-3` shell.

### Acceptance criteria
- Every selection result that contains assumptions shows a "Assumptions" header with the count badge next to it, styled identically to the existing "History" / "Follow‑ups" / "Queued" headers.
- No "Assumptions" header appears when the array is empty.
- Visually consistent on both the main result card and inside a follow‑up accordion row.

---

## Bug 2 — Selection / highlight is flaky on double‑column or scanned PDFs

### Reported symptom
On double‑column papers, drags across columns produce ragged or empty selections; releasing the mouse sometimes doesn't fire the toolbar at all. On scanned (image‑only) PDFs, there's no text to select — the user gets nothing, no message. **Goal: improve cross‑column word‑snap on text PDFs, and auto‑drop into marquee/region capture mode on scanned PDFs** (Elicit's fallback for image‑only papers).

### Where to look
1. `PdfViewer.tsx`
   - `snapRangeToWordsViaIntl` (~L329–L373) — only handles selections where `startContainer === endContainer` (text node). Cross‑span drags (every drag that wraps a line break in pdf.js, which fragments glyphs per span) return `null`.
   - `snapRangeUsingSelectionModify` (~L292–L326) — works across spans but `mod.call(sel, "extend", "backward", "word")` is brittle on WebKit if the selection started in a non‑text element.
   - `snapRangeToWords` (~L376–L397) — falls back through Intl → modify → null. On double‑column papers we frequently hit the null branch and lose the snap.
   - `finalizeTextSelectionToolbar` (~L1393–L1426) — bails on `sel.toString().trim().length < 2`. A column‑crossing selection often returns the wrong joined text on WebKit because pdf.js emits column 1's tail and column 2's head on separate `<span>`s with hidden spaces.
   - `Document` (~L1709) — `onLoadSuccess` does not record whether the text layer for any page rendered with content. We have no signal "this PDF has no extractable text."
   - `handleTextLayerRendered` (~L1313–L1317) — fires per page but only schedules the underline redraw. It does **not** check if the text layer is empty.
   - Text‑layer CSS in `globals.css` (~L484–L555) — `pointer-events` and `cursor` are correct; nothing to change there.
2. `store.ts` — `marqueeMode` + `setMarqueeMode` already exist; we just need a new flag like `pdfTextLayerEmpty: Record<paperId, boolean>` or a derived state.

### Required fix — Part A: better cross‑column word‑snap

1. **Drop the single‑text‑node guard in `snapRangeToWordsViaIntl`.** Walk the range with a `TreeWalker` from `startContainer` to `endContainer` to collect the *boundary* text nodes regardless of nesting. If `startContainer` isn't a text node, resolve it via the existing `resolveTextPoint(... "start")`; same for end with `"end"`. Then run Intl segmentation against those two resolved text nodes, exactly like today. Cross‑span selections now snap correctly because we're only touching the two endpoints — never the spans in the middle.
2. **Always prefer `snapRangeUsingSelectionModify` for *Blink* on multi‑line / multi‑column selections,** because the live `Selection.modify("extend", ..., "word")` snap survives glyph‑per‑span fragmentation. Add a heuristic:
   ```
   const isMultiLine = (range.getClientRects().length > 1) ||
                       range.startContainer !== range.endContainer;
   ```
   When `isMultiLine` is true, run `snapRangeUsingSelectionModify` first (regardless of `preferIntlWordSnapFirstForPdf()`); fall back to the cross‑span Intl variant; fall back to the existing single‑node Intl path.
3. **Don't shrink on snap failure.** Today `snapRangeToWords` returns `null` and the caller uses the unsnapped range — fine — but it also bails earlier if `normalizeRangeEndpointsToText` returns null. Change that branch so a normalization failure still snaps the original range via `snapRangeUsingSelectionModify`.
4. **Re‑read `sel.toString()` after the snap.** `finalizeTextSelectionToolbar` re‑reads via `sel.getRangeAt(0)`; ensure the snap call `stabilizeSelectionAnchors(sel, snapped)` ran first (it does), then re‑normalize the joined text once more for column hyphenation: collapse `-\n` (soft hyphen line break across columns) into `""` before the existing `\s{2,}` collapse, so "intel-\nligence" reads as "intelligence" and matches a needle of "intelligence".
5. **`stabilizeSelectionAnchors` after the snap should retry once on WebKit if `sel.rangeCount === 0`** (Safari sometimes drops the range when the snap crossed shadow‑DOM‑like span boundaries inside pdf.js). One retry inside a `requestAnimationFrame` is enough.

> **Do not** rewrite the word‑snap chain. The existing 3‑step fallback handles Chrome/Firefox/Safari quirks discovered the hard way — keep its shape, just widen the input domain so cross‑column drags actually reach the snap.

### Required fix — Part B: scanned / image‑only PDFs

1. **Detect "no text layer" per page in `handleTextLayerRendered`** (~L1313). When a page's `.react-pdf__Page__textContent` exists but has *zero* descendants with text content after a render success, increment a `pageWithoutTextCount` ref. After the first 3 visible pages have rendered, if all 3 had no text, flip a new piece of viewer‑local state `isScannedPdf` to `true`. (3 pages avoids false positives on a paper whose page 1 is a title page image.)
2. **When `isScannedPdf` is true, auto‑enter marquee mode and stay there.** Implementation:
   - On `isScannedPdf → true`, call `setMarqueeMode(true)` once and add a top banner inside the PDF scroll container:
     ```
     <div className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-border/50 bg-amber-500/[0.06] px-4 py-2 text-[var(--text-sm)] text-foreground/90 backdrop-blur-sm">
       <span>This PDF has no selectable text. Drag to capture a region instead.</span>
       <button onClick={() => setMarqueeMode(false)} className="text-[var(--text-xs)] font-medium text-muted-foreground hover:text-foreground">Dismiss</button>
     </div>
     ```
     **Use only existing tokens** — `border-border/50`, the `bg-amber-500/[0.06]` already exists in `BibtexModal.tsx` (verify via grep before assuming). If amber isn't used yet, fall back to `bg-muted/[0.12]` which definitely exists.
   - Dismissing the banner only hides the banner; marquee mode stays on because there's no text to select anyway.
   - On `marqueeMode === true && isScannedPdf === true`, the marquee drop captures into Figures *or* into a new "selection by region" pathway. **For this fix, keep the existing marquee → Figures flow** (`handleMarqueeUp` → `setPendingFigureBlob` → switch to Figures tab). Add an opt‑in note on the empty‑state Figures grid: when a figure was just added via region capture from a scanned PDF, prepend the figure caption with the page number (`fig.caption = \`Page ${pageNum} — region\``). That preserves the user's location context for scanned papers.
3. **For text PDFs where a single page is image‑only (figure‑heavy slide deck),** do *not* auto‑enter marquee — only flip when the *first 3* pages all came up empty. Otherwise users with a 30‑page paper that opens on a figure see false‑positive marquee mode.
4. **When `isScannedPdf` is true, do NOT paint the existing `.know-selection-underline` overlays** (the highlight‑match pass can run forever on an empty text layer — guard `drawUnderlinesForPage` with `if (textLayer && textLayer.childElementCount === 0) return;`, which is already there but currently only short‑circuits if history is non‑empty AND text layer is empty *before* an early return up top — re‑read that block).

### Required fix — Part C: scoping the banner

- The "no text" banner is per‑paper, not per‑page. Once detected for `paperId`, remember in zustand: `useStore.setState((s) => ({ pdfTextLayerEmptyByPaper: { ...s.pdfTextLayerEmptyByPaper, [paperId]: true } }))`. Add the new slice + setter to `store.ts` alongside `marqueeMode`. Clear on paper switch.
- Don't persist the flag across reloads (no `persist` partialize entry) — pdf.js detection is cheap on page 1.

### Acceptance criteria
- **Double‑column papers (text PDFs)**: drag from column 1 line 5 to column 2 line 5 → toolbar fires; "Explain" produces a selection result whose `selected_text` includes the joined column 1 tail + column 2 head, with hyphenated words rejoined. Underline overlay covers both column rectangles after persistence.
- **Long single‑column papers**: existing single‑node Intl snap path unchanged; no regression on Mac Safari.
- **Scanned PDF (e.g. arXiv pre‑1995 paper, or any image‑only PDF)**: after first 3 pages render, banner appears, marquee mode auto‑enables, dragging a rectangle drops the region into Figures tab with caption `Page N — region`.
- No console errors on either path. Selection toolbar never fires with empty text.
- `npm run lint` passes; `npm run build` types clean.

---

## Bug 3 — Figures empty state copy: "No figures yet" → "No figures detected"

### Reported symptom
On papers where the extractor ran and found nothing, the empty state reads "No figures yet" which implies they'll appear later. They won't unless the user adds them. Reword to be accurate.

### Where to look
- `FiguresPanel.tsx` (~L484–L548) — the `figures.length === 0` empty state. Current copy: `"No figures yet"` and `"Add one from the PDF, screen capture, or clipboard. Figures are saved per paper automatically."`

### Required fix
1. Change the heading to `"No figures detected"`.
2. Change the body to `"Nothing was extracted from the PDF. Capture a region, paste an image, or re-run extraction."` (still accurate, still actionable).
3. Leave the three CTAs alone (Capture / Region / Paste). Leave the "Re-run PDF figure extraction" link at the bottom alone.
4. Do **not** touch the loading state (`!paperReady`) — that one's correct.

### Acceptance criteria
- New paper with extracted figures: shows the grid.
- New paper with no extractable figures: shows "No figures detected" + the same three CTAs.
- No layout shift compared to the previous empty state.

---

## Bug 4 — IGNORE

User instruction: keep the Q&A intro line as‑is. **Do not touch `QAPanel.tsx` line ~203 "Queue questions as you read…".**

This entry is intentionally left in the prompt as a no‑op so the bug numbering matches the user's report.

---

## Bug 5 — Figure preview is slow / shows "No preview"; analysis pane needs to feel professional

This is two related fixes: a concrete preview reliability bug, plus a broader visual refresh on the analysis pane. **Do both in a single pass** — they share files and design language.

### 5a. Figure preview reliability

#### Reported symptom
Click a figure in the grid → detail view shows either a spinner that lingers, or "No preview" even though the thumbnail clearly rendered in the grid moments earlier.

#### Where to look
- `FiguresPanel.tsx::AuthImage` (~L61–L106). Fetches the figure via `fetch(src, { headers })` and creates an object URL. On failure, falls through to the "No preview" string. **Two real problems:**
  1. Every `AuthImage` instance does its own fetch. When the user clicks a figure, the *detail* view renders a fresh `AuthImage` with the same `src` — it has to refetch even though the grid thumbnail already has the same blob in memory.
  2. There's no retry on transient failure. A momentary 502 from the Python figure endpoint flips `failed = true` and the user has to navigate away to recover.

#### Required fix
1. **Module‑scoped LRU blob cache, keyed by `src`.** Add to the top of `FiguresPanel.tsx`:
   ```ts
   const FIG_BLOB_CACHE_SIZE = 64;
   const figureBlobCache = new Map<string, string>();
   function rememberFigureBlob(src: string, blobUrl: string) {
     if (figureBlobCache.has(src)) return;
     figureBlobCache.set(src, blobUrl);
     if (figureBlobCache.size > FIG_BLOB_CACHE_SIZE) {
       const firstKey = figureBlobCache.keys().next().value;
       if (firstKey) {
         const stale = figureBlobCache.get(firstKey);
         if (stale && stale !== blobUrl) URL.revokeObjectURL(stale);
         figureBlobCache.delete(firstKey);
       }
     }
   }
   ```
   `AuthImage` reads `figureBlobCache.get(src)` first; if hit, uses it immediately and skips the fetch. On a successful new fetch, calls `rememberFigureBlob(src, objUrl)`. Detail view now opens instantly because the grid thumbnail's blob is reused.
2. **Single retry on failure with 500 ms backoff.** Replace the `fetch ... .catch(setFailed)` chain with:
   ```ts
   async function fetchWithRetry(src: string, headers: Record<string, string>) {
     for (let i = 0; i < 2; i++) {
       try {
         const res = await fetch(src, { headers, cache: "no-store" });
         if (!res.ok) throw new Error(`status ${res.status}`);
         return await res.blob();
       } catch (e) {
         if (i === 1) throw e;
         await new Promise((r) => setTimeout(r, 500));
       }
     }
     throw new Error("unreachable");
   }
   ```
3. **Cleanup discipline.** Only revoke the object URL on unmount if it's *not* in the cache (otherwise the grid's next click would resurrect a dead URL). Update the unmount effect accordingly:
   ```ts
   useEffect(() => {
     return () => {
       if (blobUrl && !Array.from(figureBlobCache.values()).includes(blobUrl)) {
         URL.revokeObjectURL(blobUrl);
       }
     };
   }, [blobUrl]);
   ```
4. **Loading affordance.** Today the spinner is a tiny 4×4 — bump the placeholder so the user sees a clear shimmer:
   ```
   <div className="flex h-full w-full items-center justify-center bg-muted/[0.12]">
     <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground/70" />
   </div>
   ```
   No new animation token — `animate-spin` already exists.
5. **The "No preview" fallback** stays as a final state but bump the contrast — current `text-muted-foreground/30` is invisible. Use `text-muted-foreground/70` with an outline icon:
   ```
   <div className={cn("flex flex-col items-center justify-center gap-1 bg-muted/[0.10] text-muted-foreground/70", className)}>
     <svg className="h-5 w-5" ...><path d="M3 4.5h18v15H3zM7 10l3 3 5-6 4 6" .../></svg>
     <span className="text-[var(--text-xs)] font-medium">Preview unavailable</span>
   </div>
   ```
   Single SVG, single line, no decorative gradient.

#### Acceptance criteria
- Clicking a figure that's visible in the grid loads its detail preview **with no perceptible delay** (blob cache hit).
- Transient backend hiccup: preview retries once and recovers without showing "Preview unavailable".
- Switching papers and back doesn't show "Preview unavailable" for figures the user previously inspected.
- Cache stays bounded (max 64 entries) and revokes evicted URLs.

### 5b. Analysis pane visual refresh — "Apple Reader / Notes" target

The user feedback: *"it looks too basic / feels vibecoded."* Direction: **calm, editorial, generous spacing, soft hairlines, careful typography**. We are *not* redesigning the pane — we are tightening every rough edge so the eye doesn't catch on noise.

> **Hard constraints**: do not add new colors, shadow tokens, motion durations, or animation classes. Audit every className you change against the analysis‑pane rule. If you find yourself wanting a new value, **stop** and reuse an existing one.

#### Audit and adjust

Walk every analysis‑pane file and apply the rules below. **Touch only the visuals — never the data, streaming, or panel logic.**

##### 1. Section headers (`SectionHeader.tsx`)
- Today: `h2 text-[var(--text-sm)] font-medium tracking-[-0.014em]`, border‑b under each. Reads like "small caps title" on a form.
- Change to:
  - `h2` font: keep `font-display` if not already; tighten to `tracking-[-0.02em]`; size up to `text-[var(--text-md)]` for the *primary* section ("Summary", "History", "Assumptions") and keep `text-[var(--text-sm)]` for nested.
  - **Drop the bottom border.** Replace with `pb-1.5` so the header floats. The card / list immediately below already has its own border; the double divider is noisy.
  - The `count` pill: keep mono digits, but enclose in `rounded-full bg-muted/40 px-1.5 py-px text-[10px] font-medium text-muted-foreground/80` (tokens that already exist — verify). It looks like a Notion counter, not a debug print.
- Provide a second variant via an optional prop `eyebrow={true}` that renders the heading as an uppercase eyebrow:
  ```
  <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/85">{title}</span>
  ```
  Use this variant for the legacy chrome rows ("History" outside a card, the "Follow‑ups" header inside an accordion).

##### 2. Cards (`AnalysisAccordionRow`, ResultCard wrappers, history list)
- Standardize on **one** card chrome: `rounded-[var(--radius-lg)] border border-border/50 bg-card/35 dark:bg-card/22`. Today we have `bg-card/30 dark:bg-card/22`, `bg-card/40 dark:bg-card/25`, `bg-card/45 dark:bg-card/22`, etc. Pick one (`/35` and `/22` from the rules) and replace the rest. **Use grep** to confirm you've touched them all.
- Inside cards, divide rows with `divide-y divide-border/40` (chrome weight) — never `border-b` per row.
- Selection toolbar action pills (`data-action` colored squares in `SelectionResultPanel.tsx`): keep the hue but quiet it down to text-only when the card is at rest:
  ```
  text-[10px] font-medium uppercase tracking-[0.14em]
  color: rgb(var(--highlight-rgb) / 0.85)
  background: transparent
  border: none
  ```
  On hover or in the active row, restore the soft fill. The pill currently looks like a button; we want it to read like a tag.

##### 3. Spacing
- Outermost pane container: keep `space-y-8` between top‑level sections (already the rule).
- Inside a section: `space-y-3`.
- List items inside a card: `divide-y` (no margin). Padding stays `px-3 py-2.5`.
- Empty states: bump vertical padding to `py-12` and add an outline icon at the top (most empty states are already correct — verify Q&A and Notes match).

##### 4. Typography
- Body in cards: `text-[var(--text-sm)] leading-relaxed text-foreground/90`. Today some panels mix `text-[var(--text-md)]` for content — drop down to `--text-sm` for everything inside cards. Headings keep `--text-md`/`--text-lg` per the SectionHeader change.
- Italic / quote rows (`ResultCard` quote at L329–L335): keep italic but switch to `text-foreground/80 dark:text-foreground/75` and **remove the rounded border** — let it sit on the card with just a left ruler:
  ```
  <div className="border-l-2 border-border/50 pl-3 text-[var(--text-sm)] italic text-foreground/80">
    "{...}"
  </div>
  ```
- Selection‑result body card: drop the inner rounded border too. The outer accordion / section card carries the chrome already; doubling the borders is what reads as "vibecoded".

##### 5. Buttons
- Primary CTAs in the pane already use `.btn-primary-glass`. Keep.
- Secondary buttons: standardize on
  ```
  rounded-md border border-border/55 bg-transparent px-2.5 py-1 text-[var(--text-xs)] font-medium text-foreground/85 hover:bg-accent/30 hover:text-foreground transition-colors motion-safe:duration-150
  ```
  Replace the various copies that use `border-border/60` / `border-border/70` etc.
- Tertiary actions (links like "Hide" / "Clear" / "Show answer"): no border, just `text-[var(--text-xs)] font-medium text-muted-foreground hover:text-foreground transition-colors`. Hide them in a row's `action` slot of `SectionHeader` so spacing stays consistent.

##### 6. Accordion row chrome (`AnalysisAccordionRow.tsx`)
- The current row has a leading numeric pill `rounded-md border border-border/55 bg-background/70` at `h-6 w-6 text-[10px]`. Read like a debug counter.
- Change to a quieter monogram: keep the box but switch to `rounded-md bg-muted/35 text-muted-foreground` with **no border**. Drop the size to `h-5 w-5 text-[10px]` and remove the explicit `dark:` variant — `bg-muted/35` already works in both modes.
- Chevron color → `text-muted-foreground/55`, size unchanged.

##### 7. Selection action history (`SelectionResultPanel.tsx` history list)
- Replace the colored action pill (rounded‑md, colored background) with an *uncolored* pill: `rounded-full border border-border/55 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/85`. The action label is text only; the colored underline already lives on the PDF page where it belongs.
- The "Open" right‑hand label is redundant since the whole row is clickable. Drop it. Leave the `+N` follow‑up count on the right.

##### 8. Progress bars (`AnalysisProgress.tsx`)
- Already an indeterminate sweep at the existing `--shadow-xs`. Keep — no change.
- Wherever a panel uses `AnalysisProgress` in a centered "Thinking…" / "Generating…" block, make sure the wrapper uses:
  ```
  <div className="flex flex-col items-center gap-2 py-6">
    <div className="w-full max-w-[16rem]"><AnalysisProgress kind="..." /></div>
    <p className="text-[var(--text-xs)] text-muted-foreground/85">…</p>
  </div>
  ```
  Standardize across `SelectionResultPanel`, `SummaryPanel`, `QAPanel`, `AssumptionsPanel`, `PreReadingPanel`. Right now they vary subtly.

##### 9. Bottom panel tab strip (`BottomPanel.tsx`)
- Rule says "tab strip is data‑driven via `AnalysisTabs`." It currently isn't — tabs are hand‑written. **Do not rewrite into `AnalysisTabs`** in this pass (out of scope) but **do** apply two visual fixes:
  - Active tab indicator (the `::after` underline declared in `globals.css .analysis-panel-tabs`) gets `h-px` (currently 2px in some places). One pixel feels editorial.
  - The "locked" tab icon (lock svg) is large and dark. Drop to `opacity-30` and `h-2 w-2`.
- The active tab text should be `text-foreground font-medium`, inactive `text-muted-foreground/85`. No font‑weight jump between active/inactive — we already render a `font-semibold` active state in `TAB_STYLE` (`data-active:font-semibold`). **Remove the font‑weight bump**; rely on color + underline. The current jump causes layout shift on tab switch.

##### 10. Panel container background
- `globals.css .analysis-pane-v2` is plain — leave it.
- The pane wrapper in `BottomPanel.tsx` uses `bg-muted/[0.11]` as the tab strip background. Drop to `bg-muted/[0.06]` so the strip merges into the reader chrome rather than reading as a distinct band.

#### Don't do these things
- Don't add a radial gradient anywhere.
- Don't add a noise texture.
- Don't change `font-family` declarations.
- Don't introduce a new `--radius-*` variant.
- Don't introduce a new motion duration. `motion-safe:duration-150` is the only allowed one.
- Don't reach for `backdrop-blur` on a card body. Reserve it for the existing chrome strips.

#### Acceptance criteria
- Visual diff before / after: pane feels quieter, more typographic, less "form‑like". Every section header now floats; every card has a single border instead of a border + bottom divider stack.
- No new color tokens, motion classes, or shadow tokens introduced (`git diff` confirms only existing classes).
- Tab strip no longer jumps when you click between tabs.
- `npm run lint` passes. `npm run build` types clean. Smoke test: open a paper, run a `derive`, watch a follow‑up stream, switch tabs — nothing visually broken.

---

## Cross‑bug invariants

- **No new dependencies.** Everything ships from existing packages.
- **Never reintroduce removed primitives** (`LocalModelProvider`, `Ollama`, etc.). The architecture rule still applies.
- **Streaming routes are untouched.** Bug 1–5 are all client/CSS work. The only file in `frontend/src/app/api/*` you should consider opening is for reference, not editing.
- **Python touched only if Bug 2 Part B requires a per‑paper "has text layer" flag persisted server‑side.** It does not — we store in zustand only. So **no Python changes**.
- **No `console.log` in production paths.** Diagnostic logs added during investigation must be removed before the PR.
- **Type safety**: every PR file must pass `tsc` without `any` casts. If you need to widen, widen via Zod first then propagate.

---

## Suggested execution order

1. **Bug 3** (one‑line copy change) — trivial, lands first.
2. **Bug 1** (Assumptions header) — small, isolated to `SelectionResultPanel.tsx`.
3. **Bug 5a** (figure preview cache + retry) — independent of UI polish.
4. **Bug 2** (PDF selection + scanned PDF banner) — the most code; touch `PdfViewer.tsx`, `store.ts`, `globals.css`.
5. **Bug 5b** (analysis pane visual refresh) — last so the previous fixes don't have to be re‑touched.

After all five land, run `npm run lint`, `npm run build`, and a manual smoke pass:
- Upload a normal text PDF → Summary, Prepare, Assumptions kick off; Selection on a single column works; Selection across columns works with hyphenation handled; "Explain" result shows an "Assumptions" header.
- Switch to a scanned PDF (any image‑only sample) → banner appears, marquee mode auto‑enables, dragging captures a region → lands in Figures.
- Open Figures grid → click a figure → preview shows instantly. Switch to another figure → instant. Force a backend hiccup (network throttle) → retry recovers.
- Walk every analysis‑pane tab — section headers float, cards have one border, action pills read as tags, accordion chevrons subdued.

---

## File map (touch only these — anything else is out of scope)

- [ ] `frontend/src/components/panel/SelectionResultPanel.tsx`
- [ ] `frontend/src/components/panel/SectionHeader.tsx` *(if eyebrow variant added — keep API additive)*
- [ ] `frontend/src/components/panel/AnalysisAccordionRow.tsx`
- [ ] `frontend/src/components/panel/BottomPanel.tsx`
- [ ] `frontend/src/components/analysis/AnalysisSection.tsx` *(only if a typography change is needed — likely no)*
- [ ] `frontend/src/components/sidebar/SummaryPanel.tsx`
- [ ] `frontend/src/components/sidebar/AssumptionsPanel.tsx`
- [ ] `frontend/src/components/sidebar/PreReadingPanel.tsx`
- [ ] `frontend/src/components/sidebar/QAPanel.tsx` *(visual only — do NOT change copy per user instruction)*
- [ ] `frontend/src/components/sidebar/NotesPanel.tsx`
- [ ] `frontend/src/components/sidebar/FiguresPanel.tsx`
- [ ] `frontend/src/components/sidebar/RelatedWorkPanel.tsx`
- [ ] `frontend/src/components/pdf/PdfViewer.tsx`
- [ ] `frontend/src/lib/store.ts` *(add `pdfTextLayerEmptyByPaper` slice for Bug 2)*
- [ ] `frontend/src/app/globals.css` *(only the tab strip underline, the "no figures detected" empty state classes if any, and the active‑tab weight removal)*

Do **not** open:
- Any `frontend/src/app/api/**/*.ts` route.
- Any `backend/**/*.py`.
- Any `frontend/src/lib/server/**/*.ts`.
- `frontend/vercel.json`.

If you think one of those needs to change, **stop and ask** — it almost certainly doesn't for this batch.

---

## Definition of done

- All four active bugs (1, 2, 3, 5) green against their acceptance criteria.
- Bug 4 untouched.
- `npm run lint` and `npm run build` both pass.
- Manual smoke pass logged at the bottom of the PR description with screenshots: before/after of one selection result card (Bug 1), one scanned‑PDF banner (Bug 2), one figure detail open (Bug 5a), and one full pane shot (Bug 5b).
- Commit message: `fix(frontend): selection/assumptions header, scanned PDF marquee fallback, figure preview cache, analysis pane polish` (or similar — focus on the *why*).
- No new `console.log` survives.
