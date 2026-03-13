-- 014: Add start_time_required to events
--
-- Tells consumers when to stop showing an event in public browse feeds:
--   true  (default) → hide after start time (trivia at 7:30pm disappears at 7:30)
--   false           → hide after end time (happy hour 4-7pm stays until 7pm)
--
-- If start_time_required = false and no end_time, the consumer decides a fallback
-- (e.g. start + 3h). The API documents this contract; enforcement is consumer-side.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS start_time_required boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN events.start_time_required IS
  'When true, event disappears from browse feeds at start time. When false (open-window events like happy hours), stays visible until end_time.';
