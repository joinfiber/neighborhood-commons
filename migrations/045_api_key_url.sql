-- ============================================================================
-- Migration 045: Add URL field to API keys
-- ============================================================================
-- Allows API key holders to register a website URL for contributor attribution.
-- Displayed as source.contributor.url in event responses.

-- API key: contributor URL
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS url text;

COMMENT ON COLUMN api_keys.url IS
  'Contributor website URL. Displayed in event source.contributor for attribution.';

-- Events: store contributor URL at creation time (avoids join at read time)
ALTER TABLE events ADD COLUMN IF NOT EXISTS source_contributor_url text;

COMMENT ON COLUMN events.source_contributor_url IS
  'URL of the app/tool that contributed this event. Stored at creation, not joined.';
