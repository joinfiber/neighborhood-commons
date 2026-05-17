-- ============================================================================
-- Migration 077: scrub photo uploads from scraper-created portal accounts
--
-- Studio's scrape pipeline auto-creates unclaimed portal_accounts for venues
-- it ingests (Ukie Club, Kung Fu Necktie, etc.). Photos got uploaded to
-- Commons hosting against those synthetic accounts despite no real user
-- being behind them. Per the photo rule — only confirmed user accounts or
-- verified businesses may contribute photos — these need to go.
--
-- Also reverts a leftover test claim on Johnny Brenda's, which brings its
-- 9 photo'd events into scope of the same scrub.
--
-- Idempotent. Reports affected counts via RAISE NOTICE.
-- ============================================================================

DO $$
DECLARE
  reverted integer;
  nulled integer;
BEGIN
  -- Revert leftover test claim on Johnny Brenda's account.
  UPDATE portal_accounts
  SET auth_user_id = NULL
  WHERE id = '88b8f032-f622-4848-a045-3fdc9feba241'
    AND auth_user_id IS NOT NULL;
  GET DIAGNOSTICS reverted = ROW_COUNT;
  RAISE NOTICE 'Reverted % portal_accounts claim (Johnny Brenda''s test cleanup)', reverted;

  -- Null event_image_url for events whose creator account is unclaimed.
  -- Unclaimed creator = no real user behind the account = photo was not
  -- contributed under any TOS-bound upload path.
  UPDATE events
  SET event_image_url = NULL
  FROM portal_accounts pa
  WHERE events.creator_account_id = pa.id
    AND events.event_image_url IS NOT NULL
    AND pa.auth_user_id IS NULL;
  GET DIAGNOSTICS nulled = ROW_COUNT;
  RAISE NOTICE 'Nulled event_image_url on % events (unclaimed creator)', nulled;
END $$;
