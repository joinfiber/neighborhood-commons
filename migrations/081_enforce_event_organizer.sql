-- ============================================================================
-- Migration 081: enforce events.organizer_org_id (NOT NULL)
--
-- Under v2's constrained-publishing model, every event has an authoritative
-- organizer. Migration 067 added the organizer_org_id column; migration 074
-- backfilled it from creator_account_id and group_id. This migration
-- completes the work:
--
--   1. Final backfill via location_place_id → primary organization at that place
--   2. Catch-all backfill via creator_account_id (in case new orphan rows
--      appeared after 074)
--   3. Create a placeholder "Unknown Organizer" organization for any events
--      that still have no organizer (Studio ingestion edge cases, pre-org
--      legacy rows). Operator can manually reassign or purge these later.
--   4. Add NOT NULL constraint on events.organizer_org_id
--
-- After this migration, events.organizer_org_id is the load-bearing
-- authority anchor for every event row.
--
-- Idempotent. Reports counts via RAISE NOTICE.
-- ============================================================================

DO $$
DECLARE
  v_total_before    integer;
  v_orphan_before   integer;
  v_place_backfill  integer;
  v_creator_backfill integer;
  v_placeholder_id  uuid;
  v_placeholder_assigned integer;
  v_orphan_after    integer;
BEGIN
  SELECT COUNT(*) INTO v_total_before FROM events;
  SELECT COUNT(*) INTO v_orphan_before FROM events WHERE organizer_org_id IS NULL;

  RAISE NOTICE 'Starting: % total events, % missing organizer_org_id', v_total_before, v_orphan_before;

  IF v_orphan_before = 0 THEN
    RAISE NOTICE 'All events already have organizer_org_id set; skipping backfill';
  ELSE

    -- --------------------------------------------------------------------
    -- Step 1: Backfill via location_place_id → primary organization
    -- --------------------------------------------------------------------
    -- For events at a Place where exactly one organization is linked as
    -- primary, that org is the de facto organizer. We don't backfill when
    -- there's ambiguity (multiple primary orgs at the same place) — that
    -- needs human review.

    UPDATE events e
      SET organizer_org_id = sub.org_id
    FROM (
      SELECT
        op.place_id,
        op.organization_id AS org_id
      FROM organization_places op
      WHERE op.is_primary = true
        AND op.place_id IN (
          SELECT op2.place_id
          FROM organization_places op2
          WHERE op2.is_primary = true
          GROUP BY op2.place_id
          HAVING COUNT(*) = 1
        )
    ) sub
    WHERE e.organizer_org_id IS NULL
      AND e.location_place_id = sub.place_id;

    GET DIAGNOSTICS v_place_backfill = ROW_COUNT;
    RAISE NOTICE 'Step 1: backfilled % events from location_place_id → primary org', v_place_backfill;

    -- --------------------------------------------------------------------
    -- Step 2: Catch-all backfill via creator_account_id
    -- --------------------------------------------------------------------
    -- Re-run 074 step 6b's logic in case new rows came in since.

    UPDATE events e
      SET organizer_org_id = o.id
    FROM organizations o
    WHERE o.owner_account_id = e.creator_account_id
      AND e.organizer_org_id IS NULL
      AND e.creator_account_id IS NOT NULL;

    GET DIAGNOSTICS v_creator_backfill = ROW_COUNT;
    RAISE NOTICE 'Step 2: backfilled % events from creator_account_id → org', v_creator_backfill;

    -- --------------------------------------------------------------------
    -- Step 3: Placeholder organization for remaining orphans
    -- --------------------------------------------------------------------
    -- Create (idempotently) an "Unknown Organizer" placeholder. Assign all
    -- remaining orphan events to it so the NOT NULL constraint can apply.
    -- Operator can manually reassign or purge these via Studio later.

    INSERT INTO organizations (
      slug, name, kind,
      description,
      tags,
      commercial,
      created_at, updated_at
    ) VALUES (
      'unknown-organizer',
      'Unknown Organizer',
      'collective',
      'Placeholder for events whose original organizer could not be determined during v2 migration. Reassignable or removable via Studio.',
      ARRAY['placeholder', 'pending-attribution']::text[],
      false,
      now(), now()
    )
    ON CONFLICT (slug) DO NOTHING;

    SELECT id INTO v_placeholder_id FROM organizations WHERE slug = 'unknown-organizer';

    UPDATE events
      SET organizer_org_id = v_placeholder_id
    WHERE organizer_org_id IS NULL;

    GET DIAGNOSTICS v_placeholder_assigned = ROW_COUNT;

    IF v_placeholder_assigned > 0 THEN
      RAISE NOTICE 'Step 3: assigned % orphan events to Unknown Organizer placeholder (slug: unknown-organizer)', v_placeholder_assigned;
      RAISE NOTICE 'Operator can review and reassign these via: SELECT id, content, place_name, event_at FROM events WHERE organizer_org_id = %', v_placeholder_id;
    ELSE
      RAISE NOTICE 'Step 3: no orphan events needed placeholder assignment';
    END IF;
  END IF;

  -- --------------------------------------------------------------------
  -- Step 4: Verify and add NOT NULL constraint
  -- --------------------------------------------------------------------
  SELECT COUNT(*) INTO v_orphan_after FROM events WHERE organizer_org_id IS NULL;

  IF v_orphan_after > 0 THEN
    RAISE EXCEPTION 'After backfill, % events still have NULL organizer_org_id. Cannot apply NOT NULL constraint.', v_orphan_after;
  END IF;

  -- Add NOT NULL if not already set
  ALTER TABLE events
    ALTER COLUMN organizer_org_id SET NOT NULL;

  RAISE NOTICE 'Step 4: events.organizer_org_id is now NOT NULL';

  RAISE NOTICE '=== Migration 081 complete ===';
  RAISE NOTICE 'Total events: %', v_total_before;
  RAISE NOTICE 'Orphans at start: %', v_orphan_before;
  RAISE NOTICE 'Orphans at end: %', v_orphan_after;

END $$;
