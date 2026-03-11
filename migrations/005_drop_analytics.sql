-- ============================================================================
-- Migration 005: Drop analytics tables and RPCs
-- ============================================================================
-- Browse counters, dedup tracking, and trending scores were app-specific
-- analytics that don't belong in a public data resource. Consumers track
-- their own engagement metrics.

-- Drop RPC functions first (they reference the tables)
DROP FUNCTION IF EXISTS increment_event_opens(uuid);
DROP FUNCTION IF EXISTS increment_calendar_add(uuid, text);
DROP FUNCTION IF EXISTS increment_event_view_deduped(uuid, text);
DROP FUNCTION IF EXISTS increment_event_interested(uuid, text);
DROP FUNCTION IF EXISTS recompute_trending_score();
DROP FUNCTION IF EXISTS cleanup_browse_dedup();

-- Drop analytics tables
DROP TABLE IF EXISTS browse_event_dedup;
DROP TABLE IF EXISTS event_interested;
DROP TABLE IF EXISTS event_calendar_adds;
DROP TABLE IF EXISTS event_analytics;
