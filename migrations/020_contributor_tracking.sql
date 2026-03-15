-- Add contributor tracking columns to the events table.
-- Enables attribution for events arriving via the write API or import (not just portal).

-- How the event entered the system: portal (manual), import (feed), api (external app)
ALTER TABLE events ADD COLUMN IF NOT EXISTS source_method text NOT NULL DEFAULT 'portal';

-- The name of the contributing app or feed source.
-- Portal events: null (derived from portal_accounts.business_name at response time).
-- API events: the contributor app name (from api_keys.name).
-- Import events: the feed source name (e.g., "eventbrite", "ical:venue-name").
ALTER TABLE events ADD COLUMN IF NOT EXISTS source_publisher text;

-- For import events: the URL of the source feed. Used for deduplication.
ALTER TABLE events ADD COLUMN IF NOT EXISTS source_feed_url text;

-- For import/API events: the event's ID in the source system.
-- Combined with source_feed_url for dedup.
ALTER TABLE events ADD COLUMN IF NOT EXISTS external_id text;

-- Dedup index: prevent importing the same event twice from the same feed.
-- Partial index — only applies when both columns are non-null.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external_dedup
  ON events (source_feed_url, external_id)
  WHERE source_feed_url IS NOT NULL AND external_id IS NOT NULL;
