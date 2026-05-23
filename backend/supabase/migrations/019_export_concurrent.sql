-- Atomic export job creation with concurrent in-flight cap (Prompt 11 hardening).

CREATE OR REPLACE FUNCTION create_export_job_bounded(
    p_user_id   text,
    p_paper_id  text,
    p_format    text,
    p_sections  jsonb,
    p_options   jsonb,
    p_max_active integer
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    active_count integer;
    new_row      exports%ROWTYPE;
BEGIN
    IF p_max_active IS NULL OR p_max_active <= 0 THEN
        RETURN NULL;
    END IF;

    -- Serialize concurrent export creation per user.
    PERFORM pg_advisory_xact_lock(hashtext(p_user_id || ':exports'));

    SELECT count(*)::integer INTO active_count
    FROM exports
    WHERE user_id = p_user_id
      AND status IN ('pending', 'running');

    IF active_count >= p_max_active THEN
        RETURN NULL;
    END IF;

    INSERT INTO exports (user_id, paper_id, format, sections, options, status)
    VALUES (p_user_id, p_paper_id, p_format, p_sections, COALESCE(p_options, '{}'::jsonb), 'pending')
    RETURNING * INTO new_row;

    RETURN row_to_json(new_row)::jsonb;
END;
$$;
