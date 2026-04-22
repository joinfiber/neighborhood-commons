-- 063_add_tmdb_id_to_events.sql
--
-- Server-side support for the `tmdb_id` field forward-declared in
-- spec v0.6.0 (CHANGELOG 2026-04-22). The field clusters film-category
-- events across theaters and dates: every showing of the same film
-- shares a tmdb_id (the canonical TMDB identifier from themoviedb.org),
-- and consumers group by tmdb_id to render one card per film with
-- showtimes nested.
--
-- Nullable, no default — most events are not films and leave it null.
-- An index supports the `?tmdb_id=X` filter on GET /events for
-- consumers that want all showings of a specific film server-side.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS tmdb_id text;

CREATE INDEX IF NOT EXISTS idx_events_tmdb_id
  ON events (tmdb_id)
  WHERE tmdb_id IS NOT NULL;
