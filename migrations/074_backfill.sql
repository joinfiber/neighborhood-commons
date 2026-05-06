-- ============================================================================
-- Migration 074: backfill new tables from legacy data
--
-- Atomic. Idempotent. Prints stats. Safe to re-run.
--
-- Backfills:
--   1. places ← from events.place_id, portal_accounts.place_id, group_venues.place_id
--   2. organizations ← from groups (1:1 by id) + portal_accounts not represented
--   3. organization_places ← from group_venues
--   4. api_key_organization_links ← from api_key_account_links via portal_account → org
--   5. events.location_place_id ← from events.place_id (text) → places.google_place_id
--   6. events.organizer_org_id ← from events.group_id directly, or via creator_account_id
--
-- Address parsing on backfill is intentionally minimal: the existing single-line
-- venue_address column is dumped into places.street_address, leaving locality/
-- region/postal_code NULL. Apps that want structured addresses can re-PATCH
-- their venues over time. Going from no-structure to some-structure later is
-- safe; reverse-engineering bad parses isn't.
--
-- DROP statements are NOT included. Legacy tables (groups, group_venues,
-- api_key_account_links, developer_otps) and legacy columns on portal_accounts
-- become dead-code-readable until a future v1.1.0 migration removes them.
-- ============================================================================

DO $$
DECLARE
  v_places_before        integer;
  v_places_after         integer;
  v_orgs_before          integer;
  v_orgs_after           integer;
  v_org_places_after     integer;
  v_links_after          integer;
  v_events_total         integer;
  v_events_with_place    integer;
  v_events_with_org      integer;
  v_groups_count         integer;
BEGIN

  SELECT COUNT(*) INTO v_places_before FROM places;
  SELECT COUNT(*) INTO v_orgs_before FROM organizations;
  SELECT COUNT(*) INTO v_groups_count FROM groups;

  RAISE NOTICE '=== Migration 074 backfill starting ===';
  RAISE NOTICE 'Source counts: groups=%, portal_accounts=%, events=%, group_venues=%, api_key_account_links=%',
    v_groups_count,
    (SELECT COUNT(*) FROM portal_accounts),
    (SELECT COUNT(*) FROM events),
    (SELECT COUNT(*) FROM group_venues),
    (SELECT COUNT(*) FROM api_key_account_links);

  -- ==================================================================
  -- Step 1: places — dedup distinct google_place_ids from all sources
  -- ==================================================================
  INSERT INTO places (google_place_id, name, street_address, latitude, longitude)
  SELECT DISTINCT ON (google_place_id)
    google_place_id, name, street_address, lat, lng
  FROM (
    -- From events
    SELECT
      e.place_id    AS google_place_id,
      COALESCE(NULLIF(TRIM(e.place_name), ''), 'Unknown')  AS name,
      e.venue_address                                       AS street_address,
      e.latitude                                            AS lat,
      e.longitude                                           AS lng
    FROM events e
    WHERE e.place_id IS NOT NULL
      AND e.latitude IS NOT NULL
      AND e.longitude IS NOT NULL

    UNION ALL

    -- From portal_accounts (note: columns renamed default_* in migration 003)
    SELECT
      pa.default_place_id,
      COALESCE(NULLIF(TRIM(pa.default_venue_name), ''), NULLIF(TRIM(pa.business_name), ''), 'Unknown'),
      pa.default_address,
      pa.default_latitude,
      pa.default_longitude
    FROM portal_accounts pa
    WHERE pa.default_place_id IS NOT NULL
      AND pa.default_latitude IS NOT NULL
      AND pa.default_longitude IS NOT NULL

    UNION ALL

    -- From group_venues
    SELECT
      gv.place_id,
      COALESCE(NULLIF(TRIM(gv.venue_name), ''), 'Unknown'),
      gv.venue_address,
      gv.latitude,
      gv.longitude
    FROM group_venues gv
    WHERE gv.place_id IS NOT NULL
      AND gv.latitude IS NOT NULL
      AND gv.longitude IS NOT NULL
  ) AS sources
  WHERE google_place_id IS NOT NULL
  ORDER BY google_place_id, name
  ON CONFLICT (google_place_id) DO NOTHING;

  SELECT COUNT(*) INTO v_places_after FROM places;
  RAISE NOTICE 'Step 1: places % → % (added %)', v_places_before, v_places_after, v_places_after - v_places_before;

  -- ==================================================================
  -- Step 2a: organizations from groups (preserves id; 1:1 mapping)
  -- ==================================================================
  INSERT INTO organizations (
    id, slug, name, kind,
    description, url, telephone, image_url,
    keywords, opening_hours_specification,
    owner_account_id,
    created_at, updated_at
  )
  SELECT
    g.id,
    g.slug,
    g.name,
    CASE g.type
      WHEN 'business'        THEN 'local_business'
      WHEN 'community_group' THEN 'community_group'
      WHEN 'nonprofit'       THEN 'nonprofit'
      WHEN 'collective'      THEN 'collective'
      WHEN 'curator'         THEN 'curator'
      ELSE                        'community_group'
    END,
    g.description,
    g.website,
    g.phone,
    g.hero_image_url,
    g.category_tags,
    g.operating_hours,
    g.portal_account_id,
    g.created_at,
    g.updated_at
  FROM groups g
  ON CONFLICT (id) DO NOTHING;

  -- ==================================================================
  -- Step 2b: organizations from portal_accounts NOT already represented
  --          as groups. These get kind='local_business'.
  -- ==================================================================
  INSERT INTO organizations (
    slug, name, kind,
    description, url, telephone, image_url,
    primary_place_id, opening_hours_specification,
    owner_account_id,
    created_at, updated_at
  )
  SELECT
    -- Slug fallback for portal_accounts that lack one. Prefix avoids slug
    -- collision with anything else.
    COALESCE(NULLIF(pa.slug, ''), 'acct-' || LEFT(pa.id::text, 8)),
    pa.business_name,
    'local_business',
    pa.description,
    pa.website,
    pa.phone,
    pa.logo_url,
    (SELECT id FROM places p WHERE p.google_place_id = pa.default_place_id LIMIT 1),
    pa.operating_hours,
    pa.id,
    pa.created_at,
    pa.updated_at
  FROM portal_accounts pa
  WHERE NOT EXISTS (SELECT 1 FROM groups g WHERE g.portal_account_id = pa.id)
    AND pa.business_name IS NOT NULL
    AND TRIM(pa.business_name) != ''
  ON CONFLICT (slug) DO NOTHING;

  -- ==================================================================
  -- Step 2c: backfill primary_place_id for local_business orgs that came
  --          from groups (not portal_accounts) — look up via owner.
  -- ==================================================================
  UPDATE organizations o
    SET primary_place_id = (
      SELECT p.id
      FROM places p
      JOIN portal_accounts pa ON pa.default_place_id = p.google_place_id
      WHERE pa.id = o.owner_account_id
      LIMIT 1
    )
  WHERE o.primary_place_id IS NULL
    AND o.owner_account_id IS NOT NULL
    AND o.kind = 'local_business';

  SELECT COUNT(*) INTO v_orgs_after FROM organizations;
  RAISE NOTICE 'Step 2: organizations % → % (added %)', v_orgs_before, v_orgs_after, v_orgs_after - v_orgs_before;

  -- Sanity check: groups count should roughly equal new orgs from groups path
  IF v_groups_count > 0 AND (v_orgs_after - v_orgs_before) = 0 THEN
    RAISE WARNING 'No organizations created despite % groups existing. Check ON CONFLICT logic and source data.', v_groups_count;
  END IF;

  -- ==================================================================
  -- Step 3: organization_places from group_venues
  -- ==================================================================
  INSERT INTO organization_places (organization_id, place_id, is_primary, relationship)
  SELECT
    gv.group_id,
    p.id,
    COALESCE(gv.is_primary, false),
    'operates_at'
  FROM group_venues gv
  JOIN places p ON p.google_place_id = gv.place_id
  WHERE EXISTS (SELECT 1 FROM organizations o WHERE o.id = gv.group_id)
  ON CONFLICT (organization_id, place_id) DO NOTHING;

  SELECT COUNT(*) INTO v_org_places_after FROM organization_places;
  RAISE NOTICE 'Step 3: organization_places now %', v_org_places_after;

  -- ==================================================================
  -- Step 4: api_key_organization_links from api_key_account_links
  -- ==================================================================
  INSERT INTO api_key_organization_links (api_key_id, organization_id, created_at)
  SELECT DISTINCT
    akal.api_key_id,
    o.id,
    akal.linked_at
  FROM api_key_account_links akal
  JOIN organizations o ON o.owner_account_id = akal.portal_account_id
  ON CONFLICT (api_key_id, organization_id) DO NOTHING;

  SELECT COUNT(*) INTO v_links_after FROM api_key_organization_links;
  RAISE NOTICE 'Step 4: api_key_organization_links now %', v_links_after;

  -- ==================================================================
  -- Step 5: events.location_place_id from events.place_id (text) → places
  -- ==================================================================
  UPDATE events e
    SET location_place_id = p.id
  FROM places p
  WHERE e.place_id = p.google_place_id
    AND e.location_place_id IS NULL;

  -- ==================================================================
  -- Step 6a: events.organizer_org_id from events.group_id (1:1 by id)
  -- ==================================================================
  UPDATE events e
    SET organizer_org_id = e.group_id
  WHERE e.group_id IS NOT NULL
    AND e.organizer_org_id IS NULL
    AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = e.group_id);

  -- ==================================================================
  -- Step 6b: events.organizer_org_id from creator_account_id → owner of org
  -- ==================================================================
  UPDATE events e
    SET organizer_org_id = o.id
  FROM organizations o
  WHERE o.owner_account_id = e.creator_account_id
    AND e.organizer_org_id IS NULL
    AND e.organizer_person_id IS NULL
    AND e.creator_account_id IS NOT NULL;

  SELECT COUNT(*) INTO v_events_total FROM events;
  SELECT COUNT(*) INTO v_events_with_place FROM events WHERE location_place_id IS NOT NULL;
  SELECT COUNT(*) INTO v_events_with_org FROM events WHERE organizer_org_id IS NOT NULL;

  RAISE NOTICE 'Step 5/6: events with location_place_id: % / %', v_events_with_place, v_events_total;
  RAISE NOTICE 'Step 5/6: events with organizer_org_id: % / %', v_events_with_org, v_events_total;
  RAISE NOTICE 'Step 5/6: events without organizer (need manual link): %', v_events_total - v_events_with_org;

  RAISE NOTICE '=== Migration 074 backfill complete ===';

END $$;
