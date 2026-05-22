-- 017_reading_state.sql — per-paper last-read position + analysis tab.

CREATE TABLE IF NOT EXISTS paper_reading_state (
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  paper_id    TEXT NOT NULL,
  last_page   INTEGER NOT NULL DEFAULT 1,
  last_tab    TEXT,
  scroll_pct  REAL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, paper_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_reading_state_user
  ON paper_reading_state(user_id, updated_at DESC);

ALTER TABLE paper_reading_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS paper_reading_state_own ON paper_reading_state;
CREATE POLICY paper_reading_state_own ON paper_reading_state FOR ALL
  USING (user_id = current_setting('app.user_id', true));
