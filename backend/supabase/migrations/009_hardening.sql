-- 009_hardening.sql
-- Consolidates the backend-audit hardening work:
--   * atomic `check_and_increment_paper_count` (H4)
--   * explicit `papers.raw_text` column (L1)
--   * model-pref columns on `users` so `settings.py` no longer needs exec_sql (M1)
--   * RLS hardening on `trial_rate_limits` (L4)
--   * `processed_stripe_events` idempotency table for webhook replays (H5)
-- All statements are idempotent so re-running the migration is safe.

-- ----------------------------------------------------------------
-- H4: atomic paper-count reservation
--
-- The Python fallback used to SELECT paper_count, compare in app code, then
-- UPDATE — classic TOCTOU. This function fuses the check + increment into
-- one statement so concurrent uploads can't race past the cap.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_and_increment_paper_count(uid text, max_count integer)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_count integer;
BEGIN
  IF max_count < 0 THEN
    UPDATE users
       SET paper_count = paper_count + 1
     WHERE user_id = uid;
    RETURN FOUND;
  END IF;

  UPDATE users
     SET paper_count = paper_count + 1
   WHERE user_id = uid
     AND paper_count < max_count
  RETURNING paper_count INTO updated_count;

  RETURN updated_count IS NOT NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION check_and_increment_paper_count(text, integer) TO authenticated, service_role;


-- ----------------------------------------------------------------
-- L1: explicit raw_text column on papers
--
-- Previously the Python upsert included `raw_text` and retried without it on
-- failure, meaning a misconfigured schema would silently never persist full
-- text. Declare the column explicitly so the behavior is deterministic.
-- ----------------------------------------------------------------
ALTER TABLE papers ADD COLUMN IF NOT EXISTS raw_text TEXT NOT NULL DEFAULT '';


-- ----------------------------------------------------------------
-- M1: model-pref columns on users
--
-- Ship the columns the `/api/settings` route expected, so the runtime
-- exec_sql self-heal path can be removed from the backend. Callers that
-- don't save prefs just keep using the defaults.
-- ----------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS analysis_model TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS fast_model TEXT;


-- ----------------------------------------------------------------
-- L4: defense-in-depth RLS on trial_rate_limits
--
-- The backend uses the service role, which bypasses RLS, so this is
-- defense-in-depth only. If anyone ever exposes this table via PostgREST
-- with anon/authenticated keys, the policy denies access outright.
-- ----------------------------------------------------------------
ALTER TABLE trial_rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trial_rate_limits_deny_all ON trial_rate_limits;
CREATE POLICY trial_rate_limits_deny_all
  ON trial_rate_limits
  FOR ALL
  USING (false)
  WITH CHECK (false);


-- ----------------------------------------------------------------
-- H5: Stripe webhook idempotency
--
-- Stripe retries deliveries on timeout / 5xx. We persist every event id we
-- finish processing so replays are a no-op. `processed_at` lets an operator
-- prune old rows; we don't prune aggressively because the table is tiny
-- (one row per event) and querying by PK is O(1).
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_stripe_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE processed_stripe_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS processed_stripe_events_deny_all ON processed_stripe_events;
CREATE POLICY processed_stripe_events_deny_all
  ON processed_stripe_events
  FOR ALL
  USING (false)
  WITH CHECK (false);
