-- Series horizon: add optional end boundary for bounded series.
-- NULL = ongoing (auto-extended by cron). Set = bounded (no extension past this date).

ALTER TABLE event_series ADD COLUMN IF NOT EXISTS ends_at timestamptz DEFAULT NULL;

-- Index for the auto-extend cron to efficiently find series needing extension
CREATE INDEX IF NOT EXISTS idx_event_series_active
  ON event_series (id) WHERE ends_at IS NULL OR ends_at > now();

COMMENT ON COLUMN event_series.ends_at IS
  'Optional series end boundary. NULL = ongoing (auto-extended by cron). Set = bounded (no extension past this date).';
