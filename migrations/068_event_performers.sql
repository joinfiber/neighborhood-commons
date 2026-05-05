-- ============================================================================
-- Migration 068: event_performers table
--
-- Schema.org Event.performer. Many performers per event, each one a Person
-- or Organization (xor) acting in some role at the event (DJ, host, speaker,
-- band, etc.).
--
-- Empty initially. Apps populate when they want to model lineups; events
-- without a performers row continue to use freeform organizer name on the
-- Event itself.
-- ============================================================================

CREATE TABLE IF NOT EXISTS event_performers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id         uuid REFERENCES persons(id) ON DELETE SET NULL,
  organization_id   uuid REFERENCES organizations(id) ON DELETE SET NULL,
  performer_role    text,
  position          integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((person_id IS NOT NULL) <> (organization_id IS NOT NULL)),
  UNIQUE (event_id, person_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_event_performers_event ON event_performers(event_id);
CREATE INDEX IF NOT EXISTS idx_event_performers_person
  ON event_performers(person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_performers_org
  ON event_performers(organization_id) WHERE organization_id IS NOT NULL;

ALTER TABLE event_performers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_performers_public_read ON event_performers;
CREATE POLICY event_performers_public_read
  ON event_performers FOR SELECT
  TO anon, authenticated
  USING (true);

COMMENT ON TABLE event_performers IS 'Schema.org Event.performer. Each row is one performer (Person or Organization) at one event, with optional role and position.';
COMMENT ON COLUMN event_performers.performer_role IS 'Freeform role string (e.g. "dj", "host", "speaker", "band", "headliner"). v1: no controlled vocabulary; future versions may introduce one.';
COMMENT ON COLUMN event_performers.position IS 'Lineup ordering (1 = first, 2 = second, ...). NULL = unordered.';
