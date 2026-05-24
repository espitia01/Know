-- 023_capability_caps.sql
--
-- Shared daily caps by model capability tier (fast / balanced / top) instead of
-- per-model slug counters. Haiku + GPT-5 mini + Mistral Small share one fast
-- budget; Sonnet + GPT-5 + Mistral Medium share balanced; Opus + GPT-5.4 +
-- Mistral Large share top.
--
-- Legacy daily_model_usage is kept for read compatibility; new reservations
-- flow through daily_capability_usage.

CREATE TABLE IF NOT EXISTS daily_capability_usage (
    user_id     text NOT NULL,
    date        date NOT NULL,
    capability  text NOT NULL,
    count       integer NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date, capability)
);

CREATE INDEX IF NOT EXISTS idx_daily_capability_usage_user_date
    ON daily_capability_usage (user_id, date);

ALTER TABLE daily_capability_usage ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'daily_capability_usage'
          AND policyname = 'daily_capability_usage_own'
    ) THEN
        CREATE POLICY daily_capability_usage_own ON daily_capability_usage
            FOR ALL USING (auth.uid()::text = user_id);
    END IF;
END $$;

CREATE OR REPLACE FUNCTION reserve_daily_capability_usage(
    p_user_id     text,
    p_date        date,
    p_capability  text,
    p_delta       integer,
    p_max         integer
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
        INSERT INTO daily_capability_usage (user_id, date, capability, count)
        VALUES (p_user_id, p_date, p_capability, p_delta)
        ON CONFLICT (user_id, date, capability)
        DO UPDATE SET count = daily_capability_usage.count + p_delta
        RETURNING count INTO new_count;
        RETURN new_count;
    END IF;

    INSERT INTO daily_capability_usage (user_id, date, capability, count)
    VALUES (p_user_id, p_date, p_capability, p_delta)
    ON CONFLICT (user_id, date, capability)
    DO UPDATE SET count = daily_capability_usage.count + p_delta
        WHERE daily_capability_usage.count + p_delta <= p_max
    RETURNING count INTO new_count;

    IF new_count IS NULL THEN
        RETURN -1;
    END IF;
    RETURN new_count;
END;
$$;

CREATE OR REPLACE FUNCTION release_daily_capability_usage(
    p_user_id     text,
    p_date        date,
    p_capability  text,
    p_delta       integer
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_delta IS NULL OR p_delta <= 0 THEN
        RETURN;
    END IF;
    UPDATE daily_capability_usage
       SET count = GREATEST(0, count - p_delta)
     WHERE user_id = p_user_id
       AND date = p_date
       AND capability = p_capability;
END;
$$;
