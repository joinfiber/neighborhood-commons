-- 051: Scoped Service Keys
-- Consumer apps (Merrie, future apps) get service keys scoped to the
-- portal accounts they've linked. A service key can only CRUD events
-- for accounts it's linked to. Admin keys bypass scoping.

-- Join table: which portal accounts a service key can manage
CREATE TABLE IF NOT EXISTS api_key_account_links (
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  portal_account_id uuid NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, portal_account_id)
);

ALTER TABLE api_key_account_links ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_api_key_account_links_key
  ON api_key_account_links(api_key_id);

CREATE INDEX IF NOT EXISTS idx_api_key_account_links_account
  ON api_key_account_links(portal_account_id);

COMMENT ON TABLE api_key_account_links IS
  'Links service API keys to the portal accounts they can manage. Scoped access: a key can only modify data owned by linked accounts.';

-- Admin flag on api_keys (full access, bypasses scoping)
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

-- Which consumer app first linked this account
ALTER TABLE portal_accounts ADD COLUMN IF NOT EXISTS claimed_by text;

-- Backfill: existing claimed accounts were claimed via the portal
UPDATE portal_accounts SET claimed_by = 'portal' WHERE claimed_at IS NOT NULL AND claimed_by IS NULL;
