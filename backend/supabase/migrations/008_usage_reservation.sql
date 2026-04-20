-- Atomic check-and-increment RPCs for usage caps.
--
-- Prior to this migration, `track_usage()` read the current counter and then
-- wrote the new value in two separate statements. Between read and write, a
-- second concurrent request could finish its own read+write cycle, letting the
-- user exceed the cap by the concurrency factor (TOCTOU race).
--
-- These functions fuse the check and the increment into a single atomic SQL
-- statement using `INSERT ... ON CONFLICT DO UPDATE ... WHERE`. The WHERE
-- predicate is evaluated under row-level locks taken by the upsert, so any
-- concurrent reservation that would push the total past the cap falls through
-- to "no rows affected" and we return -1 to the caller.
--
-- Companion `release_*` functions decrement the counter if the downstream
-- work (e.g. the LLM call) fails, so users aren't debited for calls we never
-- actually made. Releases clamp at zero so a misplaced release can never
-- create negative credit.
--
-- Return contract for each `reserve_*`:
--   * new count (>= 0) on success
--   * -1 when the reservation would exceed the supplied cap
-- The caller is expected to translate -1 into HTTP 429 (daily/model) or 403
-- (per-paper). Pass `p_max = -1` for "unlimited"; the function then never
-- returns -1 and just increments.

-- ---------------------------------------------------------------------------
-- daily_api_usage (account-wide daily total)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reserve_daily_api_usage(
    p_user_id text,
    p_date    date,
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

    -- Explicit "disabled" case: no reservations allowed at all.
    IF p_max = 0 THEN
        RETURN -1;
    END IF;

    -- A single batched request that is itself bigger than the daily cap
    -- cannot possibly succeed, short-circuit.
    IF p_max > 0 AND p_delta > p_max THEN
        RETURN -1;
    END IF;

    IF p_max < 0 THEN
        -- Unlimited tier: always accept.
        INSERT INTO daily_api_usage (user_id, date, count)
        VALUES (p_user_id, p_date, p_delta)
        ON CONFLICT (user_id, date)
        DO UPDATE SET count = daily_api_usage.count + p_delta
        RETURNING count INTO new_count;
        RETURN new_count;
    END IF;

    INSERT INTO daily_api_usage (user_id, date, count)
    VALUES (p_user_id, p_date, p_delta)
    ON CONFLICT (user_id, date)
    DO UPDATE SET count = daily_api_usage.count + p_delta
        WHERE daily_api_usage.count + p_delta <= p_max
    RETURNING count INTO new_count;

    IF new_count IS NULL THEN
        RETURN -1;
    END IF;
    RETURN new_count;
END;
$$;

CREATE OR REPLACE FUNCTION release_daily_api_usage(
    p_user_id text,
    p_date    date,
    p_delta   integer
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_delta IS NULL OR p_delta <= 0 THEN
        RETURN;
    END IF;
    UPDATE daily_api_usage
       SET count = GREATEST(0, count - p_delta)
     WHERE user_id = p_user_id AND date = p_date;
END;
$$;


-- ---------------------------------------------------------------------------
-- daily_model_usage (per-model daily sub-budget)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reserve_daily_model_usage(
    p_user_id text,
    p_date    date,
    p_model   text,
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
        INSERT INTO daily_model_usage (user_id, date, model, count)
        VALUES (p_user_id, p_date, p_model, p_delta)
        ON CONFLICT (user_id, date, model)
        DO UPDATE SET count = daily_model_usage.count + p_delta
        RETURNING count INTO new_count;
        RETURN new_count;
    END IF;

    INSERT INTO daily_model_usage (user_id, date, model, count)
    VALUES (p_user_id, p_date, p_model, p_delta)
    ON CONFLICT (user_id, date, model)
    DO UPDATE SET count = daily_model_usage.count + p_delta
        WHERE daily_model_usage.count + p_delta <= p_max
    RETURNING count INTO new_count;

    IF new_count IS NULL THEN
        RETURN -1;
    END IF;
    RETURN new_count;
END;
$$;

CREATE OR REPLACE FUNCTION release_daily_model_usage(
    p_user_id text,
    p_date    date,
    p_model   text,
    p_delta   integer
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_delta IS NULL OR p_delta <= 0 THEN
        RETURN;
    END IF;
    UPDATE daily_model_usage
       SET count = GREATEST(0, count - p_delta)
     WHERE user_id = p_user_id AND date = p_date AND model = p_model;
END;
$$;


-- ---------------------------------------------------------------------------
-- usage (per-paper per-action daily counter)
-- ---------------------------------------------------------------------------
--
-- `usage.date` is a DATE column (see 001_initial.sql). PostgREST will
-- coerce the ISO-date string sent by the Python caller into DATE at the
-- boundary, so we declare `p_date date` here and let Postgres handle it.
-- (010_fix_paper_usage_date_type.sql retrofits this onto DBs that already
-- installed the earlier buggy text signature.)

CREATE OR REPLACE FUNCTION reserve_paper_usage(
    p_user_id  text,
    p_paper_id text,
    p_action   text,
    p_date     date,
    p_delta    integer,
    p_max      integer
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
        INSERT INTO usage (user_id, paper_id, action, date, count)
        VALUES (p_user_id, p_paper_id, p_action, p_date, p_delta)
        ON CONFLICT (user_id, paper_id, action, date)
        DO UPDATE SET count = usage.count + p_delta
        RETURNING count INTO new_count;
        RETURN new_count;
    END IF;

    INSERT INTO usage (user_id, paper_id, action, date, count)
    VALUES (p_user_id, p_paper_id, p_action, p_date, p_delta)
    ON CONFLICT (user_id, paper_id, action, date)
    DO UPDATE SET count = usage.count + p_delta
        WHERE usage.count + p_delta <= p_max
    RETURNING count INTO new_count;

    IF new_count IS NULL THEN
        RETURN -1;
    END IF;
    RETURN new_count;
END;
$$;

CREATE OR REPLACE FUNCTION release_paper_usage(
    p_user_id  text,
    p_paper_id text,
    p_action   text,
    p_date     date,
    p_delta    integer
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_delta IS NULL OR p_delta <= 0 THEN
        RETURN;
    END IF;
    UPDATE usage
       SET count = GREATEST(0, count - p_delta)
     WHERE user_id = p_user_id
       AND paper_id = p_paper_id
       AND action   = p_action
       AND date     = p_date;
END;
$$;
