-- ============================================================================
-- Migration 046: Change events.creator_account_id from CASCADE to SET NULL
-- ============================================================================
-- Events are public data that should survive account deletion.
-- Previously ON DELETE CASCADE — deleting an account silently deleted
-- all its events. Now ON DELETE SET NULL — events remain with
-- creator_account_id = null.

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_creator_account_id_fkey;

ALTER TABLE events
  ADD CONSTRAINT events_creator_account_id_fkey
  FOREIGN KEY (creator_account_id)
  REFERENCES portal_accounts(id)
  ON DELETE SET NULL;
