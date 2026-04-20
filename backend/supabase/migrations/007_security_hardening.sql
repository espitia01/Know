-- 007_security_hardening.sql — Address Supabase linter warnings.
--
-- 1. "Function Search Path Mutable" (CVE-class warning):
--    Functions without an explicit `search_path` inherit whatever path the
--    caller has set. If a malicious role inserts a schema earlier on the
--    search_path than `public`, it can shadow built-ins / unqualified names
--    used inside the function body. We pin each function to
--    `public, pg_temp` so name resolution is deterministic.
--
-- 2. "RLS Policy Always True" on `public.feedback`:
--    The original `feedback_insert` policy was `WITH CHECK (true)`, which
--    means any role that reaches the table (e.g. via the anon key) can
--    insert arbitrary rows under arbitrary user_ids. The backend uses the
--    service role (which bypasses RLS), so legitimate traffic is unaffected
--    — but we still want the policy itself to be safe-by-default. We now
--    require the row's `user_id` to match the backend-supplied
--    `app.user_id` session variable.
--
-- Safe to re-run: every change is `CREATE OR REPLACE` or guarded by
-- `DROP POLICY IF EXISTS`.

-- ---------------------------------------------------------------------------
-- 1. Pin search_path on SECURITY-sensitive public functions.
-- ---------------------------------------------------------------------------

-- usage increment (per-paper, per-action)
CREATE OR REPLACE FUNCTION public.increment_usage(
    p_user_id text,
    p_paper_id text,
    p_action text,
    p_date text
) RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    new_count integer;
BEGIN
    INSERT INTO usage (user_id, paper_id, action, date, count)
    VALUES (p_user_id, p_paper_id, p_action, p_date, 1)
    ON CONFLICT (user_id, paper_id, action, date)
    DO UPDATE SET count = usage.count + 1
    RETURNING count INTO new_count;
    RETURN new_count;
END;
$$;

-- paper count increment
CREATE OR REPLACE FUNCTION public.increment_paper_count(uid text, delta integer)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE users SET paper_count = GREATEST(0, paper_count + delta) WHERE user_id = uid;
END;
$$;

-- trial cleanup
CREATE OR REPLACE FUNCTION public.cleanup_trial_data(max_age_hours integer DEFAULT 2)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    deleted_count integer;
BEGIN
    DELETE FROM papers
    WHERE id LIKE 'trial_%'
      AND created_at < NOW() - (max_age_hours || ' hours')::interval;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- trial rate limiter
CREATE OR REPLACE FUNCTION public.check_trial_rate(
    p_ip text,
    p_max_requests integer DEFAULT 5,
    p_window_seconds integer DEFAULT 3600
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    current_count integer;
BEGIN
    INSERT INTO trial_rate_limits (ip, window_start, request_count)
    VALUES (p_ip, now(), 1)
    ON CONFLICT (ip) DO UPDATE SET
        request_count = CASE
            WHEN trial_rate_limits.window_start < now() - (p_window_seconds || ' seconds')::interval
            THEN 1
            ELSE trial_rate_limits.request_count + 1
        END,
        window_start = CASE
            WHEN trial_rate_limits.window_start < now() - (p_window_seconds || ' seconds')::interval
            THEN now()
            ELSE trial_rate_limits.window_start
        END
    RETURNING request_count INTO current_count;

    RETURN current_count <= p_max_requests;
END;
$$;

-- daily overall API usage
CREATE OR REPLACE FUNCTION public.increment_daily_api_usage(p_user_id text, p_date date)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
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

-- per-model daily usage
CREATE OR REPLACE FUNCTION public.increment_daily_model_usage(
    p_user_id text, p_date date, p_model text
) RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
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

-- ---------------------------------------------------------------------------
-- 2. Tighten feedback INSERT policy.
-- ---------------------------------------------------------------------------
-- Original policy allowed WITH CHECK (true). Replace with a policy that
-- requires the row's user_id to match the session-level `app.user_id`
-- variable the backend sets on every authenticated request. Direct anon
-- access (where `app.user_id` is unset) cannot pass this check because
-- `current_setting('app.user_id', true)` returns NULL and `user_id = NULL`
-- is NULL (not true).
DROP POLICY IF EXISTS feedback_insert ON public.feedback;
CREATE POLICY feedback_insert ON public.feedback
    FOR INSERT
    WITH CHECK (user_id = current_setting('app.user_id', true));
