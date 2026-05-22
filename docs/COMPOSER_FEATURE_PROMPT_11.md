# Know — feature briefing #11 for Composer 2.5

> **Scope**: one feature, three output formats. Export the **content of the analysis pane** as a **PDF**, a **PowerPoint**, or a **podcast** (MP3, single academic lecturer — think a graduate-level seminar walkthrough, not a chatty NotebookLM-style two-host banter). The user picks a format and which sections to include (Summary, Q&A, Notes, Highlights, Selection history, Assumptions, Figures, Cross-paper Q&A, Related work). The export is generated server-side, persisted to Supabase Storage, and surfaced as a downloadable artifact in the OverflowMenu.
>
> **This explicitly supersedes** the Prompt-9 carveout that said "no new export surface beyond BibTeX". Notes / PDF export is now in scope. Keep the existing BibTeX export untouched.
>
> **Stack reminders**: Next.js 16 + AI SDK v6 + Zod 4 on Vercel; Python FastAPI on Railway; Supabase Postgres (+ pgvector) + Storage; Upstash Redis. Streaming/structured AI runs in Next route handlers via the AI Gateway. **Batch work — including every export job below — stays on Python.** Tier gating is authoritative in `backend/app/gating.py`. Never duplicate gating logic in TypeScript.
>
> **Rules to read first**:
> - `.cursor/rules/architecture.mdc` (streaming on Next, batch on Python, no local model, HMAC for server → Python, Anthropic via the AI Gateway, prompt caching on system blocks)
> - `.cursor/rules/analysis-pane.mdc` (reuse `OverflowMenu` / data-driven tab strip / `AnalysisSection`-style cards; no new design tokens, motion durations, or shadow vars; analysis-pane host LOC budgets)
> - `.cursor/rules/latex.mdc` (math in `$...$` / `$$...$$` markdown for migrated paths; for export, render math via KaTeX server-side to HTML/PNG — do NOT reintroduce `preprocessLatex` or `remark-math` anywhere new)
>
> **Test plan**: after each track, `cd frontend && npm run lint && npm run build && npm run test`. For backend changes, `cd backend && pytest -q tests`. Manually smoke each format against (a) a short paper with only Summary populated, and (b) a long paper with Summary + Q&A + Notes + Highlights + Figures populated. **Commit per track** with `feat(export-...): ...`. **After all tracks pass**, push `main` to `origin/main`.
>
> **Order**: A → B → C → D. Track A is the shared infra (DB, async job runner, modal shell, history); B/C/D each plug a renderer into that pipeline. Don't try to land B before A — D depends on the same job table.
>
> **What NOT to do**:
> - Don't bundle Chromium / Puppeteer / Playwright. Server-side PDF goes through **WeasyPrint** (already pip-installable on Railway, no headless browser needed). Math renders via `katex` server-rendered HTML; WeasyPrint inlines the result.
> - Don't add new design tokens, motion durations, or shadow vars. The export modal reuses existing primitives.
> - Don't auto-export on tab change. Every export must be a deliberate user click.
> - Don't generate the podcast script + audio on a synchronous request. Use the async `exports` job pattern below.
> - Don't store the user's API keys anywhere — TTS goes through the existing `KNOW_OPENAI_API_KEY` already used for embeddings.
> - Don't return raw bytes from the export endpoints. Always return a signed Supabase URL pointing at the artifact in Storage, valid for 24 h.
> - Don't bypass `_verify_paper_owner` on any new endpoint.

---

## Snapshot of the touched surfaces

| Track | Concern | Primary files |
|---|---|---|
| A | Export job infrastructure | `backend/supabase/migrations/018_exports.sql` (new), `backend/app/services/db.py`, `backend/app/services/exports/__init__.py` (new package), `backend/app/services/exports/jobs.py` (new dispatcher), `backend/app/api/exports.py` (new router), `backend/app/main.py` (mount router), `backend/app/gating.py` (`feature_access("export-*")`, per-format quotas), `frontend/src/components/export/ExportModal.tsx` (new), `frontend/src/components/export/ExportsMenu.tsx` (new submenu inside `OverflowMenu`), `frontend/src/lib/api.ts`, `frontend/src/lib/store.ts` |
| B | PDF renderer | `backend/app/services/exports/pdf_render.py` (new), `backend/requirements.txt` (add `weasyprint`, `Pygments` for code blocks), `backend/app/services/exports/templates/paper_export.html.j2` (new), `backend/app/services/exports/templates/paper_export.css` (new) |
| C | PPTX renderer | `backend/app/services/exports/pptx_render.py` (new), `backend/requirements.txt` (add `python-pptx`), small math-to-PNG helper (KaTeX → headless? no — use `matplotlib.mathtext`, already a transitive dep through PyMuPDF / fitz) |
| D | Podcast (script + TTS) | `backend/app/services/exports/podcast_render.py` (new), `backend/requirements.txt` (add `pydub`; runtime needs `ffmpeg` on Railway — see runbook), `backend/app/services/llm.py` (`generate_podcast_script`), per-format quota row in `gating.py` |

Do not revert: per-paper store slices, `useShallow` selectors, `pendingNavRef` (workspace tab race fix), the migrated streaming routes' Zod schemas, Anthropic prompt caching, deep-analysis 2× multiplier, RAG retrieval, anchored Q&A `sources`, citation graph, continue-reading state, highlights. Everything from Prompts 9 and 10 stays.

---

## Track A — Export job infrastructure

### Goal
A single async pipeline that all three formats use. The frontend POSTs to `/api/papers/{id}/export` with `{ format, sections, options }`, gets back an `export_id`, and polls `/api/exports/{id}` until `status === "completed"`. The response carries a signed Supabase Storage URL for the artifact. Failures are explicit (`status: "failed"` + `error_code`) and never leave a partial file in Storage.

### Implementation

#### A1. Schema

`backend/supabase/migrations/018_exports.sql`:

```sql
CREATE TABLE IF NOT EXISTS exports (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  paper_id      TEXT NOT NULL,
  format        TEXT NOT NULL CHECK (format IN ('pdf', 'pptx', 'podcast')),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')) DEFAULT 'pending',
  sections      JSONB NOT NULL DEFAULT '[]'::jsonb,
  options       JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_path  TEXT,
  byte_size     BIGINT,
  duration_s    REAL,
  error_code    TEXT,
  error_message TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_exports_user_recent
  ON exports(user_id, requested_at DESC);

ALTER TABLE exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exports_own ON exports;
CREATE POLICY exports_own ON exports FOR ALL
  USING (user_id = current_setting('app.user_id', true));
```

Validation:
- `format` ∈ `{"pdf","pptx","podcast"}` — DB-enforced.
- `sections` array of strings, allow-listed in the API layer (same enum as `ALLOWED_READING_TABS` from Prompt 10, plus `"highlights"`).
- `options.podcast.length_minutes` ∈ `{5, 8, 12}`, default `8`. `options.podcast.voice` ∈ the OpenAI voice allow-list (see Track D) — default `"onyx"`. No two-speaker switch; lecturer style is the only style.
- `byte_size` populated on completion so the UI can warn before a 30 MB PPT download.

Storage: artifacts live at `exports/{user_id}/{export_id}.{ext}` in the existing Supabase Storage bucket. Signed URLs returned to the client expire after 24 h (`create_signed_url(path, expires_in=86400)`).

#### A2. Gating

In `backend/app/gating.py`:

- New feature keys: `"export-pdf"`, `"export-pptx"`, `"export-podcast"`.
- Tier rollup:
  - Free: none.
  - Scholar: `export-pdf`, `export-pptx`. Daily quota: 5 PDFs + 3 PPTs.
  - Researcher: all three. Daily quota: 20 PDFs + 10 PPTs + 3 podcasts.
- Deep-analysis users do NOT get a 2× multiplier here — these are end-of-session artifacts, not LLM prompt budgets. Document the carve-out in `get_usage_multiplier`'s docstring.
- Add `reserve_export_usage(user_id, fmt)` that bumps a per-day per-format counter in `users` (or a new lightweight `daily_export_usage` table mirroring `daily_api_usage` shape — pick whichever is consistent with the rest of `db.py`).

Free-tier UX: the modal renders the format option as disabled with an inline "Upgrade to Scholar" link rather than hiding it entirely.

#### A3. Job dispatcher

`backend/app/services/exports/jobs.py`:

```python
async def run_export_job(export_id: str) -> None:
    """Pick up an export row in 'pending' state, dispatch to the right
    renderer, upload the artifact, and mark the row 'completed' or 'failed'.
    Idempotent: a second call on a row in any terminal state is a no-op.
    """
```

The renderer functions return `(bytes, content_type, suggested_filename)`. The dispatcher uploads via `services.storage.upload_file`, populates `storage_path` + `byte_size`, and flips status. Every failure is logged with structured fields `{ export_id, format, error_code }`.

Trigger: from the POST endpoint, schedule with FastAPI `BackgroundTasks` for short formats (PDF/PPT) and via the existing in-process loop for longer ones (podcast). On Railway we already lean on the FastAPI worker for batch jobs — no Celery, no Redis queue. Keep that pattern.

Cap concurrent jobs per user at 2 to keep the queue predictable on the shared instance.

#### A4. API surface

`backend/app/api/exports.py`:

- `POST /api/papers/{paper_id}/export` body `{ format, sections, options? }` → 202, returns `{ export_id }`. Owner-checked. Reserves the per-day export quota up front; on success the renderer can't blow the cap by running anyway.
- `GET /api/exports/{export_id}` → returns the export row plus `download_url` (signed) when `status === "completed"`. Polled by the client at ~2 s intervals while pending.
- `GET /api/exports?limit=20` → user's recent exports for the history submenu.
- `DELETE /api/exports/{export_id}` → cancels a pending job or deletes a completed artifact (both row + Storage object). Returning a completed artifact's URL after deletion is a 404.

All endpoints owner-checked. PUT/PATCH are deliberately absent — exports are immutable artifacts.

#### A5. Frontend

`frontend/src/lib/api.ts`:

```ts
export interface ExportRow {
  id: string;
  paper_id: string;
  format: "pdf" | "pptx" | "podcast";
  status: "pending" | "running" | "completed" | "failed";
  sections: string[];
  storage_path: string | null;
  byte_size: number | null;
  duration_s: number | null;
  error_code: string | null;
  error_message: string | null;
  requested_at: string;
  completed_at: string | null;
  download_url?: string | null;
}

api.requestExport(paperId, body)
api.getExport(exportId)
api.listExports(limit?)
api.deleteExport(exportId)
```

`frontend/src/components/export/ExportModal.tsx`:
- Format radio group (PDF / PPTX / Podcast). Disabled radios for locked tiers, with an inline "Upgrade" link.
- Sections checkboxes — same list as `AnalysisTabs` minus `selection` (selection panel is per-passage; include it as a row called "Selection history" instead).
- Format-specific options block:
  - **PDF**: paper size dropdown (`Letter | A4`, default `Letter`). Include figures toggle (default on). "Compact" toggle that drops large headers (default off).
  - **PPTX**: theme dropdown (`Light | Dark`, default matches current theme). Slide-density toggle (`one section per slide` vs `dense — multiple bullets per slide`, default the first).
  - **Podcast**: voice picker (`Onyx — male, measured` / `Nova — female, warm` / `Alloy — neutral`). Length target (`5 min` / `8 min` / `12 min`, default 8). No "two-host" option — the format is a single academic lecturer.
- Live "estimated size" / "estimated duration" line under the format block. PDF estimate = ~120 KB + 8 KB / included Q&A item + 60 KB / included figure (rough). PPT estimate = ~140 KB / slide. Podcast = the chosen length minutes, plus ~30 s for intro/outro.
- "Generate" button. After click, modal closes; a toast appears with "Export started" and a "View progress" link that opens the Exports submenu inside `OverflowMenu`.

`frontend/src/components/export/ExportsMenu.tsx`:
- Lives inside the existing `OverflowMenu` (don't add a sibling menu — the LOC budget is tight). Renders a list of the user's last 20 exports with their status, format icon, and a download/delete action.
- Polls in-flight jobs (`status` ∈ `{"pending", "running"}`) every 2 s; stops polling on terminal state.
- Auto-shows when a fresh export reaches `completed`: a small unread badge on the overflow trigger until the user opens the menu (reuse the existing badge dot pattern from session-tab notifications).

Store slice in `frontend/src/lib/store.ts`:

```ts
exportsById: Record<string, ExportRow>;
setExport: (row: ExportRow) => void;
removeExport: (id: string) => void;
```

(Plain map keyed by export id; the menu reads + sorts. Don't persist — the list is always cheap to refetch.)

### Acceptance

- POST → row inserted with `status: "pending"`. Polling returns `running` within 1 s, then `completed` with a signed download URL.
- Closing the tab mid-job and reopening shows the in-flight job in the Exports menu and resumes polling.
- Free-tier user clicking "Export" sees the modal with all three formats disabled and an "Upgrade" CTA — no 403 from the backend, just a clean UX.
- Owner check works: requesting `/api/exports/{id}` for someone else's id returns 404.
- Cancelling a completed export deletes both the DB row and the Supabase Storage object.

### Commit
`feat(export): job infrastructure, modal, history menu`

---

## Track B — PDF export

### Goal
A single PDF with a cover page (paper title, authors, export date), table of contents, and one section per chosen tab. Math renders correctly. Figures embed at reasonable resolution. The file opens cleanly in Preview, Adobe Reader, and a browser.

### Implementation

#### B1. Renderer

`backend/app/services/exports/pdf_render.py`:

```python
def render_pdf(export_row: dict, paper: ParsedPaper, cache: dict) -> tuple[bytes, str, str]:
    """Return (pdf_bytes, 'application/pdf', filename)."""
```

Pipeline:

1. Load the analysis cache from `paper.cached_analysis` so we don't rerun LLM calls — every renderer reads from cached_analysis and the per-paper tables (`highlights`, `qa_sessions`, `selections`, `figure_analyses`, etc.). If a section is requested but empty, render a placeholder block ("No notes yet.") rather than skipping silently.
2. Build an HTML document from `paper_export.html.j2` (Jinja2). Each requested section becomes a `<section data-key="...">` block.
3. **Math**: scan the markdown for `$...$` / `$$...$$` and replace each span with the output of `katex.renderToString(tex, { displayMode, output: "html", throwOnError: false })`. Use the `katex` Python package (port) or shell out to a tiny Node helper — pick whichever the repo already has access to (we already ship `katex` on the frontend; a `node` invocation at build time is acceptable on Railway).
4. **Markdown**: use `markdown-it-py` for the rest of the prose. Sanitize the output with `bleach` against the same allow-list `Md.tsx` uses on the frontend, so a malformed model output can't inject HTML.
5. Pipe HTML through `weasyprint.HTML(string=...).write_pdf()` with `paper_export.css` controlling page margins, font sizes, and page-break rules.
6. Embed figures as `<img>` tags pointing at the local figure paths (`get_figure_path`); WeasyPrint inlines them.

Filename: `Know-export-{paper_title-slug}-{YYYYMMDD}.pdf`. Slug truncated at 60 chars.

#### B2. Template

`paper_export.html.j2`:

```html
<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="paper_export.css"></head>
<body>
  <section class="cover">
    <h1>{{ paper.title }}</h1>
    <p class="authors">{{ paper.authors | join(", ") }}</p>
    <p class="meta">Exported from Know · {{ export_date }}</p>
  </section>
  {% if "summary" in sections %}<section data-key="summary">…</section>{% endif %}
  {% if "qa" in sections %}<section data-key="qa">…</section>{% endif %}
  …
</body></html>
```

Each section header gets an explicit `page-break-before: always` so the cover page doesn't share a page with the summary.

#### B3. CSS

`paper_export.css`:

- `@page { size: var(--paper-size, Letter); margin: 2cm; }`
- Body font matches the reader's display family (already shipping `Inter`-like; ship a fallback to system serif since we can't bundle).
- `.katex` from upstream KaTeX styles — copy the minimal subset (display-block centered, inline aligned with baseline) into our CSS rather than pulling the whole stylesheet.
- Print-only rules: no shadows, no glass effects, light theme regardless of frontend toggle.

#### B4. Tests

`backend/tests/test_pdf_export.py`:

- Round-trip a fixture paper with two sections; assert the returned bytes start with `%PDF-`.
- Math span fixture: input markdown contains `$x^2$`, output PDF contains the unicode replacement output by KaTeX (regex on extracted text via `pdftotext` is fine for a smoke check).
- Empty-section fallback fixture.

### Acceptance

- Export a paper with Summary + Q&A → PDF opens, has a clean cover page, math renders.
- Page numbers in the footer; section headers visible at the top of each section's first page.
- File size < 500 KB for a Summary-only export; figures double that.

### Commit
`feat(export-pdf): WeasyPrint renderer with math, figures, and cover page`

---

## Track C — PPTX export

### Goal
A clean PowerPoint deck — cover slide, one slide per selected section, bullet hierarchy that matches the structured data shape (e.g. `key_contributions` becomes one bullet per array entry). Math renders as embedded PNG so it survives PowerPoint's lack of LaTeX support.

### Implementation

#### C1. Renderer

`backend/app/services/exports/pptx_render.py`:

```python
def render_pptx(export_row: dict, paper: ParsedPaper, cache: dict) -> tuple[bytes, str, str]:
```

Pipeline:

1. Use `python-pptx` with a 16:9 layout.
2. Cover slide: paper title (h1), authors (subtitle), "Exported from Know — {date}" footnote.
3. Each section becomes 1–3 slides depending on length:
   - **Summary**: one slide for overview + tl_dr + contributions (bullets), then one slide each for methodology / results / discussion if non-empty.
   - **Q&A**: paginate at ≤5 Q&A pairs per slide.
   - **Notes / Highlights**: paginate at ≤4 entries per slide.
   - **Figures**: one slide per figure (image left, description right).
   - **Assumptions / Selection history / Cross-paper / Related**: 1–2 slides each.
4. **Math**: render each `$...$` / `$$...$$` span to PNG via `matplotlib.mathtext` (it's already a transitive dep through plotting workflows or via PyMuPDF? if not, add `matplotlib` to requirements). Insert as inline image runs. Cache PNGs by tex string in a per-job dict so repeated equations don't re-render.
5. **Theme**: dark or light depending on `options.theme`. Bake a minimal palette — don't pull in the full Tailwind tokens.
6. Slide-density toggle controls the bullet packing.

Filename: `Know-export-{slug}-{YYYYMMDD}.pptx`.

#### C2. Tests

`backend/tests/test_pptx_export.py`:
- Open the returned bytes with `python-pptx` and assert slide count matches expected.
- Cover slide has the paper title.
- Math fixture: math span produces a Picture shape, not a text run with raw LaTeX.

### Acceptance

- Open in PowerPoint, Keynote, and Google Slides — no broken shapes, no missing fonts.
- A 5-Q&A export produces a deck with cover + 1 (or 2) Q&A slides.
- File size < 2 MB for a Summary-only export; figures push it up to ~5 MB for a heavy paper.
- Dark theme exports use light text on dark background everywhere.

### Commit
`feat(export-pptx): python-pptx deck with paginated slides and math PNGs`

---

## Track D — Podcast export

### Goal
A **single-lecturer audio walkthrough** of the paper — voiced as a serious, methodical academic giving a graduate seminar. 5–12 minutes, MP3, downloadable. Think departmental colloquium, not chatty co-host banter. Math is spoken precisely. Claims are grounded in the paper. There is **no second speaker**.

This is the most novel track. Treat it as a small product, not an afterthought.

### Implementation

#### D1. Script generation

`backend/app/services/llm.py::generate_podcast_script`:

```python
async def generate_podcast_script(
    paper: ParsedPaper,
    sections: list[str],
    *,
    target_minutes: int = 8,
    user_id: str | None = None,
) -> list[dict]:  # [{"segment": "intro"|"section:summary"|"section:qa"|...|"outro", "text": "..."}]
```

Note: there is **no `style` parameter and no `speaker` field**. The script is a single continuous monologue, segmented for delivery + stitching purposes only.

Prompt design (system block, prompt-cached):

- Role: "You are scripting a single-speaker ~{target_minutes}-minute audio walkthrough of an academic paper. The narrator is an experienced researcher giving a graduate-level seminar talk. The tone is **precise, calm, and academically rigorous** — closer to a methodical lecturer than a friendly explainer. No co-host, no rhetorical questions to a partner, no 'Yeah, exactly' filler. The narrator is **alone with the listener**."
- Constraints:
  - Output JSON: `{"segments": [{"segment": "...", "text": "..."}]}`. No prose outside the JSON.
  - Total spoken text: `~{target_minutes * 150}` words (humans speak ~150 wpm at lecture cadence). Enforce with a hard reminder mid-prompt.
  - Segment IDs are stable: `"intro"`, `"section:summary"`, `"section:qa"`, `"section:notes"`, `"section:highlights"`, `"section:selection"`, `"section:assumptions"`, `"section:figures"`, `"section:cross"`, `"section:related"`, `"outro"`. Include only the segments whose source data is present.
  - Open (`intro` segment) in ≤ 60 words: name the paper, its authors, the central contribution, and what the listener will learn by the end.
  - Close (`outro` segment) in ≤ 50 words: one paragraph distilling the takeaway.
  - **No LaTeX. No markdown.** Speak math out loud (e.g. "x squared plus y squared equals r squared"). The TTS engine can't read `$...$`.
  - **Tone discipline (anti-NotebookLM clause)**:
    - **Forbidden**: "Yeah", "Right?", "So...", "Basically", "Honestly", "totally", "kind of", "you know", "let's dive in", "deep dive", "wow", any second-person rhetorical question that expects an answer ("Doesn't that blow your mind?"), or any phrase implying a co-host ("we're going to look at", "we both noticed").
    - **Required**: first-person singular when self-referential ("I'll note that..."), or third-person on the paper's authors ("The authors show..."). Hedged precision over breezy confidence: "The reported effect is 0.42; the authors caution it may not generalize beyond the held-out set," not "It's huge — 0.42!"
    - Transitions are quiet: "Turning to the methodology," "On the results," "A subtler point." Not "Now here's where it gets fun."
  - Cover the selected `sections` in **paper-narrative order** (intro → methods → results → discussion → limitations → future work), not in tab-order. If Q&A is included, treat the user's questions as a "Reader questions" segment inserted just before the outro — not woven into the middle.
  - Per-segment length: 40–220 words. Anything longer must be split into two segments with the same ID suffixed `:a`, `:b` (so the TTS step can stitch a tiny breath between them).
- User block: paper title + section-aware excerpt (reuse `build_prepare_excerpt`'s `summary` profile from Prompt 9's TS port; the Python version `build_prepare_excerpt` already exists for the Prepare path — call it directly) + each requested section's cached content.
- Model: `MODEL_ANALYSIS` (Sonnet by default). Don't use Haiku — script quality is the bottleneck. Researcher users with deep analysis enabled get the standard budget here; deep mode does NOT apply because podcast quality is bounded by speaking-time, not prompt context.

Output validation:
- Parse JSON. Drop segments with `text.length < 20` (a too-short segment in a lecture format reads like an interruption).
- Reject and regenerate (one retry) if any forbidden phrase from the tone-discipline list appears, case-insensitive — log a `lint:podcast_forbidden` counter so we can tighten the prompt over time.
- Reject and regenerate if more than 20% of segments start with the same word (avoids the "So, … So, … So, …" failure mode).

#### D2. TTS

`backend/app/services/exports/podcast_render.py`:

- Provider: **OpenAI TTS** via the existing `KNOW_OPENAI_API_KEY` (already used for embeddings). No new env var.
- Model: `tts-1` (faster, $15/1M chars) by default. `tts-1-hd` is exposed only via an internal flag for now — keep the user-facing UI simple.
- Voice: **single voice** for the whole episode, selected by `options.podcast.voice`. Allow-list: `onyx` (default — male, measured), `nova` (female, warm), `alloy` (neutral). All three are reasonable academic-lecturer fits; pick a sensible default per voice's character.
- Speaking-rate prompt hint: prefix each TTS payload with a tiny SSML-style cue inside parens, e.g. `(Pause briefly.)` between sentences when the segment has a hard topic shift. OpenAI's TTS respects natural punctuation reasonably well; lean on em-dashes and full stops for cadence rather than custom markup.
- Cap per-segment input at 4000 chars (OpenAI hard limit). Long segments should already have been split in D1; assert this and fail cleanly if not.

Concurrency: synthesize segments in parallel with `asyncio.gather` (cap at 6 in flight; one voice means no need to interleave). Each call returns MP3 bytes.

#### D3. Stitching

- Use `pydub.AudioSegment` to concatenate the per-segment MP3s.
- Inter-segment silence:
  - Within the same logical section (`:a` → `:b` split): **180 ms**.
  - Between consecutive sections: **450 ms** (a small breath, like a lecturer changing slide).
  - Around `intro` and `outro`: **700 ms** padding on the outer edge.
- Runtime requires `ffmpeg` on PATH. Add a runbook note: Railway nixpacks support ffmpeg via `nixPkgs = ["ffmpeg"]` in `nixpacks.toml`. Document that.
- Normalize loudness with `pydub.effects.normalize(audio)`.
- Export as MP3 at 96 kbps. ~8 min ≈ 5.5 MB; well under Supabase Storage object limits.

Filename: `Know-podcast-{slug}-{YYYYMMDD}.mp3`. Stamp `duration_s` on the export row from `pydub`'s `len(audio) / 1000`.

#### D4. Cost discipline

- Script generation: cached system block + ~6 KB excerpt + ~3 KB output. ≤ $0.05 on Sonnet (single-pass; the regeneration on forbidden-phrase failure is rare in practice).
- TTS: 8 min ≈ 1200 words ≈ 7200 chars → $0.11 on `tts-1`. Researcher daily cap of 3 podcasts → ~$0.50 / user / day max. Acceptable.
- Add a small structured log per podcast finish: `{ export_id, words_total, tts_chars_total, model_tokens_in, model_tokens_out, regenerations }` for back-of-envelope cost tracking and prompt-regression detection.

#### D5. Player

Frontend `ExportsMenu.tsx` renders an inline `<audio controls src={download_url}>` for podcasts in addition to the download button. The audio element loads the signed Storage URL directly — no proxy.

#### D6. Tests

`backend/tests/test_podcast_export.py`:
- Mock the OpenAI TTS call to return a tiny PCM blob; assert pydub stitches them without error.
- Mock the Anthropic call to return a fixed 4-segment JSON; assert the script passes the forbidden-phrase check.
- Inject a fixture script containing "let's dive in" and assert the validator triggers the single retry; on the second mock returning a clean script, assert the regeneration count is logged.
- Skip the actual MP3 binary content assertion (deterministic stitching is fine to validate via byte length thresholds).

### Acceptance

- Pick "Podcast" → 8 min default, default voice (Onyx) → Generate. Job stays in `running` for ~30–60 s. Status flips to `completed` with `duration_s` between 420 and 600 s.
- Played in the in-menu `<audio>` element: **one consistent voice throughout**, no audible glitches at the per-segment boundaries, natural pauses on section changes.
- Script reads as a measured academic lecture: zero filler words from the forbidden list, no rhetorical co-host phrasing, math spoken precisely. Run the validator on the persisted script JSON as a smoke test.
- A user requesting the `nova` voice gets the same script delivered in the alternate voice — not a different script.
- Researcher's daily 3-podcast cap returns a structured 429 with `{ code: "daily_export_cap", limit: 3 }` on the 4th request.
- Without `KNOW_OPENAI_API_KEY`: the modal disables the Podcast radio with a tooltip "Audio synthesis requires the operator to set KNOW_OPENAI_API_KEY".

### Commit
`feat(export-podcast): single-lecturer audio walkthrough via OpenAI TTS`

---

## Wrap-up

After all four tracks land:

1. Write `docs/PROMPT_11_RUNBOOK.md` with:
   - Migration to apply: `018_exports.sql`.
   - New Python deps: `weasyprint`, `python-pptx`, `pydub`, `matplotlib` (only if Track C needs it).
   - Railway: add `ffmpeg` to the nixpacks config (or the equivalent for the deploy method in use).
   - No new env vars; OpenAI key already provisioned for embeddings.
   - Smoke-test checklist mirroring the per-track Acceptance sections.
   - Storage cleanup: rows older than 30 days should be soft-deleted (TTL via a small daily cron — extend the existing trial-cleanup admin endpoint).
   - Rollback notes: drop the table; revert the new endpoint mount; the Storage objects can be left in place since they're scoped to `exports/{user_id}/` and will be auto-purged on user deletion.

2. Run `cd frontend && npm run lint && npm run build && npm run test` and `cd backend && pytest -q tests`. Both must be clean.

3. Verify each format with one short paper and one long paper.

4. Commit `docs(runbook): operator notes for Prompt 11`.

5. Push `main` to `origin/main`.

### What this does not change

- BibTeX export stays as-is.
- Streaming routes / batch routes split unchanged.
- No new env vars; OpenAI key already there.
- Existing analysis-pane LOC budgets remain (the export modal is gated behind a single OverflowMenu item).
- Tier-gating logic stays in `backend/app/gating.py`.
