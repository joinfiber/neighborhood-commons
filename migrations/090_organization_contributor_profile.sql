-- ============================================================================
-- Migration 090: organizations.contributor_profile_id
--
-- Brings organizations onto the same contributor-attribution model events
-- already have (migration 086). Lets the public read API filter organizations
-- by the app that contributed them (`created_by_contributor=<slug>`) via a
-- direct FK, instead of the fragile 3-hop join through rotatable api_keys
-- (owner_account_id -> api_keys.tenant_account_id -> contributor_profile_id).
--
-- Populated at write time by POST /service/organizations from the calling
-- key's contributor_profile_id. Backfilled here for existing rows where the
-- owning tenant maps unambiguously to a single contributor profile.
--
-- Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS contributor_profile_id uuid
    REFERENCES contributor_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_contributor_profile
  ON organizations(contributor_profile_id)
  WHERE contributor_profile_id IS NOT NULL;

COMMENT ON COLUMN organizations.contributor_profile_id IS
  'The app/pipeline that contributed this organization (the publishing-app axis, source.contributor). Set at write time by POST /service/organizations from the calling key''s contributor_profile_id; survives api_key rotation. Mirrors events.contributor_profile_id (migration 086). NULL for orgs created without a registered contributor profile.';

-- Backfill: resolve existing orgs through owner_account_id -> the tenant key's
-- contributor_profile_id. Only backfill tenants that map to exactly ONE distinct
-- profile, so an ambiguous tenant (keys bound to different profiles) is left
-- NULL rather than mis-attributed. Only touches currently-NULL rows, so re-runs
-- are no-ops.
UPDATE organizations o
SET contributor_profile_id = sub.cpid
FROM (
  SELECT tenant_account_id, MIN(contributor_profile_id) AS cpid
  FROM api_keys
  WHERE tenant_account_id IS NOT NULL
    AND contributor_profile_id IS NOT NULL
  GROUP BY tenant_account_id
  HAVING COUNT(DISTINCT contributor_profile_id) = 1
) sub
WHERE o.owner_account_id = sub.tenant_account_id
  AND o.contributor_profile_id IS NULL;

COMMIT;
