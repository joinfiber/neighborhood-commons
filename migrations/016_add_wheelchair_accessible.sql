-- 016: Add wheelchair accessibility
-- Account-level default with per-event override. NULL = not specified.

ALTER TABLE portal_accounts
  ADD COLUMN IF NOT EXISTS wheelchair_accessible boolean DEFAULT NULL;

COMMENT ON COLUMN portal_accounts.wheelchair_accessible IS
  'Venue-level wheelchair accessibility. NULL = not specified. Inherited by events unless overridden.';

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS wheelchair_accessible boolean DEFAULT NULL;

COMMENT ON COLUMN events.wheelchair_accessible IS
  'Per-event wheelchair accessibility. NULL = inherit from portal_accounts. Explicit true/false overrides account default.';
