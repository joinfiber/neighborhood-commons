-- Migration 096: event_category_counts() — category histogram computed in PG.
--
-- GET /meta/categories previously selected every published event's `category`
-- (no limit) and deduped/counted in the Node process — an O(events) transfer per
-- request on an unauthenticated endpoint. This RPC does the GROUP BY in Postgres,
-- returning one row per category. STABLE, SECURITY DEFINER, service-role only.
-- Idempotent.

CREATE OR REPLACE FUNCTION event_category_counts()
RETURNS TABLE(category text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT category, count(*)::bigint
    FROM events
   WHERE status = 'published' AND ended_at IS NULL AND category IS NOT NULL
   GROUP BY category
$$;

REVOKE EXECUTE ON FUNCTION event_category_counts() FROM PUBLIC, authenticated, anon;
