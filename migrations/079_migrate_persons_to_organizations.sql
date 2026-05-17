-- ============================================================================
-- Migration 079: migrate persons rows into organizations
--
-- Under v2, the persons primitive goes away. Solo performers, DJs, individual
-- hosts, etc. all become organizations — organizations-of-one. The unified
-- entity primitive is `organizations`.
--
-- This migration:
--   1. Copies each persons row into organizations (preserving id)
--      - slug collisions are handled by appending a deterministic suffix
--      - PII-flavored fields (given_name, family_name) are NOT migrated
--      - alternate_name (stage name) becomes the description if no description exists
--      - job_title becomes a tag entry
--      - kind is set to 'collective' (a generic default; this column drops in 082)
--      - tags includes 'solo-act' as a signal that this was previously a person
--   2. Updates events.organizer_person_id references to events.organizer_org_id
--      (preserving the UUID since id was preserved)
--   3. Updates lists.curator_person_id references to lists.curator_org_id
--   4. Updates account_verified_identifiers rows where target_type='person'
--      to target_type='organization' (target_id unchanged)
--
-- Idempotent. Reports counts via RAISE NOTICE. Safe on empty persons table.
--
-- Note: per migration 066 ("Pure create. Empty initially."), the persons
-- table is likely empty in most environments. This migration handles both
-- the empty and populated cases without surprise.
-- ============================================================================

DO $$
DECLARE
  v_persons_count       integer;
  v_migrated_count      integer;
  v_events_updated      integer;
  v_lists_updated       integer;
  v_verif_updated       integer;
BEGIN
  SELECT COUNT(*) INTO v_persons_count FROM persons;

  IF v_persons_count = 0 THEN
    RAISE NOTICE 'persons table is empty; nothing to migrate';
    RETURN;
  END IF;

  RAISE NOTICE 'Migrating % persons rows to organizations', v_persons_count;

  -- --------------------------------------------------------------------
  -- Step 1: Copy persons to organizations
  -- --------------------------------------------------------------------
  -- Preserve persons.id as organizations.id so all FK references continue
  -- to work without remapping. Slug collisions get a 'p-' prefix.
  -- PII fields (given_name, family_name) are deliberately not migrated —
  -- under v2 the Commons holds no PII, and even the legacy persons table
  -- shouldn't have had these populated in practice.

  INSERT INTO organizations (
    id, slug, name, kind,
    description, url, image_url,
    same_as, keywords, tags,
    commercial,
    owner_account_id,
    created_at, updated_at
  )
  SELECT
    p.id,
    -- Slug collision handling: append an 8-char UUID suffix on collision.
    -- Using a UUID-derived suffix (rather than a prefix like 'p-') ensures
    -- uniqueness even if 'p-<slug>' would also collide with an existing org.
    CASE
      WHEN EXISTS (SELECT 1 FROM organizations o WHERE o.slug = p.slug)
        THEN p.slug || '-' || LEFT(REPLACE(p.id::text, '-', ''), 8)
      ELSE p.slug
    END,
    p.name,
    'collective',  -- generic default; kind drops in migration 082
    -- description: prefer existing description; otherwise use alternate_name
    -- (stage name) if present, with a brief annotation
    COALESCE(
      p.description,
      CASE WHEN p.alternate_name IS NOT NULL
           THEN 'Also known as ' || p.alternate_name
           ELSE NULL
      END
    ),
    p.url,
    p.image_url,
    COALESCE(p.same_as, '[]'::jsonb),
    -- keywords: include job_title if present
    CASE WHEN p.job_title IS NOT NULL
         THEN ARRAY[p.job_title]
         ELSE '{}'::text[]
    END,
    -- tags: mark these as solo-act (signal they came from persons)
    -- plus any job_title-derived tag (lowercased, kebab-cased)
    CASE WHEN p.job_title IS NOT NULL
         THEN ARRAY['solo-act', LOWER(REGEXP_REPLACE(p.job_title, '[^a-zA-Z0-9]+', '-', 'g'))]
         ELSE ARRAY['solo-act']
    END,
    -- commercial: unknown for migrated persons; leave null
    NULL::boolean,
    p.owner_account_id,
    p.created_at,
    p.updated_at
  FROM persons p
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS v_migrated_count = ROW_COUNT;
  RAISE NOTICE 'Step 1: migrated % persons rows into organizations', v_migrated_count;

  -- --------------------------------------------------------------------
  -- Step 2: Re-point events.organizer_person_id → events.organizer_org_id
  -- --------------------------------------------------------------------
  -- The migrated org has the same UUID as the original person, so we can
  -- just copy organizer_person_id to organizer_org_id where the former
  -- is set. Existing organizer_org_id values are not overwritten (the
  -- exactly-one-organizer rule from migration 067 means an event has
  -- one or the other, not both).

  UPDATE events e
    SET organizer_org_id = e.organizer_person_id
  WHERE e.organizer_person_id IS NOT NULL
    AND e.organizer_org_id IS NULL
    AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = e.organizer_person_id);

  GET DIAGNOSTICS v_events_updated = ROW_COUNT;
  RAISE NOTICE 'Step 2: re-pointed % events.organizer_person_id → organizer_org_id', v_events_updated;

  -- --------------------------------------------------------------------
  -- Step 3: Re-point lists.curator_person_id → lists.curator_org_id
  -- --------------------------------------------------------------------

  UPDATE lists l
    SET curator_org_id = l.curator_person_id
  WHERE l.curator_person_id IS NOT NULL
    AND l.curator_org_id IS NULL
    AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = l.curator_person_id);

  GET DIAGNOSTICS v_lists_updated = ROW_COUNT;
  RAISE NOTICE 'Step 3: re-pointed % lists.curator_person_id → curator_org_id', v_lists_updated;

  -- --------------------------------------------------------------------
  -- Step 4: Update account_verified_identifiers where target_type='person'
  -- --------------------------------------------------------------------
  -- target_id stays the same (UUID preserved). target_type flips to
  -- 'organization' since the row is now an organization in v2.

  UPDATE account_verified_identifiers
    SET target_type = 'organization'
  WHERE target_type = 'person'
    AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = target_id);

  GET DIAGNOSTICS v_verif_updated = ROW_COUNT;
  RAISE NOTICE 'Step 4: flipped % verification rows from person to organization', v_verif_updated;

  -- verification_challenges.target_type and verification_pending_reviews.target_type
  -- get the same treatment for consistency.
  UPDATE verification_challenges
    SET target_type = 'organization'
  WHERE target_type = 'person'
    AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = target_id);

  UPDATE verification_pending_reviews
    SET target_type = 'organization'
  WHERE target_type = 'person'
    AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = target_id);

  RAISE NOTICE '=== Migration 079 complete ===';
  RAISE NOTICE 'Source persons rows: %', v_persons_count;
  RAISE NOTICE 'Organizations created: %', v_migrated_count;
  RAISE NOTICE 'Events re-pointed: %', v_events_updated;
  RAISE NOTICE 'Lists re-pointed: %', v_lists_updated;
  RAISE NOTICE 'Verification rows re-pointed: %', v_verif_updated;

END $$;
