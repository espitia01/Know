# Prompt 11 — Export (PDF / PPTX / Podcast)

## Migration

Apply `backend/supabase/migrations/018_exports.sql` in Supabase SQL editor (or your usual migration pipeline). Creates:

- `exports` — async job rows (status, storage path, byte size, duration for podcasts)
- `daily_export_usage` — per-format daily quotas
- `reserve_daily_export_usage` / `release_daily_export_usage` RPCs

## Python dependencies

Added to `backend/requirements.txt`:

- `weasyprint`, `markdown-it-py`, `bleach`, `latex2mathml`, `Pygments` (PDF)
- `python-pptx`, `matplotlib` (PPTX math PNGs)
- `pydub` (podcast stitching)
- `Jinja2` (PDF template)

## Railway / Docker

`backend/Dockerfile` installs system packages for WeasyPrint (`libpango`, `libgdk-pixbuf`, etc.) and **ffmpeg** for pydub.

No new env vars — podcast TTS uses existing `KNOW_OPENAI_API_KEY`.

## Tier gates (`gating.py`)

| Tier | Formats | Daily caps |
|------|---------|------------|
| Free | none (modal shows upgrade) | — |
| Scholar | PDF, PPTX | 5 PDF, 3 PPTX |
| Researcher | PDF, PPTX, Podcast | 20 PDF, 10 PPTX, 3 podcast |

Deep-analysis 2× multiplier does **not** apply to exports.

## API

- `POST /api/papers/{id}/export` → `{ export_id }` (202)
- `GET /api/exports/{id}` → row + `download_url` when completed (signed 24 h)
- `GET /api/exports?limit=20` → recent history
- `DELETE /api/exports/{id}` → cancel / delete artifact

Artifacts stored at `{user_id}/exports/{export_id}.{ext}` in the `papers` bucket.

## Smoke checklist

1. **Short paper, Summary only** — PDF cover + summary section; PPTX cover + bullets; skip podcast on free tier.
2. **Long paper** — Summary + Q&A + Notes + Highlights + Figures; verify math in PDF, figure images, podcast completes with `duration_s` set.
3. **Free tier** — Export modal shows disabled formats + upgrade link; Generate disabled.
4. **Researcher podcast cap** — 4th podcast in one day returns 429 `{ code: "daily_export_cap" }`.
5. **Mid-job reload** — Exports submenu shows in-flight job and resumes polling.

## Storage TTL

Completed exports older than 30 days can be purged via the extended cleanup path in `/api/internal/admin/cleanup-trial` (also deletes Storage objects under `exports/`).

## Rollback

1. Drop `exports` and `daily_export_usage` tables (and RPCs).
2. Remove `exports_router` mount from `main.py`.
3. Storage objects under `exports/{user_id}/` are harmless; user deletion cascades DB rows.
