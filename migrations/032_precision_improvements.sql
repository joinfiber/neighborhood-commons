-- ============================================================================
-- Migration 032: Precision Improvements
--
-- 1. Add CHECK constraint on events.category to enforce valid category values
--    at the database level (defense in depth — app validates via Zod, but
--    direct inserts via admin scripts or RPC could bypass application code).
--
-- 2. Add composite index on (status, event_at) for the most common public API
--    query pattern: WHERE status = 'published' ORDER BY event_at.
--    The existing idx_events_published_active filters on ended_at IS NULL,
--    which is no longer used in the primary query path.
--
-- 3. Add index on webhook_deliveries for the retry cron query pattern.
-- ============================================================================

-- Clean up any legacy category values that predate the canonical list.
-- Maps old/non-standard values to the closest valid category.
UPDATE events SET category = 'other'
WHERE category IS NOT NULL
  AND category NOT IN (
    'live_music', 'dj_dance', 'comedy', 'karaoke', 'open_mic',
    'art_gallery', 'film_screening', 'theatre',
    'happy_hour', 'food_drink', 'market_popup',
    'fitness_class', 'sports_rec',
    'workshop_class', 'trivia_games',
    'community', 'spectator', 'other'
  );

-- Set null categories to 'other' so the constraint can be NOT NULL-safe
UPDATE events SET category = 'other' WHERE category IS NULL;

-- Category CHECK constraint: enforce valid values at DB level.
-- Uses a simple IN list matching src/lib/categories.ts EVENT_CATEGORIES keys.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_category_check'
  ) THEN
    ALTER TABLE events ADD CONSTRAINT events_category_check
      CHECK (category IN (
        'live_music', 'dj_dance', 'comedy', 'karaoke', 'open_mic',
        'art_gallery', 'film_screening', 'theatre',
        'happy_hour', 'food_drink', 'market_popup',
        'fitness_class', 'sports_rec',
        'workshop_class', 'trivia_games',
        'community', 'spectator', 'other'
      ));
  END IF;
END $$;

-- Composite index for the primary public API query path:
-- SELECT ... FROM events WHERE status = 'published' AND event_at >= now() ORDER BY event_at
CREATE INDEX IF NOT EXISTS idx_events_status_event_at
  ON events(status, event_at ASC);

-- Webhook retry cron: finds deliveries with status='retrying' and next_retry_at <= now()
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry
  ON webhook_deliveries(next_retry_at)
  WHERE status = 'retrying';

-- Composite index for portal dashboard: events by creator + creation order
CREATE INDEX IF NOT EXISTS idx_events_creator_event_at
  ON events(creator_account_id, event_at DESC);
