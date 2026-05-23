# Replace PDF.js reader with a Mistral-OCR markdown reader

## Goal

Stop rendering the original PDF as the primary reading surface. Run every uploaded
PDF through **Mistral OCR** (`mistral-ocr-latest`) at upload time, persist the
resulting Markdown + extracted images, and render that Markdown in a clean
typographic reader using **`streamdown`** (Vercel). The Markdown is also the text
we send to all LLM providers (Anthropic + OpenAI) so providers see exactly what
the user sees. Keep the original PDF as a "View original" fallback link.

Be careful — this rewires the upload pipeline, the reader UI, highlights, and
LLM prompt inputs. Stage the work in phases and don't break the existing flow on
papers that don't have OCR yet.

## Architectural ground rules (workspace rules — must follow)

Read these before writing code:

- `.cursor/rules/architecture.mdc` — streaming LLM calls live on Next.js/Vercel,
  batch LLM/OCR calls live on Python FastAPI. **Mistral OCR runs on Python**,
  called from the upload path. Anthropic/OpenAI keys stay where they are.
- `.cursor/rules/latex.mdc` — the migrated analysis paths (selection-stream,
  summary-stream, figure-qa-stream, Q&A) use structured `ContentBlock[]` and
  must NOT contain `$` in `prose.markdown`. **The paper-reader Markdown is a
  separate path** — Mistral output contains `$...$` LaTeX and that is fine: it
  is the source document, not an LLM analysis. Render with KaTeX inside
  `streamdown`. Do NOT touch `RichContent` / `StreamingMarkdown` for this work.
- `.cursor/rules/analysis-pane.mdc` — analysis pane primitives unchanged.

## Mistral OCR API contract

```
POST https://api.mistral.ai/v1/ocr
Authorization: Bearer ${MISTRAL_API_KEY}
Content-Type: application/json

{
  "model": "mistral-ocr-latest",
  "document": { "type": "document_base64", "document_base64": "<BASE64 PDF>" },
  "include_image_base64": true,
  "image_limit": 200,
  "image_min_size": 80
}
```

Response shape (only the fields we need):

```
{
  "pages": [
    {
      "index": 0,
      "markdown": "## Section 1\n\n... ![img-0.png](img-0.png) ...",
      "images": [
        {
          "id": "img-0.png",
          "top_left_x": 123, "top_left_y": 456,
          "bottom_right_x": 789, "bottom_right_y": 1011,
          "image_base64": "iVBOR..."
        }
      ],
      "dimensions": { "dpi": 200, "height": 2200, "width": 1700 }
    }
  ],
  "usage_info": { "pages_processed": 14, "doc_size_bytes": 2123456 }
}
```

Notes:
- Image filenames in the Markdown body match `images[].id` per page — we must
  rewrite them to a stable per-paper path before persisting.
- Page limit: cap at the existing `MAX_PAGES = 500` in `pdf_parser.py`.
- Cost target: ~$1 per 1000 pages → ≤ $0.50 per paper.

## Data model

Update `backend/app/models/schemas.py` `ParsedPaper`:

```python
class OcrImage(BaseModel):
    id: str         # "p3-img-1.png"
    page: int
    bbox: list[float] | None = None  # [x0, y0, x1, y1] in page pixels
    caption: str = ""

class ParsedPaper(BaseModel):
    # existing fields ...
    raw_text: str = ""              # keep for embeddings + back-compat
    markdown: str = ""              # NEW — joined OCR markdown, all pages
    page_markdown: list[str] = []   # NEW — per-page for scroll / page nav
    ocr_images: list[OcrImage] = [] # NEW — image manifest from OCR
    ocr_status: str = "pending"     # NEW — pending | ready | failed | unsupported
    ocr_model: str = ""             # NEW — "mistral-ocr-2505" etc.
```

Persist these in Supabase. Add a migration
`backend/supabase/migrations/020_ocr_markdown.sql`:

```sql
ALTER TABLE papers
  ADD COLUMN IF NOT EXISTS markdown      TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS page_markdown JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS ocr_images    JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS ocr_status    TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS ocr_model     TEXT NOT NULL DEFAULT '';
```

Storage layout (Supabase Storage + local disk mirror, mirroring how figures
already live under `papers/{paper_id}/figures/`):

```
papers/{paper_id}/ocr/p{N}-img-{k}.png   # decoded OCR image bytes
```

## Backend changes

### 1. Mistral OCR service

Create `backend/app/services/ocr_mistral.py`. Public surface:

```python
async def run_mistral_ocr(pdf_bytes: bytes, paper_id: str, user_id: str | None) -> OcrResult
```

Where `OcrResult` carries `markdown: str`, `page_markdown: list[str]`,
`images: list[OcrImage]`, `model: str`. Inside:

- Build the JSON body with base64-encoded PDF (PDFs over ~20 MB are already
  refused upstream; we cap upload at 50 MB so base64 is acceptable).
- `httpx.AsyncClient(timeout=300)` — OCR on 50-page docs can take a minute.
- For each page: decode `image_base64`, save bytes to
  `settings.papers_dir / paper_id / "ocr" / f"p{page.index}-img-{k}.png"`,
  rewrite the in-line image refs in `page.markdown` from `img-0.png` to a
  stable per-paper path that the frontend can fetch
  (`/api/papers/{id}/ocr-image/p{N}-img-{k}.png`).
- Mirror image bytes to Supabase Storage in the background
  (`storage.upload_file`).
- Concatenate pages with `\n\n---\n\n` page separators **only in `markdown`**;
  keep `page_markdown` per-page for scroll-to-page.
- Configuration: read `settings.mistral_api_key` from
  `backend/app/config.py` (add to `Settings`). If missing, raise so the upload
  path can fall back to PyMuPDF text and mark `ocr_status="unsupported"`.

Add `mistral_api_key` to `backend/app/config.py` and `backend/.env.example`.

### 2. Upload pipeline

`backend/app/api/papers.py` (`upload_paper`, around line 130):

After `extract_pdf` runs (we still want the PyMuPDF text as a fallback and for
embeddings):

```python
ocr = None
try:
    ocr = await asyncio.wait_for(
        run_mistral_ocr(content, paper_id, user_id),
        timeout=180,
    )
except Exception as e:
    logger.warning("Mistral OCR failed for %s: %s", paper_id, e)

paper = ParsedPaper(
    id=paper_id,
    title=meta.get("title") or filename.replace(".pdf", "") or paper_id,
    authors=meta.get("authors", []),
    raw_text=raw.raw_text,
    figures=raw.figures,
    markdown=ocr.markdown if ocr else "",
    page_markdown=ocr.page_markdown if ocr else [],
    ocr_images=ocr.images if ocr else [],
    ocr_status="ready" if ocr else "failed",
    ocr_model=ocr.model if ocr else "",
)
```

Same change in `backend/app/main.py` around the trial upload (line ~410). For
the anonymous trial flow keep OCR enabled (cost is bounded by trial rate limit).

### 3. New endpoints

`backend/app/api/papers.py`:

```python
@router.get("/{paper_id}/markdown")
async def get_paper_markdown(paper_id: str, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(404, "Paper not found")
    return {
        "markdown": paper.markdown,
        "page_markdown": paper.page_markdown,
        "images": [i.model_dump() for i in paper.ocr_images],
        "ocr_status": paper.ocr_status,
    }

@router.get("/{paper_id}/ocr-image/{image_id}")
async def get_paper_ocr_image(paper_id: str, image_id: str, user_id: str = Depends(require_auth)):
    # mirror get_figure logic: disk first, Supabase storage second; basename
    # sanitization to prevent path traversal (image_id must match
    # ^p\d+-img-\d+\.png$).
```

Add the same in the trial router (`backend/app/main.py`).

Also: include `markdown`/`page_markdown` length signals on the `/papers/{id}`
response so the frontend knows whether to render the markdown reader or the
PDF.js fallback. The existing `response_model_exclude={"raw_text"}` should
expand to also exclude `markdown` and `page_markdown` (they're large), but the
client fetches them via `/markdown` separately.

### 4. Feed Markdown to LLMs

This is the core promise: providers see what users see. In every call site that
today uses `paper.raw_text`, prefer `paper.markdown` when non-empty, fall back
to `paper.raw_text`. Add a helper in `backend/app/services/pdf_parser.py`:

```python
def paper_prompt_text(paper: ParsedPaper) -> str:
    """Text the LLM should see — Markdown if OCR succeeded, raw text otherwise."""
    return paper.markdown.strip() or paper.raw_text or ""
```

Replace all `paper.raw_text` consumers in `backend/app/api/analysis.py`,
`backend/app/api/search.py`, `backend/app/api/internal.py`,
`backend/app/main.py`, `backend/app/services/llm.py` (the
`generate_podcast_script` builder) and the export content builder to use
`paper_prompt_text(paper)` instead. **Exception**: embeddings keep using
`raw_text` (cleaner for chunking — Markdown headers and image refs are noise
for retrieval). Verify by searching for `paper.raw_text` and updating each
non-embedding call site.

### 5. Backfill script

`backend/app/scripts/ocr_backfill.py`: walk papers where `ocr_status != 'ready'`
in batches, run `run_mistral_ocr` against the stored PDF (local or
Supabase-downloaded), upsert results. Document running it via Railway shell.

## Frontend changes

### 1. Streamdown setup

```
cd frontend
npm install streamdown
```

`streamdown` already ships with KaTeX, shiki, and mermaid. Per its docs we also
want `@tailwindcss/typography` (already present in the project — confirm in
`frontend/tailwind.config.ts`).

Bundle the KaTeX CSS once in `frontend/src/app/layout.tsx`:

```tsx
import "katex/dist/katex.min.css";
```

### 2. New `MarkdownReader` component

Create `frontend/src/components/reader/MarkdownReader.tsx`. Responsibilities:

- Fetch `/api/papers/{id}/markdown` once per paper (cache in zustand store, key
  `markdownByPaper`).
- Render with `Streamdown` from `"streamdown"`:

```tsx
import { Streamdown } from "streamdown";

<article className="prose prose-neutral dark:prose-invert max-w-3xl mx-auto px-6 py-8 font-display">
  <Streamdown parseIncompleteMarkdown={false}>
    {markdown}
  </Streamdown>
</article>
```

- Rewrite image src on the fly so `![img](p3-img-1.png)` resolves to
  `${API_BASE}/api/papers/${paperId}/ocr-image/p3-img-1.png` with auth headers
  (use a `<img>` component override on Streamdown that proxies via an authed
  fetch + object URL, mirroring the figures cache in `PdfViewer.tsx` lines
  ~588 onwards).
- Text selection: native browser selection. Use the existing
  `onTextSelected(text, rect)` contract from `PdfViewer.tsx` so
  `SelectionToolbar` and the analysis pipeline keep working — listen to
  `selectionchange` on the article and emit when the selection lands inside
  the reader.
- Page nav: render `page_markdown[i]` inside a `<section data-page={i+1}>`
  wrapper so the "Page N of M" indicator and scroll restoration keep working.

### 3. Wire it in alongside `PdfViewer`

`frontend/src/app/paper/[id]/page.tsx` (line ~1745):

- If the paper has `ocr_status === "ready"` and `markdown` length > 0, render
  `<MarkdownReader />`. Otherwise fall back to the existing `<PdfViewer />`.
- Add a small toolbar button in the reader header ("View original PDF") that
  opens `api.getPdfUrl(paperId)` in a new tab (we just changed PDF exports to
  open in a new tab — match that pattern).
- Same change in `frontend/src/app/try/[id]/page.tsx` line ~451.

Keep `PdfViewer.tsx` in the tree — we still need it for the fallback path and
the eventual "show original" view. Don't try to delete it in this PR.

### 4. Highlights re-anchoring

Today highlights are stored two ways:

- `highlights` table: text + color (no geometry) — these work as-is on the
  markdown reader; the existing search/scroll-to-text behavior can match
  substrings inside Streamdown's rendered DOM.
- `pdfRegionHighlightsByPaper`: PDF.js page/x/y coords. **These don't
  translate.** On the markdown reader, hide them and show a one-time banner:
  "Highlights with PDF coordinates were saved for the original PDF view. They
  still appear in the original PDF." Provide a "Re-anchor in markdown" action
  on each that text-searches the saved `selected_text` in the new DOM.

Add a `useReaderHighlights(paperId)` hook in
`frontend/src/components/reader/` that re-anchors highlights by substring
search against the rendered markdown DOM, painting them with a `<mark>` overlay
identical to the Kindle-style underlines already in `PdfViewer`.

### 5. Scanned PDFs

Mistral OCR handles scans. The "scanned PDF" banner (`isScannedPdf` in
`PdfViewer.tsx` line ~552) becomes irrelevant for the markdown reader — drop it
on that path.

## Settings / env

- Add `MISTRAL_API_KEY` to Railway, Vercel preview, and `backend/.env.example`.
- Add a row in `frontend/src/app/settings/page.tsx` (Server tab) showing
  whether OCR is configured — read from `/api/settings` (extend
  `SettingsResponse` with `has_mistral_key: bool`).

## Backwards compat

- Existing papers with `ocr_status != 'ready'` keep using `PdfViewer` and
  `raw_text` for prompts. No regressions.
- New papers always run OCR. If Mistral fails, save the paper with
  `ocr_status="failed"` and fall back to PDF.js — the user sees the original
  PDF and we still serve raw_text to LLMs. Don't block the upload.
- The frontend feature-flags off `ocr_status === "ready" && markdown.length`.

## Tests

Backend (`backend/tests/`):

- `test_ocr_mistral.py` — mock httpx, assert image extraction, markdown image
  ref rewriting, page concat.
- `test_paper_prompt_text.py` — falls back to raw_text when markdown empty.
- Extend `test_paper_excerpt.py` to exercise markdown input.

Frontend:

- Snapshot test on `MarkdownReader` (with KaTeX + image proxy stubbed) under
  `frontend/src/components/reader/__tests__/MarkdownReader.test.tsx`.

## Acceptance criteria

1. Uploading a new PDF triggers a Mistral OCR call; on success the paper row
   has `ocr_status='ready'`, `markdown` populated, and images saved under
   `papers/{id}/ocr/`.
2. Opening that paper renders the markdown reader (not PDF.js). LaTeX renders
   via KaTeX. Tables and images render. Page anchors work.
3. Selecting text inside the markdown reader opens the existing
   `SelectionToolbar` and the existing analysis pipeline works unchanged.
4. Submitting a Q&A or selection-explain on that paper feeds the **Markdown**
   to the LLM (verify via a `provider.complete` log assertion in a test).
5. "View original PDF" opens the raw PDF in a new tab.
6. Papers uploaded before this PR continue to open in `PdfViewer` and continue
   to work end-to-end with `raw_text`.
7. If `MISTRAL_API_KEY` is unset, uploads succeed and fall back to PDF.js
   automatically (`ocr_status='unsupported'`).
8. `backend/tests/` and `frontend` lint/test pass.

## Out of scope (do NOT do here)

- NotebookLM-style streaming podcast player.
- Replacing `PdfViewer.tsx` entirely or deleting it.
- Mistral OCR for selection-level / on-demand calls (this is upload-only).
- Re-anchoring legacy PDF-coord highlights automatically — show the banner,
  don't migrate silently.

## Open decisions for Composer

If any of these are unclear, ask before coding. Defaults in brackets.

1. `streamdown` version pin — [latest 2.x].
2. Image proxy strategy: authed fetch + object URL inside React vs. signed
   short-lived URLs from Supabase Storage — [authed fetch, matches
   `PdfViewer`].
3. Page separator in concatenated `markdown` — [`\n\n---\n\n`].
4. Backfill: run-on-demand background task on first paper open vs. explicit
   script — [explicit script + first-open lazy trigger if not ready].
