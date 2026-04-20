-- Daily API call log, independent of papers.
--
-- The original `usage` table has a foreign key on `paper_id` with ON DELETE
-- CASCADE, which means deleting a paper wipes its API-call history. That made
-- the settings "API calls today" counter appear to reset whenever users (or
-- automated cleanup) removed papers. This table tracks the daily API usage at
-- the user level only so it survives paper lifecycle events and deployments.
CREATE TABLE IF NOT EXISTS daily_api_usage (
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    date    DATE NOT NULL,
    count   INT  NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_api_usage_user_date
    ON daily_api_usage (user_id, date);

ALTER TABLE daily_api_usage ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'daily_api_usage'
          AND policyname = 'daily_api_usage_own'
    ) THEN
        CREATE POLICY daily_api_usage_own ON daily_api_usage
            FOR ALL USING (user_id = current_setting('app.user_id', true));
    END IF;
END;
$$;

-- Atomic increment: returns the new count for today after incrementing.
CREATE OR REPLACE FUNCTION increment_daily_api_usage(p_user_id text, p_date date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    new_count integer;
BEGIN
    INSERT INTO daily_api_usage (user_id, date, count)
    VALUES (p_user_id, p_date, 1)
    ON CONFLICT (user_id, date)
    DO UPDATE SET count = daily_api_usage.count + 1
    RETURNING count INTO new_count;
    RETURN new_count;
END;
$$;

-- One-time backfill from the existing `usage` table, so users don't see their
-- current day's counter reset when this migration is applied. Safe to re-run.
INSERT INTO daily_api_usage (user_id, date, count)
SELECT user_id, date, SUM(count)::int AS count
FROM usage
GROUP BY user_id, date
ON CONFLICT (user_id, date) DO UPDATE
SET count = GREATEST(daily_api_usage.count, EXCLUDED.count);
