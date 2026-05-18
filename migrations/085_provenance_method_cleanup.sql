-- ============================================================================
-- Migration 085: v2 substrate cleanup — standard provenance method across primitives.
--
-- See docs/provenance.md and docs/four-roles.md for the doctrine motivating
-- this change.
--
-- Changes:
--   1. events.source_method values normalized to the standard vocabulary
--      ('self_asserted', 'proxied', 'witnessed') with NOT NULL and check
--      constraint enforcing it.
--   2. events.source_publisher dropped — the role "who is this from?" is
--      filled by organizer.name (the joined organizations row).
--   3. organizations.method added — defaults to 'seeded' for bulk-imported
--      rows; verified orgs (rows with a verified organization_verifications
--      entry) are backfilled to 'self_asserted'.
--   4. broadcasts.method added — only 'self_asserted' is valid today; the
--      field exists for symmetry and to admit additive future values.
--   5. lists.method added — same shape as broadcasts.
--
-- Pre-launch coherent fix. No external consumers have built against the
-- v2.0.0 draft contract; this PR establishes the model the v3 launch will
-- ship with. The "additive-only stability" promise begins at launch, not
-- against this draft.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Normalize events.source_method values
-- ---------------------------------------------------------------------------
-- Legacy → standard mapping:
--   'api', 'portal', 'admin', 'merrie'  → 'self_asserted'
--      (first-party assertions by the organizer, routed through different
--       code paths over time)
--   'import', 'feed', 'csv'             → 'proxied'
--      (third-party data extracted from a public source by a pipeline)
--   'witnessed'                          → 'witnessed' (unchanged)

UPDATE events
   SET source_method = 'self_asserted'
 WHERE source_method IN ('api', 'portal', 'admin', 'merrie');

UPDATE events
   SET source_method = 'proxied'
 WHERE source_method IN ('import', 'feed', 'csv');

-- Aggressive backstop: anything not exactly matching one of the three
-- standard values — including NULL, whitespace variants, mixed case, or
-- legacy values we didn't enumerate above — collapses to 'self_asserted'.
-- source_method is operational metadata; over-correcting is preferable to
-- migration failure. Log the count for after-the-fact review.
DO $$
DECLARE coerced_count int;
BEGIN
  SELECT count(*) INTO coerced_count FROM events
   WHERE source_method IS NULL
      OR source_method NOT IN ('self_asserted', 'proxied', 'witnessed');
  IF coerced_count > 0 THEN
    RAISE NOTICE 'Migration 085: coercing % event rows to source_method=self_asserted (unexpected legacy values or NULLs)', coerced_count;
    UPDATE events SET source_method = 'self_asserted'
     WHERE source_method IS NULL
        OR source_method NOT IN ('self_asserted', 'proxied', 'witnessed');
  END IF;
END $$;

ALTER TABLE events ALTER COLUMN source_method SET NOT NULL;
ALTER TABLE events ALTER COLUMN source_method SET DEFAULT 'self_asserted';

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_source_method_check;
ALTER TABLE events
  ADD CONSTRAINT events_source_method_check
  CHECK (source_method IN ('self_asserted', 'proxied', 'witnessed'));

COMMENT ON COLUMN events.source_method IS
  'Standard provenance method (see docs/provenance.md). Values: self_asserted (organizer asserted via contributor), proxied (contributor extracted from a public URL; source_feed_url carries the URL), witnessed (contributor observed with evidence under a collective identity).';

-- ---------------------------------------------------------------------------
-- 2. Drop events.source_publisher
-- ---------------------------------------------------------------------------
-- The role "who is this from?" is answered by organizer.name (joined from
-- organizations via organizer_org_id, which is NOT NULL post-migration 081).
-- The legacy slot conflated organizer-name with contributor-name and
-- produced real downstream bugs (PorchFest-2026 visibility regression).

ALTER TABLE events DROP COLUMN IF EXISTS source_publisher;

-- ---------------------------------------------------------------------------
-- 3. Add organizations.method
-- ---------------------------------------------------------------------------
-- Default 'seeded' for existing rows — they were almost all bulk-imported
-- or auto-created without first-party assertion. The backfill below
-- promotes verified orgs to 'self_asserted'. New rows created via
-- POST /service/organizations should pass method='self_asserted' (the
-- developer is asserting on behalf of the org via their contributor).

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'seeded';

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_method_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_method_check
  CHECK (method IN ('self_asserted', 'proxied', 'witnessed', 'seeded'));

-- Backfill: orgs are first-party-asserted ('self_asserted') when there's
-- a human-mediated act of assertion behind them. Two signals capture this:
--   (a) a verified organization_verifications record exists — the org has
--       completed an explicit verification flow.
--   (b) owner_account_id is set — a portal_account has claimed ownership,
--       either via direct OTP claim or via the trusted-tenant pattern
--       (a service consumer's tenant account vouches for the org).
-- Orgs with neither signal remain 'seeded' (bulk-imported, awaiting uptake).
UPDATE organizations o
   SET method = 'self_asserted'
 WHERE EXISTS (
   SELECT 1 FROM organization_verifications v
    WHERE v.organization_id = o.id
      AND v.status = 'verified'
 )
    OR o.owner_account_id IS NOT NULL;

COMMENT ON COLUMN organizations.method IS
  'Standard provenance method (see docs/provenance.md). self_asserted (verified first-party claim), proxied (extracted from a public source), witnessed (collective observation with evidence), seeded (bulk-imported, awaiting first-party uptake).';

-- ---------------------------------------------------------------------------
-- 4. Add broadcasts.method
-- ---------------------------------------------------------------------------
-- Broadcasts are first-party signals from an organization; only
-- 'self_asserted' is valid today. The field exists for symmetry and to
-- admit additive future values without retrofit.

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'self_asserted';

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_method_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_method_check
  CHECK (method IN ('self_asserted'));

COMMENT ON COLUMN broadcasts.method IS
  'Standard provenance method (see docs/provenance.md). Only self_asserted is valid today — broadcasts are always first-party from the organization. Field exists for symmetry across primitives.';

-- ---------------------------------------------------------------------------
-- 5. Add lists.method
-- ---------------------------------------------------------------------------
-- Lists are editorial assertions by the curator; only 'self_asserted' is
-- valid today. Same shape as broadcasts.

ALTER TABLE lists
  ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'self_asserted';

ALTER TABLE lists DROP CONSTRAINT IF EXISTS lists_method_check;
ALTER TABLE lists
  ADD CONSTRAINT lists_method_check
  CHECK (method IN ('self_asserted'));

COMMENT ON COLUMN lists.method IS
  'Standard provenance method (see docs/provenance.md). Only self_asserted is valid today — lists are editorial assertions by the curator. Field exists for symmetry across primitives.';

COMMIT;
