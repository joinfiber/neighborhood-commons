-- Migration 029: Movie showtimes support
--
-- Adds first-class support for movie showtimes (film_screening events).
-- Data model: one row per movie-venue pair, with a JSONB array of showtime objects.
-- series_id links rows for the same movie across different venues.
--
-- runtime_minutes: movie length (e.g., 135 for 2h 15m). Nullable.
-- content_rating: MPAA or equivalent (e.g., "PG-13", "R", "NR"). Nullable.
-- showtimes: JSON array of {at: ISO 8601 UTC} objects. Nullable.

ALTER TABLE events ADD COLUMN IF NOT EXISTS runtime_minutes INTEGER;
ALTER TABLE events ADD COLUMN IF NOT EXISTS content_rating TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS showtimes JSONB;
