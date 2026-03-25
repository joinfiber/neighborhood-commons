-- Migration 037: Service API tier
--
-- Adds 'service' as a contributor_tier for API keys. Service keys
-- get full CRUD access to accounts and events via /api/v1/service/*.
-- This enables external admin tools (like the Fiber admin) to manage
-- the commons dataset without needing Supabase JWT auth.
--
-- Service keys are issued manually by the platform operator, not via
-- self-service registration. Rate limit: 10000/hr.

-- No schema change needed — contributor_tier is a text column without
-- a CHECK constraint. The application code enforces valid values.
-- This migration documents the new tier for reference.

COMMENT ON COLUMN api_keys.contributor_tier IS
  'Contributor trust level: pending (review required), verified (auto-publish), trusted (partner, higher limits), service (full CRUD, admin-level access)';
