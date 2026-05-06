-- ============================================================================
-- Migration 076: clear the legacy first_party flag
--
-- Backstory: pre-1.0 the portal route auto-set first_party=true on every
-- portal-submitted event ("Portal events are always entered by the
-- originator"). That logic predates the 1.0 verification system. After
-- the user-facing reframe to a two-tier authority model — public-facts vs
-- first-party — first_party is supposed to mean "posted by a business
-- whose identifier is verified," not "posted via the portal." Today no
-- organizations are verified, so no events should be first-party. Any
-- existing events with first_party=true were mislabeled by the legacy
-- portal logic.
--
-- This migration zeroes out the legacy flag. Going forward the write
-- path computes first_party server-side from the organizer's verification
-- state at insert time, so the flag is correct by construction.
--
-- Idempotent. Reports the affected count via RAISE NOTICE.
-- ============================================================================

DO $$
DECLARE
  affected integer;
BEGIN
  UPDATE events SET first_party = false WHERE first_party = true;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE NOTICE 'Cleared first_party flag on % events (legacy portal mislabel)', affected;
END $$;
