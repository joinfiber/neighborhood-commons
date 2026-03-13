-- 015: Add tags array to events table
-- Experience/setting/access tags from a shared pool, validated at the application layer.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_events_tags ON events USING GIN (tags);

COMMENT ON COLUMN events.tags IS
  'Experience/setting/access tags from the shared pool. Validated per category at the application layer.';
