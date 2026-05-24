-- ============================================================================
-- Migration 092: backfill events.contributor_profile_id
--
-- Migration 086 added events.contributor_profile_id and intended the
-- service-event write path to populate it ("PR 2"), with a later retrofit of
-- pre-existing rows ("PR 5"). The write-path stamp ships alongside this
-- migration (src/routes/service/events.ts now sets it from the calling key,
-- mirroring POST /service/organizations). This migration is the retrofit:
-- it links existing events to a contributor profile so the read API surfaces
-- the rich "via <app>" card (event-transform.buildContributor) for events
-- published before the stamp.
--
-- Best-effort, same shape as migration 090 (organizations): resolve through
-- events.creator_account_id -> the tenant key's contributor_profile_id, only
-- where the tenant maps to exactly ONE distinct profile, so an ambiguous
-- tenant (keys bound to different profiles) is left NULL rather than
-- mis-attributed. Only touches currently-NULL rows, so re-runs are no-ops.
--
-- NOTE: this only links events whose contributing app has a registered
-- contributor_profile bound to its key (api_keys.contributor_profile_id).
-- Consumers without a registered profile keep the name-only snapshot.
--
-- Idempotent.
-- ============================================================================

BEGIN;

UPDATE events e
SET contributor_profile_id = sub.cpid
FROM (
  -- Postgres has no MIN(uuid) aggregate. The HAVING clause guarantees a single
  -- distinct profile per group, so MIN over the text form cast back to uuid
  -- deterministically yields that one value. (Same idiom as migration 090.)
  SELECT tenant_account_id, MIN(contributor_profile_id::text)::uuid AS cpid
  FROM api_keys
  WHERE tenant_account_id IS NOT NULL
    AND contributor_profile_id IS NOT NULL
  GROUP BY tenant_account_id
  HAVING COUNT(DISTINCT contributor_profile_id) = 1
) sub
WHERE e.creator_account_id = sub.tenant_account_id
  AND e.contributor_profile_id IS NULL;

COMMIT;
