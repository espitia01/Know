-- 014_deep_analysis.sql — Researcher opt-in for expanded prompt budgets

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deep_analysis_enabled boolean NOT NULL DEFAULT false;
