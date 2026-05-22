-- 015_highlights.sql — Persistent passage highlights

CREATE TABLE IF NOT EXISTS highlights (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  paper_id      TEXT NOT NULL,
  selected_text TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT 'yellow',
  note          TEXT,
  page_hint     INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_highlights_paper ON highlights(paper_id);

ALTER TABLE highlights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS highlights_own ON highlights;
CREATE POLICY highlights_own ON highlights FOR ALL
  USING (user_id = current_setting('app.user_id', true));
