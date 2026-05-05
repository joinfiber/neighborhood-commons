-- ============================================================================
-- Migration 067: events organizer + place FKs
--
-- Adds nullable FK columns to events:
--   location_place_id    → Place this event happens at
--   organizer_org_id     → Organization organizer (xor with organizer_person_id)
--   organizer_person_id  → Person organizer (xor with organizer_org_id)
--
-- Existing flat venue columns (place_id, place_name, venue_address, latitude,
-- longitude) stay for backward compat through 1.x. They become event-creation-
-- time snapshots; the linked Place is the source of truth going forward.
--
-- The exactly-one-organizer CHECK constraint is NOT added yet because existing
-- rows have neither org nor person set (they predate this model). Migration
-- 074 backfills organizer_org_id from creator_account_id → organizations.
-- A future migration (1.1.0+) can enforce CHECK once backfill is verified.
-- ============================================================================

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS location_place_id   uuid REFERENCES places(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS organizer_org_id    uuid REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS organizer_person_id uuid REFERENCES persons(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_events_location_place
  ON events(location_place_id) WHERE location_place_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_organizer_org
  ON events(organizer_org_id) WHERE organizer_org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_organizer_person
  ON events(organizer_person_id) WHERE organizer_person_id IS NOT NULL;

COMMENT ON COLUMN events.location_place_id IS 'FK to canonical Place. The flat place_id/place_name/venue_address columns become a snapshot at event-creation time; this FK is the source of truth going forward.';
COMMENT ON COLUMN events.organizer_org_id IS 'Organization organizer. Mutually exclusive with organizer_person_id at the application layer (CHECK constraint deferred until backfill complete).';
COMMENT ON COLUMN events.organizer_person_id IS 'Person organizer (e.g., individual touring DJ booking their own gig). Mutually exclusive with organizer_org_id.';
