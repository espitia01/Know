# Prompt 10 operator runbook

## Supabase migrations

Apply against the Supabase SQL editor (or CLI) in order:

1. `backend/supabase/migrations/017_reading_state.sql` — `paper_reading_state` table + RLS

Verify:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'paper_reading_state';
SELECT polname FROM pg_policy WHERE polrelid = 'paper_reading_state'::regclass;
```

No other schema changes. The Anchored Q&A `sources` field rides along in the
existing `cached_analysis.qa_sessions` JSONB.

## Environment variables

No new variables.

## Smoke tests

### Continue-reading memory (Track B)
- Open a paper, scroll to page 7, click **Summary** tab, close the tab.
- Reopen → lands on page 7 with Summary tab active.
- From a different browser / private window on the same account → also lands on page 7.
- Delete the paper → `paper_reading_state` row is removed.

### Citation graph (Track A)
- Open a paper where Prepare returned a bibliography **and** Cited-by returned citing papers.
- Graph mode (default) renders both arcs. Hover an outbound node → label appears, edge brightens.
- Toggle to **List** → flat references list renders below as before.
- Click an inbound node with a DOI → DOI opens in a new tab.
- Open a paper where Cited-by returned `s2_not_found` → graph shows only the outbound arc.

### Anchored Q&A (Track C)
- With `KNOW_OPENAI_API_KEY` set on Railway, ask a Q&A on a long paper.
- Answer card renders a **Sources** chip footer with 1–6 chips, each showing the section / chunk and the similarity %.
- Click a chip → PDF scrolls to the matching passage and a blue rectangle flashes for ~2 s.
- Cross-paper Q&A in a 3-paper workspace → chips show the source paper title prefix; clicking switches the active paper.
- Without an OpenAI key → chips do not appear, the rest of the panel works normally.

## CI

- `cd frontend && npm run lint && npm run build && npm run test`
- `cd backend && pytest -q tests`

## Rollback

- **Track B** — drop the new table; revert `useReadingState` calls in `PdfViewer` and `BottomPanel`. Local-storage scroll restore still works.
- **Track A** — revert `CitationGraph.tsx` and the toggle block in `RelatedWorkPanel.tsx`; flat list view continues to render.
- **Track C** — the `QAItem.sources` field is additive and clients ignore unknown fields, so a frontend rollback alone is sufficient. Backend persists the field harmlessly in `qa_sessions` JSONB.
