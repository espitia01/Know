-- 003_workspaces.sql  –  Saved reading sessions

CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    name        TEXT NOT NULL DEFAULT '',
    paper_ids   JSONB NOT NULL DEFAULT '[]',
    cross_paper_results JSONB NOT NULL DEFAULT '[]',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workspaces_user ON workspaces(user_id);

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspaces_own ON workspaces FOR ALL USING (user_id = current_setting('app.user_id', true));
