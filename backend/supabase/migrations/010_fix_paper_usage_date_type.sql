-- 010_fix_paper_usage_date_type.sql
--
-- Bug fix for 008_usage_reservation.sql.
--
-- `reserve_paper_usage` / `release_paper_usage` declared `p_date text`, but
-- `usage.date` is actually a `DATE` column (see 001_initial.sql). PostgreSQL
-- refuses the implicit text→date coercion inside the INSERT, so every call
-- fails with:
--
--   column "date" is of type date but expression is of type text  (42804)
--
-- Redeclare the functions with `p_date date` so PostgREST coerces the
-- ISO-date string from the Python caller into a real DATE at the boundary.
-- The function body is otherwise identical. Safe to re-run.

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

-- Drop the broken text-variant signatures if they were installed by the
-- buggy 008. No-op if they don't exist. Leaving them in place would let
-- PostgREST resolve ambiguously to the wrong overload on the next call.
DROP FUNCTION IF EXISTS reserve_paper_usage(text, text, text, text, integer, integer);
DROP FUNCTION IF EXISTS release_paper_usage(text, text, text, text, integer);

GRANT EXECUTE ON FUNCTION reserve_paper_usage(text, text, text, date, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION release_paper_usage(text, text, text, date, integer) TO authenticated, service_role;
