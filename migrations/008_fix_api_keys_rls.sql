-- ============================================================================
-- Migration 008: Fix api_keys RLS policy for service_role
-- ============================================================================
-- The api_keys table has FORCE ROW LEVEL SECURITY enabled (good — defense
-- in depth). But the service_role policy may have been dropped or not
-- applied correctly, causing INSERT failures from supabaseAdmin.
--
-- This migration re-asserts the policy. Safe to run if it already exists.

-- Ensure RLS is enabled (should already be)
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Re-create the service_role policy (drop first to avoid conflicts)
DROP POLICY IF EXISTS "api_keys_service_role_all" ON api_keys;
CREATE POLICY "api_keys_service_role_all"
  ON api_keys FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Keep forced RLS — service_role access is explicitly granted above,
-- and we don't want the table owner to bypass policies silently.
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
