-- 011_jsonb_append_rpcs.sql
--
-- Atomic append helpers for cached_analysis JSONB arrays.
--
-- The Python API previously handled selection / Q&A persistence with a
-- read-modify-write of the whole paper row. On papers with large raw_text
-- and cached_analysis blobs this made every selection or Q&A append slow and
-- racy. These RPCs append a single JSONB item server-side and cap the array
-- to the most recent 50 entries, matching pdf_parser.append_capped().

CREATE OR REPLACE FUNCTION append_cached_analysis_item(
    p_paper_id text,
    p_user_id  text,
    p_key      text,
    p_entry    jsonb,
    p_limit    integer DEFAULT 50
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    merged jsonb;
BEGIN
    IF p_paper_id IS NULL OR p_user_id IS NULL OR p_key IS NULL OR p_entry IS NULL THEN
        RETURN false;
    END IF;

    WITH expanded AS (
        SELECT value, ord
        FROM jsonb_array_elements(
            COALESCE(
                (SELECT cached_analysis -> p_key FROM papers WHERE id = p_paper_id AND user_id = p_user_id),
                '[]'::jsonb
            ) || jsonb_build_array(p_entry)
        ) WITH ORDINALITY AS t(value, ord)
    ),
    counted AS (
        SELECT value, ord, count(*) OVER () AS total
        FROM expanded
    )
    SELECT COALESCE(jsonb_agg(value ORDER BY ord), '[]'::jsonb)
      INTO merged
      FROM counted
     WHERE ord > GREATEST(total - GREATEST(p_limit, 1), 0);

    UPDATE papers
       SET cached_analysis = jsonb_set(
           COALESCE(cached_analysis, '{}'::jsonb),
           ARRAY[p_key],
           COALESCE(merged, jsonb_build_array(p_entry)),
           true
       )
     WHERE id = p_paper_id
       AND user_id = p_user_id;

    RETURN FOUND;
END;
$$;


CREATE OR REPLACE FUNCTION append_selection(
    p_paper_id text,
    p_user_id  text,
    p_entry    jsonb
) RETURNS boolean
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
    SELECT append_cached_analysis_item(p_paper_id, p_user_id, 'selections', p_entry, 50);
$$;


CREATE OR REPLACE FUNCTION append_qa_session(
    p_paper_id text,
    p_user_id  text,
    p_entry    jsonb
) RETURNS boolean
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
    SELECT append_cached_analysis_item(p_paper_id, p_user_id, 'qa_sessions', p_entry, 50);
$$;

GRANT EXECUTE ON FUNCTION append_cached_analysis_item(text, text, text, jsonb, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION append_selection(text, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION append_qa_session(text, text, jsonb) TO authenticated, service_role;
