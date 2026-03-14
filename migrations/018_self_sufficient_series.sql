-- Make every series instance self-sufficient by carrying its own recurrence pattern.
-- Previously only instance #1 had the real pattern; instances #2+ had 'none'.
-- This caused every read path to join event_series just to discover recurrence.

UPDATE events e
SET recurrence = es.recurrence
FROM event_series es
WHERE e.series_id = es.id
  AND e.recurrence = 'none'
  AND es.recurrence != 'none';
