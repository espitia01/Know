-- Per-model daily API call log.
--
-- Tracks the number of API calls each user makes per model per day so that
-- per-model rate limits (e.g. cap Opus to 100/day on Researcher) can be
-- enforced independently of the overall daily total. The table is keyed by
-- (user_id, date, model) so multiple models on the same day each get their
-- own row.
CREATE TABLE IF NOT EXISTS daily_model_usage (
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    date    DATE NOT NULL,
    model   TEXT NOT NULL,
    count   INT  NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date, model)
);

CREATE INDEX IF NOT EXISTS idx_daily_model_usage_user_date
    ON daily_model_usage (user_id, date);

ALTER TABLE daily_model_usage ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'daily_model_usage'
          AND policyname = 'daily_model_usage_own'
    ) THEN
        CREATE POLICY daily_model_usage_own ON daily_model_usage
            FOR ALL USING (user_id = current_setting('app.user_id', true));
    END IF;
END;
$$;

-- Atomic increment: returns the new count for (user, date, model) after bump.
CREATE OR REPLACE FUNCTION increment_daily_model_usage(
    p_user_id text, p_date date, p_model text
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    new_count integer;
BEGIN
    INSERT INTO daily_model_usage (user_id, date, model, count)
    VALUES (p_user_id, p_date, p_model, 1)
    ON CONFLICT (user_id, date, model)
    DO UPDATE SET count = daily_model_usage.count + 1
    RETURNING count INTO new_count;
    RETURN new_count;
END;
$$;
