-- Atomic usage increment: INSERT ... ON CONFLICT DO UPDATE
-- Returns the new count after incrementing.
CREATE OR REPLACE FUNCTION increment_usage(
  p_user_id text,
  p_paper_id text,
  p_action text,
  p_date text
) RETURNS integer
LANGUAGE plpgsql
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

-- Ensure the unique constraint exists for the upsert to work
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_user_paper_action_date_key'
  ) THEN
    ALTER TABLE usage ADD CONSTRAINT usage_user_paper_action_date_key
      UNIQUE (user_id, paper_id, action, date);
  END IF;
END;
$$;

-- Atomic paper count increment (ensure this exists)
CREATE OR REPLACE FUNCTION increment_paper_count(uid text, delta integer)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE users SET paper_count = GREATEST(0, paper_count + delta) WHERE user_id = uid;
END;
$$;

-- Trial cleanup: allow deleting trial papers older than N hours
-- This is called by the background cleanup task
CREATE OR REPLACE FUNCTION cleanup_trial_data(max_age_hours integer DEFAULT 2)
RETURNS integer
LANGUAGE plpgsql
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

-- Trial rate limiting table
CREATE TABLE IF NOT EXISTS trial_rate_limits (
  ip text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (ip)
);

-- Atomic trial rate limit check-and-increment
CREATE OR REPLACE FUNCTION check_trial_rate(
  p_ip text,
  p_max_requests integer DEFAULT 5,
  p_window_seconds integer DEFAULT 3600
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  current_count integer;
BEGIN
  -- Upsert: insert or update, resetting if window expired
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
