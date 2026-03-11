-- Align portal_accounts column names with code expectations.
-- The code (copied from the social app) expects: default_venue_name, default_place_id,
-- default_address, default_latitude, default_longitude, website.
-- The initial migration used: venue_name, venue_address, place_id, latitude, longitude, website_url.
-- This migration renames to match the code. Safe to re-run.

-- Also adds last_login_at (referenced by whoami endpoint).

DO $$
BEGIN
  -- venue_name → default_venue_name
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'portal_accounts' AND column_name = 'venue_name') THEN
    ALTER TABLE portal_accounts RENAME COLUMN venue_name TO default_venue_name;
  END IF;

  -- venue_address → default_address
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'portal_accounts' AND column_name = 'venue_address') THEN
    ALTER TABLE portal_accounts RENAME COLUMN venue_address TO default_address;
  END IF;

  -- place_id → default_place_id (only on portal_accounts, not events)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'portal_accounts' AND column_name = 'place_id') THEN
    ALTER TABLE portal_accounts RENAME COLUMN place_id TO default_place_id;
  END IF;

  -- latitude → default_latitude (only on portal_accounts, not events)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'portal_accounts' AND column_name = 'latitude'
    AND table_schema = 'public') THEN
    ALTER TABLE portal_accounts RENAME COLUMN latitude TO default_latitude;
  END IF;

  -- longitude → default_longitude (only on portal_accounts, not events)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'portal_accounts' AND column_name = 'longitude'
    AND table_schema = 'public') THEN
    ALTER TABLE portal_accounts RENAME COLUMN longitude TO default_longitude;
  END IF;

  -- website_url → website
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'portal_accounts' AND column_name = 'website_url') THEN
    ALTER TABLE portal_accounts RENAME COLUMN website_url TO website;
  END IF;
END $$;

-- Add last_login_at if missing (whoami endpoint updates this on login)
ALTER TABLE portal_accounts ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
