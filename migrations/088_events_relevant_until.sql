-- ============================================================================
-- Migration 088: events.relevant_until — generated column for ordering / filtering
--
-- Closes a long-standing pagination bug. Previously the events query did:
--
--   .gte('event_at', now - 3h)
--   .order('event_at', { ascending: true })
--   .range(offset, offset + limit - 1)
--
-- Then a JS post-filter dropped events whose end_time was already past.
-- With small limits, the SQL returned the oldest events in the 3h window
-- (most likely already ended), the JS filter dropped them, and the response
-- was [] despite meta.total reporting many events.
--
-- This column makes the relevance check SQL-native and indexable:
--   relevant_until = CASE
--     WHEN open_window THEN COALESCE(end_time, event_at + 3h)
--     ELSE event_at
--   END
--
-- Semantics match the previous JS filter exactly:
--   - Strict-start events ("movie at 7pm"): relevant until they start
--   - Open-window events ("kitchen open late"): relevant until their
--     end_time, or 3h after start if end_time is null
--
-- Query becomes: WHERE relevant_until >= now() ORDER BY relevant_until ASC
-- — both filter and sort agree on what "soonest relevant" means, so
-- pagination no longer falls into the gap.
--
-- Generated columns require IMMUTABLE expressions. Naively writing
-- `event_at + interval '3 hours'` against a timestamptz is rejected
-- (42P17) — `timestamptz + interval` is STABLE, not IMMUTABLE, because
-- interval arithmetic can depend on session TimeZone for date/month
-- intervals. The standard workaround: round-trip through plain
-- `timestamp` via `AT TIME ZONE 'UTC'`. Both AT TIME ZONE calls and
-- the timestamp + interval in between are IMMUTABLE, so the overall
-- expression qualifies.
--
-- STORED so we can index the column.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS relevant_until timestamptz
  GENERATED ALWAYS AS (
    CASE
      WHEN open_window THEN COALESCE(
        end_time,
        ((event_at AT TIME ZONE 'UTC') + interval '3 hours') AT TIME ZONE 'UTC'
      )
      ELSE event_at
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_events_relevant_until
  ON events(relevant_until);

COMMENT ON COLUMN events.relevant_until IS
  'When this event stops being relevant (start time for strict events, end_time or event_at+3h for open-window events). Generated column; updated automatically when event_at, end_time, or open_window change. Indexed for the WHERE relevant_until >= now() ORDER BY relevant_until ASC query pattern in GET /api/v1/events.';
