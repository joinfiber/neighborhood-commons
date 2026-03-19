-- 028: Feed sources for pull-based event ingestion
-- Alongside the newsletter email pipeline (push), this enables polling
-- iCal feeds, RSS feeds, and structured APIs on a schedule.
-- Parsed events flow into the same event_candidates review queue.

CREATE TABLE IF NOT EXISTS feed_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  feed_url text NOT NULL,
  feed_type text DEFAULT 'ical'
    CHECK (feed_type IN ('ical', 'rss', 'eventbrite', 'agile_ticketing')),
  poll_interval_hours int DEFAULT 24,
  status text DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'retired')),
  default_location text,
  default_timezone text DEFAULT 'America/New_York',
  notes text,
  created_at timestamptz DEFAULT now(),
  last_polled_at timestamptz,
  last_poll_result text,
  last_poll_error text,
  last_event_count int
);

ALTER TABLE feed_sources ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS feed_sources_status_idx ON feed_sources(status);

-- Feed-sourced candidates have no email — make email_id nullable
ALTER TABLE event_candidates ALTER COLUMN email_id DROP NOT NULL;

-- Link candidates to their feed source
ALTER TABLE event_candidates
ADD COLUMN IF NOT EXISTS feed_source_id uuid REFERENCES feed_sources(id);

CREATE INDEX IF NOT EXISTS event_candidates_feed_source_id_idx ON event_candidates(feed_source_id);
