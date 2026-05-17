-- ============================================================================
-- Migration 078: v2 additive columns (non-breaking)
--
-- Adds new columns the v2 model needs, in advance of the breaking changes
-- in subsequent migrations. All additions are nullable / defaulted so this
-- migration is safe to apply independently and doesn't disturb existing
-- code paths.
--
-- What this adds:
--   organizations.tags                 — descriptive labels (text[])
--   organizations.commercial           — for-profit/non-profit binary
--   places.place_categories            — OSM-sourced categorization
--   places.category_source             — provenance for place_categories
--   places.category_reviewed_at        — audit trail
--   places.category_reviewed_by        — audit trail
--   events.match_key                   — internal dedup mechanism
--   api_keys.witness_authority         — collective-witnessing capability flag
--   events.source_method               — extend enum to include 'witnessed'
--
-- All columns are nullable / defaulted. Backfill happens through usage,
-- not in this migration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- organizations: tags + commercial (replaces kind in v2)
-- ----------------------------------------------------------------------------

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS tags        text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS commercial  boolean;

CREATE INDEX IF NOT EXISTS idx_organizations_tags
  ON organizations USING GIN (tags);

COMMENT ON COLUMN organizations.tags IS 'Descriptive labels — free-form within format rules. Recommended starter vocabulary at /v1/meta/tags. Not a hard taxonomy; consumer apps filter on whatever tags appear in practice.';
COMMENT ON COLUMN organizations.commercial IS 'For-profit (true) vs. non-profit/community (false). Null = unspecified. Replaces the structural-axis component of the legacy kind enum.';

-- ----------------------------------------------------------------------------
-- places: OSM-sourced categorization + admin-review provenance
-- ----------------------------------------------------------------------------
-- Google's terms permit indefinite storage of place_id only. Other Content
-- (including types/categories) is restricted. Categorization here comes from
-- OpenStreetMap (ODbL, indefinite storage permitted with attribution) or
-- admin review / publisher self-declaration. Google response data is never
-- persisted into these columns — only consulted at runtime.

ALTER TABLE places
  ADD COLUMN IF NOT EXISTS place_categories     text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS category_source      text
    CHECK (category_source IN ('osm', 'admin_review', 'publisher_declaration') OR category_source IS NULL),
  ADD COLUMN IF NOT EXISTS category_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS category_reviewed_by text;

CREATE INDEX IF NOT EXISTS idx_places_categories
  ON places USING GIN (place_categories);

COMMENT ON COLUMN places.place_categories IS 'Place categorization (e.g., "cafe", "live_music_venue"). Sourced from OpenStreetMap (ODbL) by default. Never sourced from Google response data.';
COMMENT ON COLUMN places.category_source IS 'Provenance of place_categories: osm (default), admin_review (operator added), publisher_declaration (verified publisher refined).';

-- ----------------------------------------------------------------------------
-- events: match_key for internal dedup detection at write time
-- ----------------------------------------------------------------------------
-- Computed at write time from (place_id, time bucket, normalized title hash).
-- Used by service-write paths to detect duplicate-event submissions and
-- offer "this event already exists" instead of creating a new row.
-- Algorithm is documented in docs/future-considerations.md; not finalized
-- until the dedup case actually bites. Column exists so the algorithm can
-- be added later without a schema change.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS match_key text;

CREATE INDEX IF NOT EXISTS idx_events_match_key
  ON events(match_key) WHERE match_key IS NOT NULL;

COMMENT ON COLUMN events.match_key IS 'Internal dedup fingerprint computed from place + time + normalized title. Nullable; populated when write-path dedup is implemented. Not exposed in public API.';

-- ----------------------------------------------------------------------------
-- events.source_method: extend enum to include 'witnessed'
-- ----------------------------------------------------------------------------
-- The witnessed-with-evidence authority path (Fiber Community OCR pattern)
-- uses source_method='witnessed'. Drop and recreate the CHECK constraint
-- since Postgres doesn't support ALTER on CHECK constraints directly.

DO $$
DECLARE
  r record;
BEGIN
  -- Defensive: drop ANY existing CHECK constraint on events that mentions
  -- source_method. Constraint names can vary (auto-generated, manually
  -- created, recreated across migrations), so we discover by introspection
  -- rather than assuming a name.
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    WHERE cls.relname = 'events'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%source_method%'
  LOOP
    EXECUTE 'ALTER TABLE events DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;

  -- Add the new constraint with the extended set, using a stable name.
  ALTER TABLE events
    ADD CONSTRAINT events_source_method_check
    CHECK (source_method IN ('portal', 'api', 'import', 'witnessed') OR source_method IS NULL);
END $$;

COMMENT ON COLUMN events.source_method IS 'Provenance: portal (legacy portal SPA), api (Service API write), import (Studio ingestion pipeline), witnessed (collective-witnessing with evidence; requires api_keys.witness_authority).';

-- ----------------------------------------------------------------------------
-- api_keys: witness_authority capability flag
-- ----------------------------------------------------------------------------
-- Service keys with this flag can write events with source_method='witnessed',
-- attributed to a collective-publisher organization (e.g., "Fiber Community").
-- The witnessed-evidence authority path bypasses api_key_organization_links
-- (since the publisher is the collective, not the individual user's org).
-- Granted at activation for specific use cases like Fiber's OCR contribution.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS witness_authority boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN api_keys.witness_authority IS 'When true, this key can write events with source_method=witnessed attributed to a collective publisher organization. Granted at activation for use cases like Fiber OCR.';

-- ----------------------------------------------------------------------------
-- Done. Subsequent migrations (079-082) handle the breaking v2 changes:
--   079 — migrate persons rows to organizations
--   080 — create organization_verifications, migrate from account_verified_identifiers
--   081 — backfill events.organizer_org_id, add NOT NULL constraint
--   082 — drop deprecated tables and columns
-- ----------------------------------------------------------------------------
