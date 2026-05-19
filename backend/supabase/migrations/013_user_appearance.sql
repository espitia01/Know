-- Per-account dashboard background (preset + intensity).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS background_preset TEXT,
  ADD COLUMN IF NOT EXISTS background_opacity REAL;
