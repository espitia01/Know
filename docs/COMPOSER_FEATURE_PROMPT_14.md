# Backend-side OCR cleanup + structured front-matter via Mistral annotations

## Goal

Stop fighting Mistral OCR's raw markdown in the browser. Move the entire cleanup pipeline (running headers, ASCII fallback, math duplication, byline collapsing, panel/composite figures, orphan figure detection) to the **Python backend**, where it runs **once per OCR pass** and caches the cleaned result on the paper row. Simultaneously, use Mistral's structured **`document_annotation_format`** to extract typed front-matter (title, authors, affiliations) so the reader doesn't have to recover that information by string-matching on prose. The frontend reader collapses to a thin "render the clean string" component with **zero** cleanup heuristics.

This is the refactor that gets us off the heuristic-cleanup treadmill. Every patch we've shipped to `MarkdownReader.tsx` over the last week is a piece of evidence that the work belongs server-side.

## Architectural ground rules

Read these before touching code:

- `.cursor/rules/architecture.mdc` — Mistral OCR + all OCR post-processing runs on **Python**. Anthropic / OpenAI / streaming LLM calls remain on Next.js. The Anthropic key never leaves Vercel, the Mistral key never leaves Railway.
- `.cursor/rules/latex.mdc` — the **reader** path is the legacy markdown-with-`$…$` path; `streamdown` + KaTeX. Do NOT introduce `RichContent` / `ContentBlock[]` for the reader. The cleanup pipeline produces a single markdown string; the reader renders it verbatim.
- `.cursor/rules/analysis-pane.mdc` — the analysis pane is untouched. This work is about the paper reader, not the analysis pane.

## Current state — where the mess lives

Client-side heuristics that need to die (or move):

- `frontend/src/components/reader/MarkdownReader.tsx` lines ~70–410:
  - `stripRunningHeadersFooters`
  - `stripPageNumberFooters`
  - `stripOcrAsciiFallback` (≥3-line glyph clusters)
  - `collapseAuthorByline`
  - `wrapBylineParagraph`
  - `dropPanelRefsWhenCompositesExist`
  - `dropOrphanFigureRefs`
  - `dedupeInlineMathDuplicates`
  - `collapseFragmentedMathParagraphs`
  - `rewriteOcrImageReferences`

Backend-side OCR pipeline:

- `backend/app/services/ocr_mistral.py` — current pipeline runs Mistral's basic OCR, rewrites image refs, persists images, and `apply_composite_figures` to merge panels into composite figures via PyMuPDF.
- `backend/app/scripts/ocr_backfill.py` — one-shot script that re-OCRs papers missing markdown.
- `backend/app/scripts/composite_figures_backfill.py` — one-shot script that re-runs the compositor against cached `page_markdown`.

Schema:

- `backend/app/models/schemas.py` — `ParsedPaper` already has `markdown`, `page_markdown`, `ocr_images`, `ocr_status`, `ocr_model`.
- `backend/supabase/migrations/020_ocr_markdown.sql` — the columns.

## Mistral API reference

- [Basic OCR](https://docs.mistral.ai/studio-api/document-processing/basic_ocr) — what we use today. Returns `pages[].markdown` with raw transcription. Suffers from math duplication, glyph-per-paragraph stacking, and no structured front-matter.
- [Document understanding with annotations](https://docs.mistral.ai/capabilities/document-understanding/document_annotations) — `document_annotation_format` parameter accepts a JSON Schema. The model fills the schema for the whole document. Lets us request `{title, authors: [{name, superscripts}], affiliations: [{tag, text}], abstract}` and get typed data back.
- Both endpoints return per-page markdown alongside the structured output. We keep using the markdown for the body; we add structured data for the cover.

## Track A — Backend OCR cleanup pipeline

### Goal

Every cleanup heuristic that currently lives in `MarkdownReader.tsx` becomes a function in a new module `backend/app/services/ocr_cleanup.py`. The pipeline runs once per OCR and the cleaned markdown is what we persist as `page_markdown` and `markdown` on the paper row. The frontend reader gets a single string; no further processing.

### Acceptance criteria

- New `backend/app/services/ocr_cleanup.py` exposes one public function:
  ```python
  def clean_ocr_markdown(
      raw_pages: list[str],
      ocr_images: list[OcrImage],
  ) -> tuple[list[str], str]:
      """Apply all cleanup heuristics; return (cleaned_page_markdown, joined_markdown)."""
  ```
- Internally, `clean_ocr_markdown` runs (in order):
  1. `strip_running_headers_footers(pages)` — same algorithm as the client (lines appearing on ≥50% of pages near top/bottom are dropped). Threshold: `max(2, ceil(len(pages) * 0.5))`.
  2. `strip_page_number_footers(text)` — drop journal copyright lines (`^\S+\s+\d{4}[-/]\d{4}\/\d.*©\s+\d{4}.*Society` and `©\s*\d{4}.+Society`) and duplicated page-id pairs (`^[\d-]{3,}\s+[\d-]{3,}$` with `\d-\d`).
  3. `strip_ocr_ascii_fallback(text)` — same length-based heuristic (lines ≤5 chars excluding markdown chrome, cluster threshold ≥3, 2-line case requires prefix match against next non-blank line, drop joins surrounding paragraphs). Run **twice** to catch stacks revealed by removing display-math blocks. Port from `MarkdownReader.tsx` `stripOcrAsciiFallback`.
  4. `dedupe_inline_math_duplicates(text)` — regex pass that finds `$X$ X` patterns and removes the trailing ASCII duplicate. Normalize LaTeX (strip `\mathrm{}`, `\text{}`, all `\[a-z]+` macros, whitespace, braces, `%` / `$` symbols) before comparing. Port from `MarkdownReader.tsx` `dedupeInlineMathDuplicates`.
  5. `collapse_fragmented_math_paragraphs(text)` — merge consecutive `$x$`-only paragraphs into a single line. Port from client.
  6. `collapse_author_byline(text)` — convert affiliation marker clusters following each name into `<sup>1,2</sup>`. The cluster matcher allows any short (≤8 char) digits-or-punctuation line; at least one line in the cluster must contain a digit. Port from client.
  7. `wrap_byline_paragraph(text)` — wrap the post-title paragraph in `<p class="reader-byline">…</p>` if it contains comma/asterisk/dagger characters. Port from client.
  8. `drop_orphan_figure_refs(text)` — for each `![figure](*.png)` line, look ahead up to 6 non-blank lines for a `Fig. N.` caption; drop the line if none found. Port from client.
  9. `drop_panel_refs_when_composites_exist(text)` — if any `fig-N.png` exists in the markdown, drop every line containing a `p\d+-img-\d+\.png` ref. Port from client.
- The cleaned `page_markdown` is what `run_mistral_ocr` returns and `_apply` writes into the paper row.
- All existing tests in `backend/tests/test_ocr_mistral.py` still pass. Add a new `backend/tests/test_ocr_cleanup.py` covering each cleanup step plus an end-to-end golden test against a synthetic OCR payload that mirrors the actual Mistral output shape (see "Test fixtures" below).
- The `MarkdownReader.tsx` cleanup functions are **deleted**. The reader's `load()` becomes:
  ```ts
  const rawPages = payload.page_markdown?.length ? payload.page_markdown : [payload.markdown ?? ""];
  let joined = rawPages.join("\n\n");
  joined = rewriteOcrImageReferences(joined, paperId, trial); // only step left
  setBody(joined);
  ```

### Implementation notes

- Keep each cleanup function pure (string → string or list-string → list-string). Don't share state across functions; the pipeline composes them.
- The Python ports should match the JS algorithms **exactly** — same regexes (translated to Python `re`), same thresholds, same edge cases (e.g. `dropClusterAndJoin` removes trailing blanks from `out` AND skips blanks after the cluster). Cross-check with `MarkdownReader.tsx` line-by-line.
- Unicode handling: Python `\p{L}\p{N}\p{M}` etc. need the `regex` package OR equivalent character class — install `regex` and use it for the ASCII-fallback check. (`re` doesn't support `\p{}`.)
- The HTML `<p class="reader-byline">` and `<sup>` tags need to survive through the markdown parser. They already do — `Streamdown.allowedTags` includes `p: ["class"]` and `sup`.

### Test fixtures

Add `backend/tests/fixtures/ocr_messy_payload.json` with a synthetic Mistral OCR response that includes:
- A title and author byline with `1\n,\n2\n1,2\n, Next Author` style affiliation digits.
- An equation rendered as both `$\nu_c(\hat r, \hat r') = 1/|\hat r - \hat r'|.$` AND a glyph-per-paragraph stack (`\nν\nc\n(\nr̂\n,…`).
- Inline `$52.7\%$ 52.7%` duplication.
- A running header on every page (`VOLUME 90, NUMBER 7 PHYSICAL REVIEW LETTERS`).
- A journal footer with copyright.
- A panel image followed by a `Fig. 1.` caption (legitimate).
- A panel image without any nearby caption (orphan).
- A composite figure (`fig-1.png`) alongside two panel ids on the same page.

The end-to-end test asserts:
- The byline collapses to one paragraph with `<sup>` markers.
- The math glyph stack is gone; the LaTeX form remains.
- The inline duplicate `52.7%` after `$52.7\%$` is removed.
- The running header appears nowhere.
- The journal footer is gone.
- The orphan figure ref is removed; the captioned one survives.
- The panel ids alongside `fig-1.png` are removed; `fig-1.png` survives.

### Files to touch

| File | Change |
|---|---|
| `backend/app/services/ocr_cleanup.py` | NEW. All cleanup functions + `clean_ocr_markdown`. |
| `backend/app/services/ocr_mistral.py` | After `apply_composite_figures`, call `clean_ocr_markdown` on `(page_markdown, manifest)`. Return cleaned `page_markdown` and `markdown` on `OcrResult`. |
| `backend/tests/test_ocr_cleanup.py` | NEW. Unit tests per function + end-to-end golden. |
| `backend/tests/fixtures/ocr_messy_payload.json` | NEW. Synthetic fixture. |
| `backend/requirements.txt` | Add `regex` (Unicode property classes). |
| `frontend/src/components/reader/MarkdownReader.tsx` | DELETE all cleanup helpers; keep only `rewriteOcrImageReferences` and the post-render DOM tagger for figure captions and active-analysis highlight. Read `body = page_markdown.join("\n\n")` straight through. |

### Backfill

Add `backend/app/scripts/ocr_cleanup_backfill.py`:
- Walks every paper with `ocr_status = "ready"`.
- Re-applies `clean_ocr_markdown` to the cached `page_markdown` (no Mistral API call).
- Updates the paper row in place.
- Supports `--dry-run`, `--limit`, `--user-id` flags, mirroring `composite_figures_backfill.py`.

## Track B — Structured front-matter via `document_annotation_format`

### Goal

Get **typed** title / authors / affiliations / abstract from Mistral instead of recovering them from prose. The reader uses this structured data to render a clean cover (title, byline with affiliation popovers, abstract). When the structured call fails or the model returns garbage, we fall back to whatever `wrap_byline_paragraph` produced (Track A's heuristic is still there as a safety net).

### Acceptance criteria

- Mistral OCR call sends `document_annotation_format` with a JSON Schema:
  ```python
  FRONT_MATTER_SCHEMA = {
      "type": "object",
      "additionalProperties": False,
      "required": ["title", "authors", "affiliations"],
      "properties": {
          "title": {"type": "string"},
          "venue": {"type": "string", "description": "Journal/conference name and year, if visible."},
          "doi": {"type": "string"},
          "authors": {
              "type": "array",
              "items": {
                  "type": "object",
                  "additionalProperties": False,
                  "required": ["name"],
                  "properties": {
                      "name": {"type": "string"},
                      "superscripts": {
                          "type": "array",
                          "items": {"type": "string"},
                          "description": "Affiliation/footnote markers next to the name."
                      },
                      "corresponding": {"type": "boolean"},
                      "email": {"type": "string"}
                  }
              }
          },
          "affiliations": {
              "type": "array",
              "items": {
                  "type": "object",
                  "additionalProperties": False,
                  "required": ["text"],
                  "properties": {
                      "tag": {"type": "string", "description": "Superscript marker e.g. '1' or '†'."},
                      "text": {"type": "string"}
                  }
              }
          },
          "abstract": {"type": "string", "description": "Plain text. Math kept as $...$ inline."}
      }
  }
  ```
- The Mistral request payload becomes:
  ```python
  payload = {
      "model": MISTRAL_OCR_MODEL,
      "document": {"type": "document_url", "document_url": f"data:application/pdf;base64,{encoded}"},
      "include_image_base64": True,
      "image_limit": 200,
      "image_min_size": 80,
      "document_annotation_format": {
          "type": "json_schema",
          "json_schema": {"name": "PaperFrontMatter", "schema": FRONT_MATTER_SCHEMA, "strict": True},
      },
  }
  ```
- The response now includes `document_annotation`; parse and validate it. If parsing fails, log a warning and continue without front-matter (don't fail the OCR).
- Store the parsed front-matter on the paper row. Add a `front_matter` JSON column to `papers` via a new migration `021_paper_front_matter.sql`:
  ```sql
  alter table papers add column if not exists front_matter jsonb;
  ```
- Expose `front_matter` on `ParsedPaper` (`backend/app/models/schemas.py`) and via `/api/papers/{id}/markdown` so the reader can consume it.

### Frontend rendering

- New component `frontend/src/components/reader/PaperFrontMatter.tsx`:
  - Renders the title as a large `<h1>` (existing `.reader-article h1` styling).
  - Renders the byline as a paragraph of `Name<sup>1,2</sup>` separated by `, ` — small/muted styling matches existing `.reader-byline`.
  - Renders the affiliations as a list below the byline, smaller and muted (new `.reader-affiliations` class).
  - Renders the abstract as a leading paragraph with a small uppercase `ABSTRACT` label above it (new `.reader-abstract-label`).
  - Author superscripts are hover tooltips ([base UI Tooltip primitive already in `frontend/src/components/ui/*`]) that show the matching affiliation text.
- `MarkdownReader.tsx`:
  - When `front_matter` is present in the markdown payload, render `<PaperFrontMatter front_matter={...} />` BEFORE the markdown body.
  - **Strip** the title, byline, affiliation, and abstract sections from the markdown body so they don't render twice. Detect by looking for the first H1 + the lines until the first H2/empty-paragraph-followed-by-prose, or by matching the front-matter strings.
  - When `front_matter` is absent or empty, fall back to the Track A heuristic byline (no regression for old papers).

### Acceptance criteria (functional)

- Open the Moiré ferroelectricity paper. The cover renders as:
  - Large title.
  - Author list with hoverable affiliation badges.
  - Affiliation list below the byline (smaller text).
  - "ABSTRACT" label above the abstract paragraph.
  - The body markdown starts at the **introduction**, not at the title again.
- Open the BerkeleyGW paper. Same treatment — title + byline + affiliations + abstract are visually clean.
- Open a paper where Mistral didn't return `document_annotation` for some reason (empty response or schema error). The reader falls back gracefully to the heuristic byline; no crash, no duplicate render.

### Files to touch

| File | Change |
|---|---|
| `backend/supabase/migrations/021_paper_front_matter.sql` | NEW. `front_matter jsonb` column on `papers`. |
| `backend/app/models/schemas.py` | Add `front_matter: dict \| None = None` to `ParsedPaper`. |
| `backend/app/services/ocr_mistral.py` | Add `document_annotation_format` to the request payload. Parse + validate response. Store as `OcrResult.front_matter`. |
| `backend/app/services/db.py` | `update_paper_meta` writes `front_matter`. |
| `backend/app/api/papers.py` | `/api/papers/{id}/markdown` response includes `front_matter`. |
| `frontend/src/lib/api.ts` | Add `front_matter` field on `PaperMarkdownResponse`. |
| `frontend/src/components/reader/PaperFrontMatter.tsx` | NEW. Title + byline + affiliations + abstract component. |
| `frontend/src/components/reader/MarkdownReader.tsx` | Render `<PaperFrontMatter>` above body; strip duplicate front-matter from body. |
| `frontend/src/app/globals.css` | New rules for `.reader-affiliations`, `.reader-abstract-label`. |
| `backend/tests/test_ocr_mistral.py` | New test: front matter is parsed when Mistral returns annotation; absent when it doesn't. |

## Track C — Compositor reliability (smaller scope)

### Goal

Ensure `apply_composite_figures` runs to completion for every paper, not just the ones where every panel rendered successfully. Today: if **any** panel fails to clip via PyMuPDF, the whole page's composites are abandoned and the panel-level refs stay in the markdown. That's why the BerkeleyGW paper shows panel images and the Moiré paper shows composites — a partial PyMuPDF failure tips one paper into the fallback.

### Acceptance criteria

- `apply_composite_figures` writes per-page composites independently. If page N composites all succeed → use composited markdown for page N. If page N has any failure → use original markdown for page N. Don't tip the whole paper into the fallback when one page fails.
- Add structured logging when a composite fails: `logger.warning("composite render failed", paper_id, page, figure_id, panel_ids)`.
- `composite_figures_backfill` becomes idempotent: skip pages that already have composite refs in the cached markdown.
- New flag `--force` on `composite_figures_backfill` to re-run even when composites exist.
- Expose an authenticated endpoint `POST /api/papers/{paper_id}/composites/rerun` so users can trigger this from the Figures panel (UI work is out of scope for this prompt — just wire the endpoint).

### Files to touch

| File | Change |
|---|---|
| `backend/app/services/ocr_mistral.py` | Make `apply_composite_figures` per-page atomic. |
| `backend/app/scripts/composite_figures_backfill.py` | Add `--force` flag + idempotency check. |
| `backend/app/api/papers.py` | `POST /{paper_id}/composites/rerun` endpoint. |

## Track D — Thin the frontend reader

### Goal

After Tracks A and B land, the reader becomes substantially smaller.

### Acceptance criteria

- `frontend/src/components/reader/MarkdownReader.tsx` LOC drops from ~800 to ≤ 350. The only things that should remain:
  - Reading from the store / paper API.
  - Rendering the front-matter component (Track B).
  - Rendering the body markdown via `<Streamdown>`.
  - The selection toolbar wiring (mouseup → `onTextSelected`).
  - The post-render DOM tagger for figure captions and active-analysis highlights (those are runtime DOM concerns, not text cleanup).
  - The image URL rewrite (`p0-img-0.png` → `/api/papers/{id}/ocr-image/...`).
- All cleanup helpers (`stripOcrAsciiFallback`, `dedupeInlineMathDuplicates`, etc.) are **deleted** from the frontend. They live in Python now.
- The dev-server typecheck (`tsc --noEmit`) is clean.

## Cross-cutting requirements

- **Migrations**: 021 must include a `IF NOT EXISTS` guard.
- **Backwards compatibility**: papers ingested before this prompt continue to render. The frontend gracefully handles `front_matter = null` and falls back to the body markdown's existing byline. Backfill scripts let you upgrade old papers in place.
- **No new dependencies on the frontend.** All TypeScript packages stay as they are.
- **One new Python dep**: `regex` (for `\p{}` character classes). Pin to a recent stable version in `backend/requirements.txt`.
- **Performance**: `clean_ocr_markdown` runs in-process during OCR. For a 14-page paper it should complete in < 200ms on the Railway box. Profile with `pytest --profile` against the fixture if in doubt.

## Test plan

### Backend

- `pytest backend/tests/test_ocr_cleanup.py` — every cleanup helper has a unit test.
- `pytest backend/tests/test_ocr_mistral.py` — existing tests still pass; new test for front-matter parsing.
- End-to-end golden test: synthetic Mistral payload → `run_mistral_ocr` → assert cleaned markdown matches a fixture string.
- `python -m app.scripts.ocr_cleanup_backfill --dry-run --limit 5` against a local Supabase mirror — verify it identifies the right papers.

### Frontend

- `npm run lint && npx tsc --noEmit && npm run test`.
- Manual: open Moiré ferroelectricity, BerkeleyGW, and Ismail-Beigi papers. Verify:
  - Title is large and centered.
  - Authors render in a single line with `<sup>` markers.
  - Affiliations list appears below the byline.
  - "ABSTRACT" label appears above the abstract.
  - The body starts at the introduction, not at a duplicate title.
  - Math equations render as KaTeX without ASCII duplicates.
  - Figures show without the "random extra" placeholders.

### Smoke after deploy

- Reopen each paper. The reader should look the same as before (or better) without any client-side delay — the markdown is pre-cleaned on the server.
- Existing in-flight selections continue to highlight after a refresh.
- The `/api/papers/{id}/reading-state` 400 fix from `e1d1a66` is still in place (no regression).

## Out of scope

- Mistral OCR provider migration (we stay on `mistral-ocr-latest`).
- Two-column journal layout in the reader.
- Streaming AI calls (Anthropic / OpenAI) — separate work.
- The `summary-stream` 500 hang — separate ticket. (Worth filing one when we get the Vercel function log.)
- Cross-paper citation linking from the references list.

## Definition of done

- Single feature branch, one PR.
- All three backend changes (cleanup module, document annotations, compositor reliability) and the frontend slimdown ship together.
- `pytest backend/tests/` green.
- `npm run lint && npx tsc --noEmit && npm run test` green.
- `MarkdownReader.tsx` LOC down by at least 400.
- One-shot backfill (`ocr_cleanup_backfill` + `composite_figures_backfill --force`) successfully run against the production database (manual step after merge).
- Visual smoke pass on at least three real papers covers the cleanup + structured front-matter end-to-end.
