# Polish the Mistral OCR reader: typography, composite figures, selection toolbar, font controls, original-PDF link

## Goal

The Mistral-OCR reader (Prompt #12) works end-to-end, but the UX is rough. Five concrete bugs:

1. **Typography is ugly.** The rendered markdown reads like a raw text dump — author lists collapsed with KaTeX subscripts inline, headings indistinguishable from body, no journal "feel". Make it look like a professional preprint / journal article.
2. **Figures are split into individual sub-panels.** A 4-panel figure (e.g. Fig. 1A–D) currently surfaces as four separate `[img-N]` crops inline. We want **one composite image per figure**, matching how the figure looks in the source PDF. Mistral OCR returns the per-panel bounding boxes — we composite from the source PDF using PyMuPDF.
3. **Selection toolbar is missing.** Selecting text in the markdown reader no longer opens the Explain / Derive / Highlight / Add-note menu we had on `PdfViewer`. Restore it.
4. **Reader font controls are missing.** The analysis pane has font scale + family controls; the reader doesn't. Add reader-only controls (font size + family) that persist per user.
5. **"View original PDF" returns `{"detail":"Unauthorized"}`.** Clicking the link opens a new tab on `BACKEND_URL/api/papers/{id}/pdf`, which has no Clerk Authorization header. Proxy via Next.js so the same-origin Clerk cookie carries auth.

Be careful: do not regress the existing reader, the OCR pipeline, the analysis pane, the Figures panel, or `PdfViewer`. The fallback path (papers with `ocr_status !== "ready"`) must keep using `PdfViewer`.

## Architectural ground rules (workspace rules — must follow)

Read first:

- `.cursor/rules/architecture.mdc` — Mistral OCR + figure rendering stay on Python; signed proxy for the PDF lives on Next.js. No Anthropic/OpenAI changes.
- `.cursor/rules/latex.mdc` — the **reader markdown** path is the legacy LaTeX-in-Markdown path and is allowed to contain `$...$` from Mistral. Continue to render via `streamdown` with the math plugin. Do not touch `RichContent` / `StreamingMarkdown`.
- `.cursor/rules/analysis-pane.mdc` — reuse `OverflowMenu` for the new reader font menu. No new color / shadow / motion tokens.

## Current state — files and line refs

- Reader: `frontend/src/components/reader/MarkdownReader.tsx` (≈235 LOC).
- Selection handling: `frontend/src/app/paper/[id]/page.tsx` around the `handleTextSelected` / `handleSelectionAction` block (search for `SelectionActionMenu` / `setSelection`).
- "View original PDF" button: `frontend/src/app/paper/[id]/page.tsx:2103` uses `api.getPdfUrl(activePaperId)` and opens it in a new tab.
- `api.getPdfUrl`: `frontend/src/lib/api.ts:571` — currently `${API_BASE}/api/papers/${id}/pdf` (cross-origin in production).
- OCR ingest: `backend/app/services/ocr_mistral.py` (`run_mistral_ocr`, `_persist_ocr_images`, `_infer_image_caption`).
- Figure list for the analysis pane: `frontend/src/lib/ocrFigures.ts` → `analysisFiguresFromPaper`.
- Figures panel: `frontend/src/components/sidebar/FiguresPanel.tsx`.

---

## Track A — Typography polish for the reader

### Goal

Make `MarkdownReader` look like a journal article: serif body, clear heading hierarchy, generous line-height, proper figure captions, balanced math.

### Acceptance criteria

- Body in a **serif typeface** (system serif stack: `'Charter', 'Iowan Old Style', 'Source Serif Pro', Georgia, serif`). KaTeX math keeps its own font.
- Hierarchy:
  - `h1` 28 px, semibold, tracking `-0.02em`, line-height 1.25.
  - `h2` 13 px, **uppercase**, tracking `0.10em`, semibold, with a 1 px bottom border and 1.5 em top margin — feels like a journal section heading (INTRODUCTION / RESULTS / DISCUSSION / METHODS).
  - `h3` 16 px, semibold, tracking `-0.01em`.
- Body 16 px, line-height 1.75, paragraph spacing 1 em (no first-line indent — matches modern preprints).
- Max content width **`max-w-[68ch]`** (~720 px), centered. Side padding 24 px mobile / 56 px desktop.
- Captions: paragraphs that begin with `Fig.` or `Figure ` are styled `text-[12.5px] italic text-muted-foreground leading-snug` (use a `.reader-figure-caption` class or a streamdown plugin that detects the prefix; simplest: a CSS rule on `p:has(strong:first-child)` is unreliable — use a small AST pass in markdown post-processing to wrap caption paragraphs in `<figcaption>` and style that).
- References: render `ol` with hanging indents — `padding-left: 2em; text-indent: -2em;`.
- Inline math (`.katex`) wraps inside `inline-block` with `overflow-x: hidden`; **never** breaks a line.
- Display math (`.katex-display`) is centered, `max-w-full overflow-x-auto py-1` (matches the analysis-pane math rule).
- Sticky "Page N of M" header keeps current behavior but uses the same border/background tokens as the analysis-pane chrome (`border-border/40 bg-muted/[0.08]`).
- Print stylesheet: `@media print { .reader-article { max-width: none; padding: 0; } .reader-chrome { display: none; } }`.

### Implementation

- Add a new `.reader-article` CSS scope in `frontend/src/app/globals.css`. **Do not** modify `.analysis-content` — these stylesheets are independent (analysis-pane.mdc applies to the analysis primitives).
- Update `frontend/src/components/reader/MarkdownReader.tsx` to swap the article class to `reader-article` and remove `prose prose-neutral dark:prose-invert font-display analysis-content`. The prose typography is now hand-tuned in `globals.css`.
- Caption wrapping: post-process each rendered page's markdown text **before** handing to `<Streamdown>` — a small regex pass that converts a paragraph beginning with `Fig. ` or `Figure ` followed by a number-then-period into an HTML `<figcaption class="reader-figure-caption">…</figcaption>` block. Streamdown's pass-through HTML keeps the tag.

### Non-goals

- No new font files. System fallbacks only.
- No two-column layout (defer).
- Don't touch math rendering pipeline; the existing `createMathPlugin({ singleDollarTextMath: true })` setup stays.

---

## Track B — Composite figures from Mistral OCR

### Goal

When a paper figure (e.g. Fig. 1) is composed of multiple sub-panels (A–D), the OCR pipeline currently emits one `ocr_images` row per panel. The reader interleaves N separate `<img>` tags above the caption, and the Figures panel lists 17 panel thumbnails instead of 4 figures. Group panels into **one composite image per figure** that mirrors the source PDF layout.

### Strategy

Mistral OCR gives us per-image bounding boxes (`top_left_x` / `top_left_y` / `bottom_right_x` / `bottom_right_y`) plus the markdown for each page. The markdown places `[img-N]` refs in document order, typically clustered before a `Fig. N.` caption block. Use those signals.

#### Backend pipeline (Python)

In `backend/app/services/ocr_mistral.py`:

1. After `_rewrite_image_refs` finishes (we already have per-page markdown rewritten to stable IDs), call a new function `group_panels_into_figures(page_index, page_markdown, panel_entries) -> list[FigureGroup]`.
2. `FigureGroup` shape: `{ figure_id: str, page: int, caption: str, panel_image_ids: list[str], bbox: (x0, y0, x1, y1) }`. The `figure_id` is `"fig-{global_index}"`, e.g. `fig-1`, `fig-2`.
3. Grouping rule:
   - Walk the page markdown top-to-bottom.
   - Accumulate consecutive `![](img-X.png)` refs into a `pending_panels` list.
   - When we hit a paragraph starting with `Fig. <N>.` or `Figure <N>.`, close the group: caption = that paragraph (until the next blank line), bbox = union of `pending_panels` bboxes padded by `12 px`.
   - If the page ends with `pending_panels` non-empty and no caption seen, still emit a figure group with `caption = ""` (fallback).
4. Render each composite using **PyMuPDF**:
   - Open the source PDF from Supabase Storage (same path the current OCR pipeline reads).
   - `page = doc[fig.page]`
   - Convert OCR pixel bbox → PDF point bbox using page DPI from Mistral (`pages[i].dimensions.dpi`, default 200).
   - `pix = page.get_pixmap(clip=fitz.Rect(x0_pt, y0_pt, x1_pt, y1_pt), dpi=200)` and write `pix.tobytes("png")` to a buffer.
   - Persist to Supabase Storage at `papers/{paper_id}/ocr/{figure_id}.png` (next to the existing per-panel PNGs — keep the panel PNGs for backward compatibility but stop emitting them as the canonical figure surface).
5. Rewrite the page markdown one more time: collapse each panel group into a single `![{caption}]({figure_id}.png)` reference, **dropping** the individual `![](img-N.png)` refs. The caption paragraph stays (so the reader still renders it as a figcaption).
6. Persist a new shape on `ParsedPaper.ocr_images`:

   ```python
   class OcrImage(BaseModel):
       id: str                   # "fig-1" composite OR "img-0" leftover
       page: int
       bbox: list[float] | None  # (x0, y0, x1, y1) in PDF pixels
       caption: str | None
       kind: Literal["figure", "panel"]  # "figure" for composites, "panel" for any unmatched leftovers
       panel_ids: list[str] | None       # composite components, for debugging
   ```

   Only `kind == "figure"` entries should populate the Figures panel.

7. Add an idempotent `python -m app.scripts.composite_figures_backfill` that, for each paper with `ocr_status == "ready"`, re-runs the compositor against the cached `page_markdown` + the original PDF without re-calling the Mistral API. Same I/O contract as `ocr_backfill`.

#### Frontend

- `frontend/src/lib/api.ts` — extend `OcrImage` with `kind` and `panel_ids`. New endpoint URL for composites uses the same `getOcrImageUrl(paperId, "fig-1.png")` shape; the server route already serves anything under `papers/{id}/ocr/`.
- `frontend/src/lib/ocrFigures.ts` — `analysisFiguresFromPaper` returns only `kind === "figure"` entries (or, if absent, falls back to current behavior so legacy papers that haven't been backfilled still render something).
- `frontend/src/components/sidebar/FiguresPanel.tsx` — no logic change; the new shape just collapses the grid to "Fig. 1, Fig. 2, …".
- `frontend/src/components/reader/MarkdownReader.tsx` — no change needed; the rewritten markdown now references composite PNGs and `hydrateMarkdownImages` resolves them through the same blob cache.

### Acceptance criteria

- Open Kim et al. (Moiré ferroelectricity, Sci. Adv. 11 eadt7789). Fig. 1 shows as **one image** with all four panels (A, B, C, D), followed by an italic caption paragraph. Same for Figs. 2–4.
- Figures panel shows exactly 4 entries for Kim et al. (one per figure), each previewing the composite.
- The lightbox / figure Q&A still works because the figure ID `fig-1.png` matches the validation regex (extend the regex if needed — see "Validation" below).
- Backfill is idempotent and re-runnable.
- If the source PDF is missing or PyMuPDF fails, the pipeline silently falls back to the existing per-panel emission for that figure group (log a warning, no exception).

### Validation

- The figure-id allowlist on the frontend (`frontend/src/app/api/papers/[id]/figure-qa-stream/route.ts`) currently accepts `^p\d+-img-\d+\.png$`. **Extend** to also accept `^fig-\d+\.png$`. Mirror the same change in `backend/app/api/papers.py` `_validate_figure_id`, `backend/app/api/internal.py`, and `backend/app/api/analysis.py` (helpers added in commit `203cf9c`).

### Tests

- `backend/tests/test_ocr_mistral.py`: add `test_group_panels_into_figures_groups_by_caption()` and `test_group_panels_into_figures_handles_orphan_panels()`.
- `backend/tests/test_ocr_mistral.py`: add `test_composite_render_falls_back_when_pdf_missing()`.

---

## Track C — Restore the selection toolbar in MarkdownReader

### Goal

Selecting ≥2 chars of text in the markdown reader pops the same selection action menu (Explain / Derive / Highlight / Add note / Polish note) that `PdfViewer` shows. Selection toolbar must:

- Track the selection rect in viewport coords.
- Dismiss on Escape / click-outside / new selection.
- Wire into the same `handleSelectionAction` already in `frontend/src/app/paper/[id]/page.tsx`.

### Current bug

`MarkdownReader.tsx` listens on `document.selectionchange` and calls `onTextSelected` on every event including transient empty ones. Two problems:

1. `selectionchange` fires continuously during a drag, so the parent re-renders the menu thrashing position on every mouse move.
2. Some users report the menu never appears — likely because an early `onSelectionClear()` from a transient empty range wipes the parent state right after the final mouse-up commits.

### Fix

Replace the `selectionchange` listener with **mouseup + keyup** on the article container:

- On `mouseup` (or `keyup` for keyboard selection), read `window.getSelection()` and verify the range is inside `containerRef.current` and `text.length >= 2`.
- If valid, call `onTextSelected(text, range.getBoundingClientRect())`.
- If invalid, do **not** call `onSelectionClear` — only call clear on (a) explicit `mousedown` that starts a new selection inside the container, or (b) Escape key.
- Make sure the selection bubble's container also captures **touch-end** for mobile.

### Parent wiring (sanity-check)

`frontend/src/app/paper/[id]/page.tsx` already renders `<SelectionActionMenu>` inside `pdfInner` when `selection` is truthy. Confirm:

- The `pdfInner` branch is the same JSX subtree for both `MarkdownReader` and `PdfViewer`. If not (e.g. the menu is currently rendered as a sibling of PdfViewer only), restructure so the menu lives at the `pdfInner` root regardless of which reader is active.
- `handleSelectionAction` already covers Explain / Derive / Highlight / Add note. Confirm Polish-note works on markdown selections too (it should — the action uses the selected text, not coordinates).

### Acceptance criteria

- Selecting ≥2 chars in MarkdownReader pops the action menu within ~100 ms of mouse-up.
- Menu position tracks the **end** of the selection, not the start.
- Clicking outside dismisses; pressing Escape dismisses.
- All four selection actions function exactly as on `PdfViewer`.
- Highlights created from MarkdownReader land in HighlightsPanel and re-appear (as `<mark>` wraps) on subsequent paper opens (this is the existing `useReaderHighlights` path).

---

## Track D — Reader font controls

### Goal

A tiny `Aa` overflow menu in the reader's chrome (top-right of the sticky header) lets the user change the reader's font **size** and **family**. Settings persist per user via `useStore.uiPrefs`. The control affects **only** the reader — the analysis pane keeps its existing `analysisFontScale` / `analysisFontFamily`.

### UI

- Use the existing `OverflowMenu` primitive (`frontend/src/components/analysis/OverflowMenu.tsx`).
- Trigger: `Aa` icon button, `h-7 w-7 rounded-md`, anchored to top-right of the reader chrome (next to the "Page N of M" sticky badge).
- Menu items (radio-style):
  - **Size**: `A−` (0.92), `A` (1.0), `A+` (1.12), `A++` (1.25). Cycle on click of `A−` / `A+`.
  - **Family**: Serif (default), Sans, Mono. Selected item carries a check.

### Wiring

- `frontend/src/lib/store.ts` — extend `uiPrefs`:
  ```ts
  readerFontScale: number;       // default 1.0
  readerFontFamily: "serif" | "sans" | "mono"; // default "serif"
  setReaderFontScale: (v: number) => void;
  setReaderFontFamily: (v: ReaderFontFamily) => void;
  ```
- Persist through the same `persist` middleware that holds the other `uiPrefs` slices.
- `MarkdownReader.tsx`: wrap the `<article>` in a `<div style={{ "--reader-font-scale": scale, "--reader-font-family": FAMILY_TO_VAR[family] }}>`.
- `globals.css` `.reader-article` uses `font-size: calc(16px * var(--reader-font-scale, 1))` and `font-family: var(--reader-font-family, var(--font-serif))`.

### Acceptance criteria

- Cycling A−/A+ visibly resizes the body in <100 ms (CSS-only, no React re-render needed beyond the menu).
- Switching family swaps the typeface without layout jump (height-equivalent fallback list).
- Settings persist across reloads and across papers.
- The analysis pane font is unchanged when the reader font is changed.

---

## Track E — "View original PDF" 401

### Cause

`api.getPdfUrl(id)` returns `${API_BASE}/api/papers/${id}/pdf`. In production `API_BASE` is the Railway/Python URL (cross-origin). The new tab does not carry the Clerk bearer token, so Python's `require_auth` returns 401.

### Fix

Add a Next.js proxy route that authenticates via Clerk's same-origin session cookie and streams the PDF from Python with the internal HMAC bearer.

#### New file

`frontend/src/app/api/papers/[id]/pdf/route.ts`:

- `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`.
- `GET`:
  1. `await requireUser()` (re-uses `frontend/src/lib/server/auth.ts`; throws on no session).
  2. Validate `id` against `/^[a-zA-Z0-9_-]+$/`.
  3. Fetch the PDF from Python via `frontend/src/lib/server/internalApi.ts`. Add a new helper `fetchPaperPdfStream(paperId, userId)` that calls `${PYTHON_BACKEND}/api/internal/papers/{id}/pdf` with `Authorization: Bearer ${INTERNAL_BACKEND_TOKEN}` and returns the upstream `Response` (so we can stream).
  4. Return a `NextResponse` with `Content-Type: application/pdf`, `Content-Disposition: inline; filename="..."` (filename from `paper.title` if available, fallback `paper.pdf`), and stream the upstream body.

#### Backend route

If `/api/internal/papers/{id}/pdf` doesn't exist, add it in `backend/app/api/internal.py`. It must:

- Authenticate via the internal HMAC bearer.
- Stream the PDF bytes from Supabase Storage.
- Accept an explicit `user_id` query param so the call is scoped to the right tenant (mirrors `internal/load_paper`).

#### Frontend wiring

- `frontend/src/lib/api.ts` — `getPdfUrl` returns `/api/papers/${id}/pdf` (same origin).
- The two existing callers (`paper/[id]/page.tsx` PdfViewer URL + the "View original PDF" button + `try/[id]/page.tsx`) keep working — same-origin URL now flows through the proxy.
- For the anonymous trial route (`/try/[id]`), keep the existing direct-trial path (it has its own auth model). Don't break trial.

### Acceptance criteria

- Click "View original PDF" while signed in → opens the PDF in a new tab. No `Unauthorized`.
- Network panel: response comes from `/api/papers/{id}/pdf` (same origin).
- `PdfViewer` (for papers without OCR) keeps working — uses the same proxy URL.
- Trial flow (`/try/...`) unchanged.

---

## Cross-cutting requirements

- **Backward compatibility:** legacy papers without composite figures still render (Track B falls back to panel-level emission). Papers without OCR still use `PdfViewer`. Anonymous trial still works.
- **No layout regressions** in the analysis pane (analysis-pane.mdc still applies).
- **No new motion / shadow / color tokens.** Use existing CSS variables from `globals.css`.
- **No `console.log` in production paths.** Use `console.warn` only for genuine compositor fallbacks.

## Out of scope

- Two-column journal layout in the reader.
- AI-generated alt text for composite figures.
- Cross-paper reference linking from the bibliography.
- Re-running Mistral OCR to chase higher fidelity — only the compositor changes.

## Test plan

- **Backend**
  - `pytest backend/tests/test_ocr_mistral.py` — extend with the new grouping + compositor tests.
  - Smoke-run `python -m app.scripts.composite_figures_backfill --dry-run` against a local Supabase mirror.
- **Frontend**
  - `npm run lint && npx tsc --noEmit && npm run test`.
  - Manual: open Kim et al. (and one other multi-figure paper). Verify each acceptance criterion in Tracks A–E.
  - Manual: open a paper with `ocr_status !== "ready"` and confirm `PdfViewer` still works.
  - Manual: anonymous trial flow `/try/<id>` still renders.
- **Smoke after deploy**
  - "View original PDF" works without auth errors.
  - Composite figures visible in production preview.
  - Reader font controls persist across reloads.

## Definition of done

- Single feature branch, single PR.
- All five tracks merged and visible on the Vercel preview for Kim et al.
- `npm run lint && npx tsc --noEmit && npm run test` green.
- `pytest backend/tests/` green.
- Backfill script run against production database (separate manual step, not part of CI).
