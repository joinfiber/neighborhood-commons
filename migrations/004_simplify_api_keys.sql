-- ============================================================================
-- Migration 004: Simplify api_keys — one tier, one rate limit
-- ============================================================================
-- Fiber Commons has one product: free event data at 1000 req/hr.
-- Remove the tier system. All keys are equal.

-- Drop the tier CHECK constraint and default to 'free' (kept for column compat)
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_tier_check;
ALTER TABLE api_keys ALTER COLUMN tier SET DEFAULT 'free';
UPDATE api_keys SET tier = 'free' WHERE tier != 'free';

-- Normalize rate limit to 1000 for all keys
UPDATE api_keys SET rate_limit_per_hour = 1000 WHERE rate_limit_per_hour != 1000;

COMMENT ON TABLE api_keys IS
  'API keys for the Neighborhood API. Free, 1000 requests/hour.';
