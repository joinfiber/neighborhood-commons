-- ============================================================================
-- Migration 082: drop v2-deprecated tables and columns
--
-- IMPORTANT: This migration is destructive and should only be applied AFTER
-- all code references to the dropped surfaces have been removed. Specifically:
--   - event-transform.ts no longer reads portal_accounts.business_name
--   - v1-accounts.ts is retired (replaced by v1-publishers.ts)
--   - v1-persons.ts is retired
--   - v1-verifiers.ts is retired
--   - contribute.ts is retired
--   - service/persons.ts is retired
--   - Service API event writes use organizer_org_id (not organizer_person_id)
--   - Service API list writes use curator_org_id (not curator_person_id)
--   - All verification queries hit organization_verifications (not account_verified_identifiers)
--
-- What this drops:
--   1. event_performers.person_id (add performer_name fallback for free-form)
--   2. events.organizer_person_id
--   3. lists.curator_person_id
--   4. persons table
--   5. account_verified_identifiers table (data now in organization_verifications)
--   6. organizations.kind column (replaced by tags + commercial + derived signals)
--   7. Unused business-profile columns from portal_accounts (data lives on organizations)
--   8. Legacy tables: groups, group_venues, api_key_account_links, developer_otps
--
-- Idempotent. Each DROP uses IF EXISTS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Step 1: event_performers — add performer_name, drop person_id
-- ----------------------------------------------------------------------------
-- Performers either have an organization (named handle in the Commons) or
-- are free-form strings (one-off acts). The old person_id FK is dropped;
-- performer_name covers the non-org case.

ALTER TABLE event_performers
  ADD COLUMN IF NOT EXISTS performer_name text;

-- Defensive: drop ANY existing CHECK constraint on event_performers before
-- adding the new one. Names can vary across recreations.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    WHERE cls.relname = 'event_performers'
      AND con.contype = 'c'
  LOOP
    EXECUTE 'ALTER TABLE event_performers DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

-- Drop person_id BEFORE adding the new check (the new check might reference
-- columns that wouldn't exist if person_id was the validator).
ALTER TABLE event_performers
  DROP COLUMN IF EXISTS person_id;

-- Keep at least one of organization_id or performer_name
ALTER TABLE event_performers
  ADD CONSTRAINT event_performers_check
  CHECK (organization_id IS NOT NULL OR performer_name IS NOT NULL);

COMMENT ON COLUMN event_performers.performer_name IS 'Free-form performer name for performers without a Commons organization. Either organization_id or performer_name must be set.';

-- ----------------------------------------------------------------------------
-- Step 2: events — drop organizer_person_id
-- ----------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_events_organizer_person;

ALTER TABLE events
  DROP COLUMN IF EXISTS organizer_person_id;

-- ----------------------------------------------------------------------------
-- Step 3: lists — drop curator_person_id, enforce curator_org_id NOT NULL
-- ----------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_lists_curator_person;

-- Defensive: drop ALL CHECK constraints on lists. Migration 070's XOR check
-- has an auto-generated name; safer to discover by introspection than guess.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    WHERE cls.relname = 'lists'
      AND con.contype = 'c'
  LOOP
    EXECUTE 'ALTER TABLE lists DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

ALTER TABLE lists
  DROP COLUMN IF EXISTS curator_person_id;

-- Handle any lists that ended up orphaned (curator_org_id IS NULL after
-- migration 079 couldn't backfill because the source person didn't migrate
-- successfully). These lists are uncurable — delete them rather than
-- assigning to a placeholder, since list ownership without a curator is
-- semantically meaningless.
DO $$
DECLARE
  v_orphans integer;
BEGIN
  SELECT COUNT(*) INTO v_orphans FROM lists WHERE curator_org_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE NOTICE 'Deleting % orphan lists (no curator) before enforcing NOT NULL', v_orphans;
    DELETE FROM lists WHERE curator_org_id IS NULL;
  END IF;
END $$;

-- curator_org_id is now required
ALTER TABLE lists
  ALTER COLUMN curator_org_id SET NOT NULL;

-- ----------------------------------------------------------------------------
-- Step 4: persons table
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS persons CASCADE;

-- ----------------------------------------------------------------------------
-- Step 5: account_verified_identifiers (replaced by organization_verifications)
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS account_verified_identifiers CASCADE;

-- ----------------------------------------------------------------------------
-- Step 6: organizations.kind column
-- ----------------------------------------------------------------------------
-- Replaced by tags + commercial + derived signals (place_categories, events).

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_kind_check;

DROP INDEX IF EXISTS idx_organizations_kind;

ALTER TABLE organizations
  DROP COLUMN IF EXISTS kind;

-- ----------------------------------------------------------------------------
-- Step 7: Narrow portal_accounts to operational columns only
-- ----------------------------------------------------------------------------
-- Business-profile data lives on organizations now (per migration 074).
-- Keep only: id, auth_user_id, email, claimed_at, claimed_by, status,
-- last_login_at, created_at, updated_at.

ALTER TABLE portal_accounts
  DROP COLUMN IF EXISTS business_name,
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS website,
  DROP COLUMN IF EXISTS default_venue_name,
  DROP COLUMN IF EXISTS default_address,
  DROP COLUMN IF EXISTS default_place_id,
  DROP COLUMN IF EXISTS default_latitude,
  DROP COLUMN IF EXISTS default_longitude,
  DROP COLUMN IF EXISTS logo_url,
  DROP COLUMN IF EXISTS cover_image_url,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS wheelchair_accessible,
  DROP COLUMN IF EXISTS slug,
  DROP COLUMN IF EXISTS operating_hours,
  DROP COLUMN IF EXISTS organization_name,
  DROP COLUMN IF EXISTS contributor_type,
  DROP COLUMN IF EXISTS data_description;

COMMENT ON TABLE portal_accounts IS 'Operational accounts table — holds service-key tenant claims and legacy OTP-claimed user accounts. Holds PII (email). Never exposed via public API. Business-profile data lives on organizations.';

-- ----------------------------------------------------------------------------
-- Step 8: Drop legacy tables
-- ----------------------------------------------------------------------------
-- groups, group_venues — replaced by organizations + organization_places (migration 074)
-- api_key_account_links — replaced by api_key_organization_links (migration 073)
-- developer_otps — operational table no longer needed in the current flow

DROP TABLE IF EXISTS group_venues CASCADE;  -- references groups
DROP TABLE IF EXISTS groups CASCADE;
DROP TABLE IF EXISTS api_key_account_links CASCADE;
DROP TABLE IF EXISTS developer_otps CASCADE;

-- ----------------------------------------------------------------------------
-- Final state notice
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_events_with_org integer;
  v_org_count integer;
BEGIN
  SELECT COUNT(*) INTO v_org_count FROM organizations;
  SELECT COUNT(*) INTO v_events_with_org FROM events WHERE organizer_org_id IS NOT NULL;

  RAISE NOTICE '=== Migration 082 (v2 deprecated drop) complete ===';
  RAISE NOTICE 'Organizations: %', v_org_count;
  RAISE NOTICE 'Events with organizer: %', v_events_with_org;
  RAISE NOTICE 'Dropped tables: persons, account_verified_identifiers, groups, group_venues, api_key_account_links, developer_otps';
  RAISE NOTICE 'Dropped columns: events.organizer_person_id, lists.curator_person_id, organizations.kind, event_performers.person_id, and 17 narrowing drops on portal_accounts';
END $$;
