-- ============================================================================
-- Migration 084: api_keys.tenant_account_id — trusted-tenant pattern
--
-- Adds an optional one-to-one binding between a service-tier API key and a
-- "tenant" portal_account. When set, the key represents that account — and
-- the v2 service-API treats it as the implicit owner of every Organization
-- the key creates (POST /service/organizations sets organizations.owner_account_id
-- from this column).
--
-- Why: the v2 photo-eligibility gate requires every organization to have a
-- claimed owner account. Tenant-umbrella consumers (Merrie, future
-- publication tools) don't have a portal_account per individual publisher
-- — they have one shared tenant account that owns all their orgs.
-- Before this column, that ownership relationship had nowhere to live;
-- the dropped api_key_account_links table modeled it as m2m, which was
-- wrong for the actual use case.
--
-- Idempotent. The reference is ON DELETE SET NULL so deleting a tenant
-- account doesn't cascade to revoking the key.
-- ============================================================================

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS tenant_account_id uuid
    REFERENCES portal_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_account
  ON api_keys(tenant_account_id) WHERE tenant_account_id IS NOT NULL;

COMMENT ON COLUMN api_keys.tenant_account_id IS
  'Trusted-tenant pattern (v2.1): the portal_account this service key represents. When set, POST /service/organizations sets the new org''s owner_account_id to this value, which satisfies the photo-eligibility gate. Optional — keys without a tenant account create orgs whose owner_account_id is NULL (photo uploads disabled for those orgs). One tenant per key by design.';
