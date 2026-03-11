-- ============================================================================
-- Migration 010: Clean up FORCE RLS flags + tighten api_keys nullability
-- ============================================================================
--
-- Issues found via schema audit (2026-03-11):
--
-- 1. api_keys and audit_logs have FORCE ROW LEVEL SECURITY left over from
--    migration 008, even though RLS is now disabled (migration 009).
--    FORCE is a no-op when RLS is disabled, but it's contradictory state
--    that could cause surprises on a Supabase/Postgres upgrade.
--
-- 2. api_keys.key_hash, key_prefix, and contact_email are nullable because
--    migration 007 added them as new columns. Every key requires all three —
--    tighten to NOT NULL now that the data has been backfilled.
--
-- 3. event_series has RLS enabled with only a service_role policy. This is
--    intentional — series are managed server-side only. Adding a comment
--    for future clarity but no schema change needed.

-- -------------------------------------------------------
-- 1. Clear stale FORCE ROW LEVEL SECURITY flags
-- -------------------------------------------------------

ALTER TABLE api_keys NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY;

-- -------------------------------------------------------
-- 2. Tighten api_keys nullable columns
-- -------------------------------------------------------
-- Backfill any NULLs defensively before adding constraints.
-- key_hash/key_prefix NULL would mean a key that can never be looked up —
-- these rows are broken and should be cleaned out.

DELETE FROM api_keys WHERE key_hash IS NULL;

ALTER TABLE api_keys ALTER COLUMN key_hash SET NOT NULL;
ALTER TABLE api_keys ALTER COLUMN key_prefix SET NOT NULL;
ALTER TABLE api_keys ALTER COLUMN contact_email SET NOT NULL;

-- -------------------------------------------------------
-- 3. Document event_series RLS intent (no schema change)
-- -------------------------------------------------------

COMMENT ON TABLE event_series IS
  'Recurring event templates. RLS enabled, service_role only — '
  'managed exclusively by server code. No authenticated user policies needed.';
