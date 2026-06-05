-- ============================================================================
-- Migration 102: promote verified-but-ownerless orgs that migration 085 missed.
--
-- Migration 085 added organizations.method and backfilled verified orgs to
-- 'self_asserted'. Its verification branch was a latent no-op: it tested the
-- organization_verifications status against a 'verified' value, but that enum
-- is CHECK (status IN ('active','revoked')) (migration 080) — there is no
-- 'verified' state, and all runtime code reads the 'active' status to mean
-- "verified" (src/lib/verification-hydrate.ts, src/lib/verification.ts). So
-- 085's verification branch matched zero rows; only its owner_account_id
-- branch promoted anything.
--
-- Net effect: an org that was verified (an active organization_verifications
-- row) but had owner_account_id IS NULL when 085 ran was NOT promoted, and is
-- stuck at 'seeded' despite carrying first-party authority — and so is hidden
-- from consumers filtering ?method=self_asserted. This backfill promotes
-- exactly those rows, using the real status value.
--
-- Scope: repairs only the rows 085 missed. The ongoing path is already
-- correct — promoteOrganizationOnVerification (src/lib/verification.ts) flips
-- seeded → self_asserted whenever a new verification is created.
--
-- Interaction with migration 100 (relabel_seeded_org_method): that migration
-- demotes self_asserted → seeded only for orgs that are NOT verified (it skips
-- any org with an active verification). This migration promotes only orgs that
-- ARE verified. The two act on disjoint row sets and converge — re-running
-- either changes nothing further.
--
-- Idempotent: re-running promotes nothing new (the rows are already
-- self_asserted). Wrapped in a single transaction. Only `method` changes —
-- ownership and verification state are untouched.
-- ============================================================================

BEGIN;

UPDATE organizations o
   SET method = 'self_asserted'
 WHERE o.method = 'seeded'
   AND EXISTS (
     SELECT 1 FROM organization_verifications v
      WHERE v.organization_id = o.id
        AND v.status = 'active'
   );

COMMIT;
