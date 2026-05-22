# Prompt 9 operator runbook

## Supabase migrations (apply in order)

Run against your Supabase project SQL editor or via CLI:

1. `backend/supabase/migrations/014_deep_analysis.sql` — `users.deep_analysis_enabled`
2. `backend/supabase/migrations/015_highlights.sql` — `highlights` table + RLS
3. `backend/supabase/migrations/016_paper_chunks.sql` — `pgvector`, `paper_chunks`, `match_paper_chunks` RPC

Verify:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'deep_analysis_enabled';
SELECT * FROM pg_extension WHERE extname = 'vector';
```

## Environment variables

### Railway (Python backend)

| Variable | Required for | Notes |
|---|---|---|
| `KNOW_OPENAI_API_KEY` | Track D RAG | Embeddings only; Q&A falls back without it |
| `KNOW_EMBEDDING_MODEL` | Track D | Default `text-embedding-3-small` |
| `KNOW_EMBEDDING_PROVIDER` | Track D | Default `openai` |

Existing vars unchanged (`KNOW_ANTHROPIC_API_KEY`, Supabase, internal token, etc.).

### Vercel (Next.js)

No new vars. Stream routes read deep-analysis via `/api/internal/user/{id}/preferences`.

## Post-deploy

1. **Embed backfill** (optional, for RAG on existing papers):

   ```bash
   cd backend
   python -m app.scripts.embed_backfill --user-id USER_ID --all
   ```

2. **Smoke tests**
   - Upload a long paper → Summary mentions Methods/Results sections
   - Researcher: toggle Deep analysis in Settings → Summary context doubles
   - Cross-paper stale chip + Rerun when session membership changes
   - Related tab → Cited by section populates (7-day cache)
   - PDF highlight → persists after reload
   - Q&A with OpenAI key configured → retrieval footer / richer answers

3. **CI**
   - `cd frontend && npm run lint && npm run build`
   - `cd backend && pytest -q tests`

## Rollback

- Deep analysis: set `deep_analysis_enabled = false` for all users (column safe to keep)
- Highlights: table is additive; disable UI by reverting frontend
- RAG: omit `KNOW_OPENAI_API_KEY`; system uses head-truncation fallback
- pgvector: do not drop `paper_chunks` in production without backup
