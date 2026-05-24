-- 022_db_security_hardening.sql
--
-- Security / integrity hardening from database audit:
--   * Scope vector search to the requesting user (match_paper_chunks)
--   * Atomic cleanup of paper-owned rows on delete
--   * Revoke direct RPC access from authenticated role (service-role only)

-- ----------------------------------------------------------------
-- Vector search: require user_id so cross-tenant chunk leakage is
-- impossible even if a caller passes another user's paper id.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_paper_chunks(
  query_embedding vector(1536),
  p_user_id       text,
  paper_ids       text[],
  match_count     int
)
RETURNS TABLE (
  id text,
  paper_id text,
  chunk_index int,
  section text,
  text text,
  distance float4
)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT id, paper_id, chunk_index, section, text,
         (embedding <=> query_embedding)::float4 AS distance
  FROM paper_chunks
  WHERE p_user_id IS NOT NULL
    AND user_id = p_user_id
    AND paper_id = ANY(paper_ids)
  ORDER BY embedding <=> query_embedding ASC
  LIMIT GREATEST(match_count, 0);
$$;

REVOKE ALL ON FUNCTION match_paper_chunks(vector, text, text[], int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION match_paper_chunks(vector, text, text[], int) TO service_role;

-- Drop the old 3-arg overload if it exists (signature change).
DROP FUNCTION IF EXISTS match_paper_chunks(vector, text[], int);


-- ----------------------------------------------------------------
-- Paper delete: remove dependent rows that lack FK cascades.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION delete_paper_dependents(
  p_paper_id text,
  p_user_id  text
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_paper_id IS NULL OR p_user_id IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM highlights
   WHERE paper_id = p_paper_id AND user_id = p_user_id;

  DELETE FROM paper_chunks
   WHERE paper_id = p_paper_id AND user_id = p_user_id;

  DELETE FROM exports
   WHERE paper_id = p_paper_id AND user_id = p_user_id;

  DELETE FROM paper_reading_state
   WHERE paper_id = p_paper_id AND user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION delete_paper_dependents(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_paper_dependents(text, text) TO service_role;


-- ----------------------------------------------------------------
-- Quota / append RPCs must not be callable by browser JWTs. The app
-- uses the service role exclusively; authenticated grants were
-- defense-in-depth failures waiting to happen.
-- ----------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION check_and_increment_paper_count(text, integer) FROM authenticated;

REVOKE EXECUTE ON FUNCTION reserve_paper_usage(text, text, text, date, integer, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION release_paper_usage(text, text, text, date, integer) FROM authenticated;

REVOKE EXECUTE ON FUNCTION append_cached_analysis_item(text, text, text, jsonb, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION append_selection(text, text, jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION append_qa_session(text, text, jsonb) FROM authenticated;
