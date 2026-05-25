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
--
-- Self-sufficient on event_series.ends_at: that column is added by migration 052,
-- but 052's index used now() in a partial-index predicate (Postgres rejects it as
-- non-IMMUTABLE), so on instances where 052 ran in a transaction the index error
-- rolled back the column add with it — leaving ends_at absent. Ensure it here so
-- this RPC doesn't depend on 052 having landed.

ALTER TABLE event_series ADD COLUMN IF NOT EXISTS ends_at timestamptz DEFAULT NULL;

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
