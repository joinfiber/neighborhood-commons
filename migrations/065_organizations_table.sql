-- ============================================================================
-- Migration 065: organizations + organization_places
--
-- Schema.org Organization. Subtype expressed via `kind` discriminator.
-- LocalBusiness pattern simulated via primary_place_id link to a Place row;
-- many-to-many across multiple places via organization_places.
--
-- Replaces the legacy `groups` table (which conflated business identity with
-- collective identity) and the business-profile columns on `portal_accounts`.
-- The legacy tables stay readable through 1.0.0 and get dropped in 1.1.0
-- once operational confidence is established.
-- ============================================================================

CREATE TABLE IF NOT EXISTS organizations (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                          text UNIQUE NOT NULL,
  name                          text NOT NULL,
  legal_name                    text,
  kind                          text NOT NULL CHECK (kind IN (
                                  'local_business',
                                  'business',
                                  'community_group',
                                  'nonprofit',
                                  'curator',
                                  'collective'
                                )),
  description                   text,
  url                           text,
  logo_url                      text,
  image_url                     text,
  telephone                     text,
  email                         text,
  same_as                       jsonb DEFAULT '[]'::jsonb,
  keywords                      text[] DEFAULT '{}',
  opening_hours_specification   jsonb,
  primary_place_id              uuid REFERENCES places(id) ON DELETE SET NULL,
  owner_account_id              uuid REFERENCES portal_accounts(id) ON DELETE SET NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organizations_kind ON organizations(kind);
CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_account_id);
CREATE INDEX IF NOT EXISTS idx_organizations_primary_place ON organizations(primary_place_id);
CREATE INDEX IF NOT EXISTS idx_organizations_keywords_gin ON organizations USING GIN (keywords);

DROP TRIGGER IF EXISTS organizations_updated_at ON organizations;
CREATE TRIGGER organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organizations_public_read ON organizations;
CREATE POLICY organizations_public_read
  ON organizations FOR SELECT
  TO anon, authenticated
  USING (true);

-- ----------------------------------------------------------------------------
-- organization_places: many-to-many for chains, pop-ups, shared spaces.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_places (
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  place_id          uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  is_primary        boolean DEFAULT false,
  relationship      text CHECK (relationship IN ('operates_at', 'hosts_events_at', 'headquartered_at')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, place_id)
);

CREATE INDEX IF NOT EXISTS idx_org_places_place ON organization_places(place_id);

ALTER TABLE organization_places ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organization_places_public_read ON organization_places;
CREATE POLICY organization_places_public_read
  ON organization_places FOR SELECT
  TO anon, authenticated
  USING (true);

COMMENT ON TABLE organizations IS 'Schema.org Organization. kind discriminates local_business / business / community_group / nonprofit / curator / collective. Heavy verification rigor for kind in (local_business, business, nonprofit); light rigor for the rest.';
COMMENT ON COLUMN organizations.kind IS 'Schema.org subtype proxy. Maps to additionalType URL on API output (e.g. local_business → https://schema.org/LocalBusiness).';
COMMENT ON COLUMN organizations.same_as IS 'JSONB array of canonical URLs (Wikipedia, Wikidata, social profiles).';
COMMENT ON COLUMN organizations.opening_hours_specification IS 'JSONB array matching Schema.org OpeningHoursSpecification: [{dayOfWeek, opens, closes}, ...].';
COMMENT ON COLUMN organizations.primary_place_id IS 'For LocalBusiness: the canonical Place this org operates at. Null for touring/online-only organizations.';
COMMENT ON TABLE organization_places IS 'Many-to-many. An organization can operate at / host events at / be headquartered at multiple places; one place can host many organizations.';
