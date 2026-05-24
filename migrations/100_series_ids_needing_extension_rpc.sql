-- Migration 100: series_ids_needing_extension(threshold, limit) — batch the
-- auto-extend cron.
--
-- autoExtendSeries() loaded EVERY active series (no limit) and probed each one's
-- last instance in a sequential loop — an unbounded, lengthening cron run as the
-- series count grows, risking platform request timeouts and half-finished runs.
-- This RPC returns only series that actually need extension (no instance beyond
-- the refill threshold), capped to a batch. The filter is self-correcting: an
-- extended series gains instances past the threshold and drops out of the next
-- run, so repeated runs drain any backlog without a stateful cursor. The
-- predicate (no instance with event_at > threshold) mirrors the cron's existing
-- per-series check (lastEvent.event_at > refillThreshold => skip). STABLE,
-- SECURITY DEFINER, service-role only. Idempotent.

CREATE OR REPLACE FUNCTION series_ids_needing_extension(p_threshold timestamptz, p_limit int)
RETURNS TABLE(id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT s.id
    FROM event_series s
   WHERE (s.ends_at IS NULL OR s.ends_at > now())
     AND NOT EXISTS (
       SELECT 1 FROM events e
        WHERE e.series_id = s.id AND e.event_at > p_threshold
     )
   ORDER BY s.id
   LIMIT p_limit
$$;

REVOKE EXECUTE ON FUNCTION series_ids_needing_extension(timestamptz, int) FROM PUBLIC, authenticated, anon;
