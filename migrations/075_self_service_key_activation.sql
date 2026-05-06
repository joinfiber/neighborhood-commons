-- ============================================================================
-- Migration 075: self-service service-key activation
--
-- Lets developers self-issue service-tier api_keys that authenticate but
-- can't write to the Commons until a one-time review activates them.
--
-- New columns:
--   activated_at          — when the key was activated for live writes.
--                           NULL means "registered but pending activation"
--                           (service-tier keys only — middleware checks).
--                           For all existing keys, backfilled to created_at,
--                           since they were already active when issued.
--
--   application_metadata  — jsonb capturing what the developer told us at
--                           registration: app name + URL, what they're
--                           building, how they verify organizations,
--                           expected first-week write volume. The reviewer
--                           reads this when deciding to activate.
--
-- Why a separate column instead of overloading status='pending':
--   - status='active' on a registered-but-pending service key still lets
--     the holder authenticate for reads (with the service-tier rate limit),
--     so they can build their integration before activation.
--   - The middleware that gates writes (requireServiceApiKey) gets a clean
--     check: tier='service' AND activated_at IS NOT NULL → proceed; else
--     KEY_PENDING.
--   - Reusing status='pending' would have collided with the existing read
--     path (requireApiKey filters .eq('status','active'), so a pending
--     key would have been rejected for reads too — opposite of what we
--     want).
-- ============================================================================

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS activated_at         timestamptz,
  ADD COLUMN IF NOT EXISTS application_metadata jsonb;

-- Backfill: every existing key was active when issued.
UPDATE api_keys SET activated_at = created_at WHERE activated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_pending_activation
  ON api_keys(created_at)
  WHERE contributor_tier = 'service' AND activated_at IS NULL;

COMMENT ON COLUMN api_keys.activated_at IS
  'When the key was activated for live writes. NULL means the key is registered but pending one-time review (service tier only). Existing keys were backfilled to created_at since they were already active.';
COMMENT ON COLUMN api_keys.application_metadata IS
  'JSONB captured at self-service registration. Shape: { app_name, app_url, verification_process, expected_volume }. Read by the reviewer when deciding to activate; immutable after registration.';
