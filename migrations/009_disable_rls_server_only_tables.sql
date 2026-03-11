-- ============================================================================
-- Migration 009: Disable RLS on server-only tables
-- ============================================================================
-- These tables are only written by Express server code via supabaseAdmin.
-- No end user ever makes direct Supabase calls against them.
-- RLS adds complexity with zero security benefit here — the service role
-- key is server-side only, and PostgREST role mapping varies by Supabase
-- version, causing spurious RLS failures.
--
-- Keep RLS on tables where it matters: events (portal users query via
-- Supabase client with RLS), portal_accounts, etc.

ALTER TABLE api_keys DISABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions DISABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;

-- Drop the now-unnecessary policies (clean up)
DROP POLICY IF EXISTS "api_keys_service_role_all" ON api_keys;
DROP POLICY IF EXISTS "webhook_subscriptions_service_role_all" ON webhook_subscriptions;
DROP POLICY IF EXISTS "webhook_deliveries_service_role_all" ON webhook_deliveries;
DROP POLICY IF EXISTS "audit_logs_service_role_all" ON audit_logs;
