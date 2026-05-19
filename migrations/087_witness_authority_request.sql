-- ============================================================================
-- Migration 087: developer self-service witness authority requests
--
-- Lets a developer request the witness_authority capability from their
-- dashboard without operator intervention up front. The operator approves
-- the request with one click in /operator/applications.
--
-- Previously, witness_authority was granted only at activation via the
-- /operator/applications/:id/approve-witnessing route (PR 4c). That
-- required the operator to divine the intent from the application copy.
-- Per the design discussion 2026-05-19: equip every developer with their
-- collective Organization at activation (no schema change needed — the
-- existing organizations + api_key_organization_links tables handle it),
-- and use this new column to capture witness-authority intent post-hoc.
--
-- Flow:
--   1. Dev clicks "Request witnessing capability" on the dashboard.
--      → POST /developers/collective/request-witnessing
--      → SET api_keys.witness_authority_requested_at = now()
--   2. Operator sees the request in /operator/applications.
--   3. Operator clicks "Grant witnessing".
--      → POST /operator/applications/:id/grant-witnessing
--      → SET api_keys.witness_authority = true, witness_authority_requested_at = null.
--   4. Developer is notified by email.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS witness_authority_requested_at timestamptz;

COMMENT ON COLUMN api_keys.witness_authority_requested_at IS
  'Set when the developer requests the witness_authority capability via the dashboard. Cleared (back to NULL) when the operator grants the request via /operator/applications/:id/grant-witnessing — at which point witness_authority becomes true. Operator panel surfaces pending requests via WHERE witness_authority_requested_at IS NOT NULL AND witness_authority = false.';

-- Index for the operator-side query that finds pending requests.
CREATE INDEX IF NOT EXISTS idx_api_keys_witness_request_pending
  ON api_keys(witness_authority_requested_at)
  WHERE witness_authority_requested_at IS NOT NULL AND witness_authority = false;
