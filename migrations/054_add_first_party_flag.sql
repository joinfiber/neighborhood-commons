-- Migration 054: Add first_party flag to events
-- Indicates whether the event was entered by its originator (venue, host, group)
-- vs a third party (scraper, curator, ingestion pipeline).

ALTER TABLE events ADD COLUMN IF NOT EXISTS first_party boolean NOT NULL DEFAULT false;
