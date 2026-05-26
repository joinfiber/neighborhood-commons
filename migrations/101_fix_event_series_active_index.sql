-- Migration 101: correct migration 052's invalid idx_event_series_active.
--
-- 052 tried to create a partial index with a now() predicate:
--   CREATE INDEX ... ON event_series (id) WHERE ends_at IS NULL OR ends_at > now();
-- Postgres rejects now() in an index predicate (it is STABLE, not IMMUTABLE), so
-- the CREATE INDEX errored and rolled back 052's whole transaction with it —
-- taking the `ALTER TABLE event_series ADD COLUMN ends_at` and the COMMENT along.
-- Net effect on any instance that ran 052: no ends_at column AND no index.
--
-- This migration recreates the index correctly and restores 052's lost column +
-- comment. The corrected index is a plain B-tree on (ends_at): it serves the
-- auto-extend cron's filter `(ends_at IS NULL OR ends_at > $now)` for both arms
-- (B-tree stores NULLs and supports the range), is IMMUTABLE, and is strictly
-- more capable than the partial index 052 intended. Idempotent.

-- Restore the column 052's rollback dropped (no-op where 052 or migration 100 landed it).
ALTER TABLE event_series ADD COLUMN IF NOT EXISTS ends_at timestamptz DEFAULT NULL;

-- Drop any prior definition of the index name before recreating it. (No instance
-- should have it — 052's CREATE always failed — but this makes re-creation robust
-- against a hand-applied variant, since CREATE INDEX IF NOT EXISTS would silently
-- keep a differently-defined index of the same name.)
DROP INDEX IF EXISTS idx_event_series_active;

CREATE INDEX IF NOT EXISTS idx_event_series_active
  ON event_series (ends_at);

COMMENT ON COLUMN event_series.ends_at IS
  'Optional series end boundary. NULL = ongoing (auto-extended by cron). Set = bounded (no extension past this date).';
