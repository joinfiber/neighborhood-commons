-- ============================================================================
-- Migration 064: places table
--
-- Schema.org Place. Physical locations, deduplicated by google_place_id.
-- Pure create. No backfill (that lives in 074). Idempotent.
--
-- Why a separate places table when events/portal_accounts already store
-- venue data: the existing flat columns are point-in-time snapshots. As the
-- canonical Place type lands, every event/organization/list_item points at
-- a single Place row by FK, and that row is the source of truth for address
-- and geo. No more divergent venue records for the same physical location.
-- ============================================================================

CREATE TABLE IF NOT EXISTS places (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_place_id     text UNIQUE,
  name                text NOT NULL,
  street_address      text,
  address_locality    text,
  address_region      text,
  postal_code         text,
  address_country     text NOT NULL DEFAULT 'US',
  latitude            double precision NOT NULL,
  longitude           double precision NOT NULL,
  region_id           uuid REFERENCES regions(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_places_region ON places(region_id);
CREATE INDEX IF NOT EXISTS idx_places_geo ON places(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_places_locality ON places(address_locality);

-- Reuse the existing updated_at trigger function from migration 001.
DROP TRIGGER IF EXISTS places_updated_at ON places;
CREATE TRIGGER places_updated_at
  BEFORE UPDATE ON places
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE places ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS places_public_read ON places;
CREATE POLICY places_public_read
  ON places FOR SELECT
  TO anon, authenticated
  USING (true);

-- Service role bypasses RLS; all writes go through the API.

COMMENT ON TABLE places IS 'Schema.org Place. Physical locations deduplicated by google_place_id where available.';
COMMENT ON COLUMN places.google_place_id IS 'Google Places API ID. Primary external dedup key. Nullable for places not in Google Places (rare).';
COMMENT ON COLUMN places.address_country IS 'ISO 3166-1 alpha-2 country code. Defaults to US.';
