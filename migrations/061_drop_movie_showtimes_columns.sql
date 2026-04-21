-- Migration 061: Drop movie_showtimes columns from events table
-- ============================================================================
--
-- Drops the three columns added by migration 029:
--   - runtime_minutes INTEGER
--   - content_rating  TEXT
--   - showtimes       JSONB
--
-- Rationale
-- ---------
-- Migration 029 added these as a second, parallel data model specifically for
-- film screenings: one events row per movie-venue pair with a JSONB array of
-- showtimes. In practice, no code path writes to these columns — every INSERT
-- sets them to null. They were included in every API response as null noise.
--
-- Film screenings are now modeled the same way every other event is:
--   - one events row per individual screening (one showtime = one row)
--   - category = 'film'
--   - series_id groups same-film showings across a day/venue
--   - rating conveyed via tags (e.g., tag "rating:r" or "rating:pg-13")
--   - runtime conveyed by setting end_time explicitly at ingest
--
-- This matches the Neighborhood API spec (which has no runtime/rating/showtimes
-- fields) and aligns with CLAUDE.md's "don't fork the spec" rule. Fiber's film
-- UI queries events by category='film' and groups client-side.
--
-- Safety guard
-- ------------
-- The DO block below refuses to drop if any row has non-null values in the
-- three columns. This is belt-and-braces: the code confirms no write path
-- exists, but a back-door SQL UPDATE from outside the app could have planted
-- values. If the guard fires, an operator must either:
--   (a) migrate the data manually (split multi-showtime rows into multiple
--       events, move rating to tags, set end_time from runtime), then NULL out
--       the three columns, then re-apply this migration
--   (b) intentionally discard the data by running an explicit
--       UPDATE events SET runtime_minutes=null, content_rating=null, showtimes=null;
--       before re-applying
--
-- The historical CREATE statements from migration 029 are preserved in git
-- history; see that file for the original schema if ingestion ever returns.

DO $$
DECLARE
  v_rt INTEGER;
  v_cr INTEGER;
  v_st INTEGER;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE runtime_minutes IS NOT NULL),
    COUNT(*) FILTER (WHERE content_rating IS NOT NULL),
    COUNT(*) FILTER (WHERE showtimes IS NOT NULL)
  INTO v_rt, v_cr, v_st
  FROM events;

  IF v_rt > 0 OR v_cr > 0 OR v_st > 0 THEN
    RAISE EXCEPTION
      'Migration 061 refused: data present in columns being dropped (runtime_minutes=%, content_rating=%, showtimes=%). See migration header for recovery.',
      v_rt, v_cr, v_st;
  END IF;
END $$;

ALTER TABLE events DROP COLUMN IF EXISTS runtime_minutes;
ALTER TABLE events DROP COLUMN IF EXISTS content_rating;
ALTER TABLE events DROP COLUMN IF EXISTS showtimes;
