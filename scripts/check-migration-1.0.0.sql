-- =============================================================================
-- Migration 1.0.0 — verification queries
--
-- Read-only checks for the migration sprint that applies migrations 064–074.
-- Designed to be copy-pasted in chunks into the Supabase SQL editor.
-- All queries are SELECT-only; nothing here mutates data.
--
-- Run sections in order:
--   §1  Pre-flight        — before applying anything; captures baseline counts
--   §2  After 064–073     — quick "did the table get created" checks
--   §3  Pre-074 baseline  — capture source counts right before the backfill runs
--   §4  Post-074 verify   — compare backfill output to expected
--   §5  Final sanity      — looks for inconsistencies that would indicate a bug
--   §6  Cohort spot-check — pull a few real rows and eyeball them
-- =============================================================================


-- =============================================================================
-- §1. PRE-FLIGHT  (run BEFORE applying any migration)
-- =============================================================================
-- Confirms legacy schema is what we expect. If any of these fail with "column
-- does not exist", stop and re-read the migration script — column names have
-- shifted under us.

-- 1a. Legacy table row counts
SELECT 'groups' AS table_name, COUNT(*) AS row_count FROM groups
UNION ALL SELECT 'group_venues', COUNT(*) FROM group_venues
UNION ALL SELECT 'portal_accounts', COUNT(*) FROM portal_accounts
UNION ALL SELECT 'events', COUNT(*) FROM events
UNION ALL SELECT 'api_key_account_links', COUNT(*) FROM api_key_account_links
UNION ALL SELECT 'api_keys', COUNT(*) FROM api_keys;

-- 1b. Verify renamed portal_accounts columns are present (post-migration-003 names)
-- Should return 6 rows. If any are missing, the migration column references will fail.
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'portal_accounts'
  AND column_name IN (
    'default_venue_name','default_address','default_place_id',
    'default_latitude','default_longitude','website'
  )
ORDER BY column_name;

-- 1c. Verify api_key_account_links has the join-table column names we expect
-- Should return: api_key_id, linked_at, portal_account_id
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'api_key_account_links'
ORDER BY ordinal_position;

-- 1d. Confirm new tables don't yet exist (sanity — make sure we're at a clean starting point)
-- Should return 0 rows.
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'places','organizations','organization_places','persons',
    'event_performers','broadcasts','lists','list_items',
    'account_verified_identifiers','verification_challenges',
    'verification_pending_reviews','api_key_organization_links'
  );


-- =============================================================================
-- §2. AFTER 064–073  (run after each create-table migration applies)
-- =============================================================================
-- Each table should exist and be empty. Run after the migration that creates it.

-- 2a. After 064 (places)
SELECT 'places exists' AS check, EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='places') AS ok;
SELECT COUNT(*) AS places_count FROM places;  -- expect 0

-- 2b. After 065 (organizations + organization_places)
SELECT COUNT(*) AS organizations_count FROM organizations;  -- expect 0
SELECT COUNT(*) AS organization_places_count FROM organization_places;  -- expect 0

-- 2c. After 066 (persons)
SELECT COUNT(*) AS persons_count FROM persons;  -- expect 0

-- 2d. After 067 (events FKs added)
-- New nullable columns; existing events rows have NULL for all three.
SELECT
  COUNT(*) AS total_events,
  COUNT(location_place_id) AS with_location_place_id,
  COUNT(organizer_org_id) AS with_organizer_org_id,
  COUNT(organizer_person_id) AS with_organizer_person_id
FROM events;
-- Expect: with_* all = 0

-- 2e. After 068 (event_performers)
SELECT COUNT(*) AS event_performers_count FROM event_performers;  -- expect 0

-- 2f. After 069 (broadcasts + expire_broadcasts function)
SELECT COUNT(*) AS broadcasts_count FROM broadcasts;  -- expect 0
SELECT proname FROM pg_proc WHERE proname = 'expire_broadcasts';  -- expect 1 row

-- 2g. After 070 (lists + list_items)
SELECT COUNT(*) AS lists_count FROM lists;  -- expect 0
SELECT COUNT(*) AS list_items_count FROM list_items;  -- expect 0

-- 2h. After 071 (verification tables + cleanup_expired_challenges)
SELECT COUNT(*) FROM account_verified_identifiers;  -- expect 0
SELECT COUNT(*) FROM verification_challenges;  -- expect 0
SELECT COUNT(*) FROM verification_pending_reviews;  -- expect 0
SELECT proname FROM pg_proc WHERE proname = 'cleanup_expired_challenges';  -- expect 1 row

-- 2i. After 072 (api_keys columns)
SELECT column_name FROM information_schema.columns
WHERE table_name = 'api_keys'
  AND column_name IN ('brand_config','verification_authority','is_admin')
ORDER BY column_name;
-- Expect 3 rows.

-- 2j. After 073 (api_key_organization_links)
SELECT COUNT(*) AS api_key_org_links_count FROM api_key_organization_links;  -- expect 0


-- =============================================================================
-- §3. PRE-074 BASELINE  (run RIGHT BEFORE the backfill migration)
-- =============================================================================
-- Capture source-data counts so we can compare against post-backfill numbers.
-- Note these down (or copy the result block aside) before running 074.

-- 3a. Source counts that drive the backfill
SELECT
  (SELECT COUNT(*) FROM groups) AS groups_count,
  (SELECT COUNT(*) FROM portal_accounts) AS portal_accounts_total,
  (SELECT COUNT(*) FROM portal_accounts WHERE business_name IS NOT NULL AND TRIM(business_name) != '') AS portal_accounts_with_name,
  (SELECT COUNT(*) FROM portal_accounts pa WHERE NOT EXISTS (SELECT 1 FROM groups g WHERE g.portal_account_id = pa.id)
     AND pa.business_name IS NOT NULL AND TRIM(pa.business_name) != '') AS portal_accounts_NOT_in_groups,
  (SELECT COUNT(*) FROM group_venues) AS group_venues_count,
  (SELECT COUNT(*) FROM api_key_account_links) AS api_key_account_links_count,
  (SELECT COUNT(*) FROM events) AS events_total,
  (SELECT COUNT(*) FROM events WHERE place_id IS NOT NULL) AS events_with_place_id,
  (SELECT COUNT(*) FROM events WHERE group_id IS NOT NULL) AS events_with_group_id,
  (SELECT COUNT(*) FROM events WHERE creator_account_id IS NOT NULL) AS events_with_creator;

-- 3b. Distinct google_place_ids that should land in places after dedup
SELECT COUNT(DISTINCT pid) AS distinct_place_ids_total FROM (
  SELECT place_id AS pid FROM events
    WHERE place_id IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL
  UNION
  SELECT default_place_id FROM portal_accounts
    WHERE default_place_id IS NOT NULL AND default_latitude IS NOT NULL AND default_longitude IS NOT NULL
  UNION
  SELECT place_id FROM group_venues
    WHERE place_id IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL
) AS all_place_refs;
-- Note this number — it's what places_count should be after backfill.


-- =============================================================================
-- §4. POST-074 VERIFY  (run AFTER backfill migration completes)
-- =============================================================================
-- The migration prints stats via RAISE NOTICE; these queries verify those stats.

-- 4a. Final counts. Compare against the §3 baseline.
SELECT
  (SELECT COUNT(*) FROM places) AS places,
  (SELECT COUNT(*) FROM organizations) AS organizations,
  (SELECT COUNT(*) FROM organization_places) AS organization_places,
  (SELECT COUNT(*) FROM api_key_organization_links) AS api_key_org_links;
-- Expected (using §3 baseline numbers as variables):
--   places              = distinct_place_ids_total
--   organizations       = groups_count + portal_accounts_NOT_in_groups
--   organization_places ≤ group_venues_count (only counts gv rows where the org exists)
--   api_key_org_links   ≤ api_key_account_links_count (only counts links where the portal_account → org)

-- 4b. organizations distribution by kind
SELECT kind, COUNT(*) AS n FROM organizations GROUP BY kind ORDER BY n DESC;

-- 4c. Events backfill: how many got linked to a Place and an organizer
SELECT
  (SELECT COUNT(*) FROM events) AS total,
  (SELECT COUNT(*) FROM events WHERE location_place_id IS NOT NULL) AS with_place_fk,
  (SELECT COUNT(*) FROM events WHERE organizer_org_id IS NOT NULL) AS with_org_fk,
  (SELECT COUNT(*) FROM events WHERE organizer_org_id IS NULL AND organizer_person_id IS NULL) AS without_organizer;

-- 4d. Did all groups successfully become organizations? (1:1 by id)
-- Should return 0 — every group should have a matching organization row.
SELECT COUNT(*) AS groups_missing_org FROM groups g
WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = g.id);


-- =============================================================================
-- §5. FINAL SANITY  (run after §4 looks correct)
-- =============================================================================
-- Looks for inconsistencies that would indicate a bug or surprising data.

-- 5a. Local_business orgs without a primary_place_id (potential miswiring)
-- Some are legit (touring caterers etc.), but a high count suggests we missed
-- a backfill path. Inspect a sample if the count looks off.
SELECT COUNT(*) AS local_business_without_place
FROM organizations
WHERE kind = 'local_business' AND primary_place_id IS NULL;

-- 5b. Events with BOTH organizer_org_id AND organizer_person_id (should never happen)
SELECT COUNT(*) AS events_with_both_organizers
FROM events
WHERE organizer_org_id IS NOT NULL AND organizer_person_id IS NOT NULL;
-- Expect 0. If non-zero, the backfill or app code wrote conflicting state.

-- 5c. Place rows where lat/lng made it through as NULL (shouldn't happen given backfill filter)
SELECT COUNT(*) AS places_with_null_geo FROM places WHERE latitude IS NULL OR longitude IS NULL;
-- Expect 0.

-- 5d. Organizations with NULL slug (shouldn't happen — slug is NOT NULL)
SELECT COUNT(*) AS orgs_with_null_slug FROM organizations WHERE slug IS NULL;
-- Expect 0.

-- 5e. Duplicate identifier_value across targets — would block cross-account uniqueness
-- if we ever decide to enforce it. Currently allowed (per-target uniqueness only).
-- This is an information query, not a failure.
SELECT identifier_value, COUNT(*) AS used_by_targets
FROM account_verified_identifiers
GROUP BY identifier_value
HAVING COUNT(*) > 1;
-- Expect 0 rows in 1.0.0 launch (table is empty).

-- 5f. organization_places where neither org nor place exists (orphans)
-- Shouldn't happen because of the FK CASCADE.
SELECT COUNT(*) AS orphan_org_places
FROM organization_places op
WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = op.organization_id)
   OR NOT EXISTS (SELECT 1 FROM places p WHERE p.id = op.place_id);


-- =============================================================================
-- §6. COHORT SPOT-CHECK  (eyeball some real rows)
-- =============================================================================
-- Pull a few rows from each new table and visually verify the data looks right.

-- 6a. Five organizations: id, kind, name, place link, owner link, verified state
SELECT
  o.kind,
  o.slug,
  o.name,
  CASE WHEN o.primary_place_id IS NULL THEN '∅' ELSE p.name END AS primary_place,
  CASE WHEN o.owner_account_id IS NULL THEN '∅' ELSE pa.email END AS owner_email,
  EXISTS (SELECT 1 FROM account_verified_identifiers v
          WHERE v.target_type='organization' AND v.target_id=o.id AND v.status='active') AS verified
FROM organizations o
LEFT JOIN places p ON p.id = o.primary_place_id
LEFT JOIN portal_accounts pa ON pa.id = o.owner_account_id
ORDER BY o.created_at DESC
LIMIT 5;

-- 6b. Five places: name, address summary, geo, identifier
SELECT
  name,
  CONCAT_WS(', ',
    NULLIF(street_address, ''),
    NULLIF(address_locality, ''),
    NULLIF(address_region, '')
  ) AS address_summary,
  latitude, longitude,
  google_place_id
FROM places
ORDER BY created_at DESC
LIMIT 5;

-- 6c. Five recent events: their organizer + venue links
SELECT
  e.id,
  LEFT(e.content, 40) AS event_name,
  e.event_at,
  CASE WHEN e.organizer_org_id IS NULL THEN '∅' ELSE o.name END AS organizer,
  CASE WHEN e.location_place_id IS NULL THEN '∅' ELSE p.name END AS place
FROM events e
LEFT JOIN organizations o ON o.id = e.organizer_org_id
LEFT JOIN places p ON p.id = e.location_place_id
WHERE e.status = 'published'
ORDER BY e.event_at DESC
LIMIT 5;

-- 6d. api_key_organization_links: which keys can write to which orgs
SELECT
  k.name AS api_key_name,
  k.contributor_tier,
  k.is_admin,
  o.name AS organization_name,
  o.kind
FROM api_key_organization_links akol
JOIN api_keys k ON k.id = akol.api_key_id
JOIN organizations o ON o.id = akol.organization_id
ORDER BY k.name, o.name
LIMIT 20;


-- =============================================================================
-- DONE. If §4 counts match §3 baseline expectations and §5 returns clean,
-- the backfill is good. The legacy tables (groups, group_venues,
-- api_key_account_links, developer_otps) and legacy portal_accounts columns
-- (default_*, etc.) remain readable — they're dead-code-readable until v1.1.0
-- cleans them up after operational confidence accumulates.
-- =============================================================================
