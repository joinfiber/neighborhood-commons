-- Migration 099: series_instance_counts(uuid[]) — per-series instance counts.
--
-- GET /v1/events hydrates each series event's series_instance_count. It did this
-- by SELECTing series_id for EVERY instance row of every series on the page
-- (SELECT series_id WHERE series_id IN (...)) and counting in JS — O(instances)
-- rows per request for long-running daily series. This RPC does the GROUP BY in
-- Postgres and returns one row per series with its count. STABLE, SECURITY
-- DEFINER, service-role only. Idempotent.

CREATE OR REPLACE FUNCTION series_instance_counts(p_series_ids uuid[])
RETURNS TABLE(series_id uuid, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT series_id, count(*)::bigint
    FROM events
   WHERE series_id = ANY(p_series_ids)
   GROUP BY series_id
$$;

REVOKE EXECUTE ON FUNCTION series_instance_counts(uuid[]) FROM PUBLIC, authenticated, anon;
