-- Migration 098: composite index for the hot events list path.
--
-- GET /v1/events defaults to WHERE status='published' AND relevant_until >= now()
-- ORDER BY relevant_until ASC. idx_events_relevant_until (migration 088) is a
-- plain single-column index that doesn't encode the status equality, so Postgres
-- range-scans relevant_until and filters status afterward — degrading as the
-- table fills with past / non-published rows. A composite (status, relevant_until)
-- seeks the status partition, then serves the relevant_until range + sort
-- directly. Complements idx_events_status_event_at (the cutoffOverride path).
-- Idempotent.

CREATE INDEX IF NOT EXISTS idx_events_status_relevant_until
  ON events (status, relevant_until);
