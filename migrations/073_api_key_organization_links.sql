-- ============================================================================
-- Migration 073: api_key_organization_links
--
-- Replaces the api_key_account_links pattern. Service-tier scoping —
-- which organizations each api_key may write to. Admin keys (is_admin=true)
-- bypass this check.
--
-- The legacy api_key_account_links table is NOT dropped here. Backfill (074)
-- copies its data forward; it then becomes dead-code-readable until v1.1.0
-- cleanup.
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_key_organization_links (
  api_key_id        uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_aokl_org ON api_key_organization_links(organization_id);

ALTER TABLE api_key_organization_links ENABLE ROW LEVEL SECURITY;
-- Service-only.

COMMENT ON TABLE api_key_organization_links IS 'Service-tier scoping. Which organizations each api_key may write to. Established via /service/organizations/link or by the create-org endpoint (which auto-links the calling key). Admin keys (api_keys.is_admin=true) bypass this check.';
