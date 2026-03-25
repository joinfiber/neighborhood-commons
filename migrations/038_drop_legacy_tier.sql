-- Migration 038: Drop legacy tier column from api_keys
--
-- The `tier` column was the original tiering system (free/pro/enterprise)
-- but was simplified in migration 004 to always be 'free'. Access control
-- moved to `contributor_tier` (pending/verified/trusted/service) in
-- migration 021. The `tier` column has been dead weight since then.
--
-- Rate limits come from `rate_limit_per_hour`, not tier.
-- Access control comes from `contributor_tier`, not tier.

ALTER TABLE api_keys DROP COLUMN IF EXISTS tier;
