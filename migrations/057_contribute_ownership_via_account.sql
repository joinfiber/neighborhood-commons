-- Migration 057: Decouple Contribute event ownership from API key identity
--
-- Problem: Contribute API ownership was checked via
--   .eq('source_feed_url', 'api-key:{apiKeyId}')
-- which bakes the key's UUID into every event row. Rotating an API key
-- silently destroys editorial control: the new key can't edit any events
-- created by the old key. PATCH/DELETE return 404. Merrie hit this in prod.
--
-- Fix: unify Contribute ownership on the same primitive the Service API
-- already uses — portal_accounts linked via api_key_account_links. An
-- account is the stable owner; keys are credentials that authenticate as
-- that owner. Rotation = issue a new key linked to the same account, then
-- revoke the old one. Editorial control survives.
--
-- This migration:
--   1. Adds an index on events.creator_account_id (used by every ownership query)
--   2. Backfills creator_account_id on existing api-sourced events from
--      source_feed_url, by joining through api_key_account_links.
--   3. Leaves source_feed_url alone — it remains a provenance/audit signal,
--      just not the auth signal anymore.
--
-- Events whose source key has no linked account are NOT backfilled here.
-- They require the operator runbook (see docs/runbook-merrie-recovery.md).

CREATE INDEX IF NOT EXISTS idx_events_creator_account_id
  ON events(creator_account_id) WHERE creator_account_id IS NOT NULL;

-- Backfill: join api-sourced events through api_key_account_links to find
-- the linked portal account for each event's originating key.
WITH api_owned AS (
  SELECT e.id AS event_id, l.portal_account_id
  FROM events e
  JOIN api_keys k
    ON e.source_feed_url = 'api-key:' || k.id::text
  JOIN api_key_account_links l
    ON l.api_key_id = k.id
  WHERE e.creator_account_id IS NULL
)
UPDATE events e
SET creator_account_id = api_owned.portal_account_id
FROM api_owned
WHERE e.id = api_owned.event_id;

-- Sanity: a key MUST have at most one linked account for ownership semantics
-- to be unambiguous. Today api_key_account_links allows N:N (PRIMARY KEY
-- (api_key_id, portal_account_id)). For Contribute keys we expect 1:1.
-- Service keys may legitimately link to many accounts (multi-tenant admin
-- tooling) so we don't add a global UNIQUE (api_key_id) constraint here.
-- The new POST /service/api-keys endpoint enforces 1:1 at creation time
-- for Contribute-tier keys; legacy multi-link keys remain as-is.

COMMENT ON INDEX idx_events_creator_account_id IS
  'Speeds up Contribute ownership checks: every PATCH/DELETE/GET-mine filters by creator_account_id.';
