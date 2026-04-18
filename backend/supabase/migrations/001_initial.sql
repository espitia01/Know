-- 001_initial.sql  –  Know SaaS schema

-- Custom enum for subscription tiers
CREATE TYPE user_tier AS ENUM ('free', 'scholar', 'researcher');

-- ----------------------------------------------------------------
-- users table (keyed by Clerk user_id)
-- ----------------------------------------------------------------
CREATE TABLE users (
    user_id   TEXT PRIMARY KEY,
    email     TEXT,
    stripe_customer_id TEXT,
    tier      user_tier NOT NULL DEFAULT 'free',
    paper_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------
-- papers table (metadata only — raw_text + PDFs stay on disk)
-- ----------------------------------------------------------------
CREATE TABLE papers (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '',
    authors     JSONB NOT NULL DEFAULT '[]',
    folder      TEXT NOT NULL DEFAULT '',
    tags        JSONB NOT NULL DEFAULT '[]',
    notes       JSONB NOT NULL DEFAULT '[]',
    cached_analysis JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_papers_user ON papers(user_id);

-- ----------------------------------------------------------------
-- usage table (for per-paper rate limits on free tier)
-- ----------------------------------------------------------------
CREATE TABLE usage (
    id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id   TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    paper_id  TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    action    TEXT NOT NULL,   -- 'qa', 'selection', 'figure'
    count     INT NOT NULL DEFAULT 1,
    date      DATE NOT NULL DEFAULT CURRENT_DATE,
    UNIQUE (user_id, paper_id, action, date)
);

CREATE INDEX idx_usage_user ON usage(user_id);

-- ----------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------
ALTER TABLE users  ENABLE ROW LEVEL SECURITY;
ALTER TABLE papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage  ENABLE ROW LEVEL SECURITY;

-- Policies: the backend sets `app.user_id` via SET LOCAL per request.
CREATE POLICY users_own  ON users  FOR ALL USING (user_id = current_setting('app.user_id', true));
CREATE POLICY papers_own ON papers FOR ALL USING (user_id = current_setting('app.user_id', true));
CREATE POLICY usage_own  ON usage  FOR ALL USING (user_id = current_setting('app.user_id', true));
