-- Backfill base_event_data with start_time, end_time, and event_timezone
-- for existing series. Extracts from the earliest future instance (or most
-- recent past instance if no future events exist).
--
-- This enables the auto-extend cron to maintain these series without
-- needing to fetch a sample event at runtime.
--
-- Safe to re-run: only updates rows where start_time is not yet set.

UPDATE event_series es
SET base_event_data = es.base_event_data
  || jsonb_build_object(
       'start_time', to_char((sample.event_at AT TIME ZONE sample.event_timezone), 'HH24:MI'),
       'end_time', CASE
         WHEN sample.end_time IS NOT NULL
         THEN to_char((sample.end_time AT TIME ZONE sample.event_timezone), 'HH24:MI')
         ELSE null
       END,
       'event_timezone', sample.event_timezone
     )
FROM (
  SELECT DISTINCT ON (e.series_id)
    e.series_id,
    e.event_at,
    e.end_time,
    COALESCE(e.event_timezone, 'America/New_York') AS event_timezone
  FROM events e
  WHERE e.series_id IS NOT NULL
  ORDER BY e.series_id, e.event_at DESC
) sample
WHERE es.id = sample.series_id
  AND (es.base_event_data->>'start_time') IS NULL;
