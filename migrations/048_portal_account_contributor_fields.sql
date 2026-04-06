-- ============================================================================
-- Migration 048: Add contributor-oriented fields to portal_accounts
-- ============================================================================
-- The portal is evolving to serve data contributors (developers, community orgs)
-- alongside venue operators. These fields capture contributor identity without
-- removing existing venue fields (backward compatible).

ALTER TABLE portal_accounts ADD COLUMN IF NOT EXISTS organization_name text;

ALTER TABLE portal_accounts ADD COLUMN IF NOT EXISTS contributor_type text
  CHECK (contributor_type IN ('developer', 'community_org', 'government', 'media', 'individual', 'other'));

ALTER TABLE portal_accounts ADD COLUMN IF NOT EXISTS data_description text;

COMMENT ON COLUMN portal_accounts.organization_name IS
  'Contributor organization or project name. Displayed in source attribution.';

COMMENT ON COLUMN portal_accounts.contributor_type IS
  'What kind of contributor: developer, community_org, government, media, individual, other.';

COMMENT ON COLUMN portal_accounts.data_description IS
  'Free-text description of the kind of data this contributor provides.';
