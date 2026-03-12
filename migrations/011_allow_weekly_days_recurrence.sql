-- Migration 011: Allow weekly_days recurrence pattern
--
-- The event_series.recurrence column has a CHECK constraint that only allows
-- the original five patterns. This migration replaces it with a broader check
-- that also accepts ordinal_weekday and weekly_days patterns.

ALTER TABLE event_series
  DROP CONSTRAINT IF EXISTS event_series_recurrence_check;

ALTER TABLE event_series
  ADD CONSTRAINT event_series_recurrence_check
  CHECK (
    recurrence ~ '^(none|daily|weekly|biweekly|monthly|ordinal_weekday:[1-5]:(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|weekly_days:(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*)$'
  );
