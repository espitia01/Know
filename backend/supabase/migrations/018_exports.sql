-- Export job queue + per-format daily quotas (Prompt 11).

CREATE TABLE IF NOT EXISTS exports (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  paper_id      TEXT NOT NULL,
  format        TEXT NOT NULL CHECK (format IN ('pdf', 'pptx', 'podcast')),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')) DEFAULT 'pending',
  sections      JSONB NOT NULL DEFAULT '[]'::jsonb,
  options       JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_path  TEXT,
  byte_size     BIGINT,
  duration_s    REAL,
  error_code    TEXT,
  error_message TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_exports_user_recent
  ON exports(user_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_exports_user_active
  ON exports(user_id, status)
  WHERE status IN ('pending', 'running');

ALTER TABLE exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exports_own ON exports;
CREATE POLICY exports_own ON exports FOR ALL
  USING (user_id = current_setting('app.user_id', true));

-- Per-format daily export counters (mirrors daily_api_usage shape).
CREATE TABLE IF NOT EXISTS daily_export_usage (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  date    DATE NOT NULL,
  format  TEXT NOT NULL CHECK (format IN ('pdf', 'pptx', 'podcast')),
  count   INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date, format)
);

CREATE INDEX IF NOT EXISTS idx_daily_export_usage_user_date
  ON daily_export_usage (user_id, date);

ALTER TABLE daily_export_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS daily_export_usage_own ON daily_export_usage;
CREATE POLICY daily_export_usage_own ON daily_export_usage FOR ALL
  USING (user_id = current_setting('app.user_id', true));

CREATE OR REPLACE FUNCTION reserve_daily_export_usage(
    p_user_id text,
    p_date    date,
    p_format  text,
    p_delta   integer,
    p_max     integer
) RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    new_count integer;
BEGIN
    IF p_delta IS NULL OR p_delta <= 0 THEN
        RETURN 0;
    END IF;
    IF p_max = 0 THEN
        RETURN -1;
    END IF;
    IF p_max > 0 AND p_delta > p_max THEN
        RETURN -1;
    END IF;

    IF p_max < 0 THEN
        INSERT INTO daily_export_usage (user_id, date, format, count)
        VALUES (p_user_id, p_date, p_format, p_delta)
        ON CONFLICT (user_id, date, format)
        DO UPDATE SET count = daily_export_usage.count + p_delta
        RETURNING count INTO new_count;
        RETURN new_count;
    END IF;

    INSERT INTO daily_export_usage (user_id, date, format, count)
    VALUES (p_user_id, p_date, p_format, p_delta)
    ON CONFLICT (user_id, date, format)
    DO UPDATE SET count = daily_export_usage.count + p_delta
        WHERE daily_export_usage.count + p_delta <= p_max
    RETURNING count INTO new_count;

    IF new_count IS NULL THEN
        RETURN -1;
    END IF;
    RETURN new_count;
END;
$$;

CREATE OR REPLACE FUNCTION release_daily_export_usage(
    p_user_id text,
    p_date    date,
    p_format  text,
    p_delta   integer
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_delta IS NULL OR p_delta <= 0 THEN
        RETURN;
    END IF;
    UPDATE daily_export_usage
    SET count = GREATEST(0, count - p_delta)
    WHERE user_id = p_user_id AND date = p_date AND format = p_format;
END;
$$;
