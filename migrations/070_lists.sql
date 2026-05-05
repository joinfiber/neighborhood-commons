-- ============================================================================
-- Migration 070: lists + list_items
--
-- Schema.org ItemList. Curatorial selections by an Organization or Person.
-- list_items are polymorphic — each item references exactly one of:
-- event, organization, place. Curators mix and match.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lists (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text UNIQUE NOT NULL,
  name                text NOT NULL,
  description         text,
  curator_org_id      uuid REFERENCES organizations(id) ON DELETE SET NULL,
  curator_person_id   uuid REFERENCES persons(id) ON DELETE SET NULL,
  CHECK ((curator_org_id IS NOT NULL) <> (curator_person_id IS NOT NULL)),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lists_curator_org
  ON lists(curator_org_id) WHERE curator_org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lists_curator_person
  ON lists(curator_person_id) WHERE curator_person_id IS NOT NULL;

DROP TRIGGER IF EXISTS lists_updated_at ON lists;
CREATE TRIGGER lists_updated_at
  BEFORE UPDATE ON lists
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE lists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lists_public_read ON lists;
CREATE POLICY lists_public_read
  ON lists FOR SELECT
  TO anon, authenticated
  USING (true);

-- ----------------------------------------------------------------------------
-- list_items: polymorphic item references (event xor organization xor place).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS list_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id           uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  position          integer NOT NULL CHECK (position > 0),
  event_id          uuid REFERENCES events(id) ON DELETE CASCADE,
  organization_id   uuid REFERENCES organizations(id) ON DELETE CASCADE,
  place_id          uuid REFERENCES places(id) ON DELETE CASCADE,
  curator_note      text,
  added_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (event_id IS NOT NULL)::int + (organization_id IS NOT NULL)::int + (place_id IS NOT NULL)::int = 1
  ),
  UNIQUE (list_id, position)
);

CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id);
CREATE INDEX IF NOT EXISTS idx_list_items_event
  ON list_items(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_list_items_org
  ON list_items(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_list_items_place
  ON list_items(place_id) WHERE place_id IS NOT NULL;

ALTER TABLE list_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS list_items_public_read ON list_items;
CREATE POLICY list_items_public_read
  ON list_items FOR SELECT
  TO anon, authenticated
  USING (true);

COMMENT ON TABLE lists IS 'Schema.org ItemList. Curatorial selection by an Organization or Person — "this weekend''s picks", "favorite local businesses", etc.';
COMMENT ON TABLE list_items IS 'List members. Each item references exactly one of: event, organization, place. Polymorphic via xor CHECK constraint.';
COMMENT ON COLUMN list_items.position IS 'Ordering within the list. Positions are 1-indexed and unique within a list.';
COMMENT ON COLUMN list_items.curator_note IS 'Optional commentary from the curator on this specific item.';
