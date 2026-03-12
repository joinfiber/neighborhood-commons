-- ============================================================================
-- Migration 012: Re-enable RLS on server-only tables
-- ============================================================================
-- Migration 009 disabled RLS on these tables because they are only accessed
-- via supabaseAdmin (service role) in Express. However, the Supabase anon key
-- is embedded in the portal SPA and can be extracted by anyone. Without RLS,
-- the anon role can read/write these tables directly via PostgREST, bypassing
-- Express entirely.
--
-- Fix: re-enable RLS and create policies that deny anon/authenticated access
-- while allowing the service role (which bypasses RLS) to continue working.

-- Re-enable RLS
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- No policies needed: with RLS enabled and zero policies granting access,
-- anon and authenticated roles are denied by default. The service_role
-- bypasses RLS entirely, so supabaseAdmin continues to work unchanged.
--
-- This is the simplest and most secure configuration:
-- - anon: DENIED (no policy grants access)
-- - authenticated: DENIED (no policy grants access)
-- - service_role: ALLOWED (bypasses RLS)
