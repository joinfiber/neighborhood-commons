-- ============================================================================
-- Migration 100: relabel bulk-imported orgs wrongly stamped `self_asserted`.
--
-- Before the 2026-06-03 fix to POST /service/organizations, the create handler
-- hardcoded method='self_asserted' on every organization it created — including
-- unclaimed bulk imports (scraped venues). `method` is the authority signal
-- consumers filter on (?method=self_asserted = first-party records), so those
-- rows over-claim first-party authority and a scraped venue is indistinguishable
-- from a verified first-party org.
--
-- The genuinely first-party orgs are a small, known set: those contributed by
-- Merrie (slug `merrie-co`) and Go There (slug `go-there-by-bike`) — the only
-- consumer apps routing real first-party org claims today. Everything else that
-- is self_asserted is a bulk import (Studio v2's importer, plus pre-090 rows
-- with a NULL contributor_profile_id). This demotes those to `seeded` — the
-- doctrine's "bulk-imported, awaiting first-party uptake" state
-- (docs/provenance.md). A seeded org is promoted back to self_asserted
-- automatically when it verifies (promoteOrganizationOnVerification, which only
-- flips `seeded`), so the claim lifecycle is preserved.
--
-- The discriminator is a pure ALLOW-LIST by contributor-profile slug. NOTE:
-- owner_account_id is deliberately NOT a guard. The bulk importer (Studio v2)
-- uses the trusted-tenant pattern, so its imports are *owned* — ownership here
-- means "the importer may edit it", not "the entity claimed itself", and does
-- not distinguish a claim from an import. (This is exactly the method /
-- write-ownership conflation the create-path fix untangled.)
--
-- Two carve-outs are the only things spared besides the allow-list — both are
-- genuine first-party signals a demotion must never erase:
--   - VERIFIED orgs — an active organization_verifications row. The live
--     verified state is status='active' (the enum is active/revoked; there is
--     no 'verified' value — migration 085's verified-branch used 'verified' and
--     was a no-op).
--   - WITNESS COLLECTIVES — app-native orgs ("Fiber Community", "Studio
--     Community", …) that are intrinsically self_asserted and carry a NULL
--     profile, so the slug allow-list alone wouldn't protect them. They are
--     identified by the hard naming convention `<App> Community` (collectiveName
--     = app name + " Community" in operator.ts / developers.ts). NOTE: we do NOT
--     identify them by a witness_authority-key link — the bulk importer (Studio
--     v2) ALSO holds witness_authority (it runs the Porchfest OCR path), so
--     every venue it auto-linked would falsely read as a collective.
-- Only `method` changes — ownership links and verification state are untouched.
--
-- Idempotent: re-running demotes nothing new (the rows are already `seeded`).
-- ============================================================================

BEGIN;

UPDATE organizations o
   SET method = 'seeded'
 WHERE o.method = 'self_asserted'
   -- not in the first-party allow-list (NULL profile is a bulk import too, so
   -- it must be included — `NOT IN` alone would spare it)
   AND (
     o.contributor_profile_id IS NULL
     OR o.contributor_profile_id NOT IN (
       SELECT id FROM contributor_profiles WHERE slug IN ('merrie-co', 'go-there-by-bike')
     )
   )
   -- carve-out 1: never demote a verified org
   AND NOT EXISTS (
     SELECT 1 FROM organization_verifications v
      WHERE v.organization_id = o.id
        AND v.status = 'active'
   )
   -- carve-out 2: never demote an app-native collective (`<App> Community`)
   AND o.name NOT ILIKE '% community';

COMMIT;
