-- 016_paper_chunks.sql — pgvector-backed retrieval chunks (Track D)

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS paper_chunks (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  paper_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  section     TEXT,
  text        TEXT NOT NULL,
  embedding   vector(1536) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paper_chunks_paper ON paper_chunks(paper_id);

CREATE INDEX IF NOT EXISTS idx_paper_chunks_vec ON paper_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

ALTER TABLE paper_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS paper_chunks_own ON paper_chunks;
CREATE POLICY paper_chunks_own ON paper_chunks FOR ALL
  USING (user_id = current_setting('app.user_id', true));

CREATE OR REPLACE FUNCTION match_paper_chunks(
  query_embedding vector(1536),
  paper_ids       text[],
  match_count     int
)
RETURNS TABLE (
  id text,
  paper_id text,
  chunk_index int,
  section text,
  text text,
  distance float4
)
LANGUAGE sql STABLE AS $$
  SELECT id, paper_id, chunk_index, section, text,
         (embedding <=> query_embedding)::float4 AS distance
  FROM paper_chunks
  WHERE paper_id = ANY(paper_ids)
  ORDER BY embedding <=> query_embedding ASC
  LIMIT match_count;
$$;
