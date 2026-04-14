# Runbook: Recover a Contribute API key after the ownership migration

**When to use:** A consumer (Merrie, partner app) reports they can't PATCH or DELETE events that they previously created. After migration 057 lands, ownership is by linked account; a key with no linked account returns `403 KEY_NOT_LINKED` on writes.

This runbook handles the two recovery cases that migration 057 cannot do automatically.

## Step 1 — Identify the key

Get the key prefix (first ~12 chars of the raw key) from the consumer or from their environment. Then:

```sql
SELECT id, key_prefix, name, contact_email, contributor_tier, status, created_at
FROM api_keys
WHERE key_prefix LIKE 'nc_xxxxxxxx%';
```

If the key is `status='revoked'`, it can't be used at all — issue a new one (Step 4) instead.

## Step 2 — Check whether it has a linked account

```sql
SELECT l.portal_account_id, p.business_name, p.email, p.status
FROM api_key_account_links l
JOIN portal_accounts p ON p.id = l.portal_account_id
WHERE l.api_key_id = '<key-id-from-step-1>';
```

**If a row comes back:** the key is already linked. Migration 057's backfill already worked — events with `source_feed_url = 'api-key:<this-key-id>'` should have `creator_account_id` set to this account. Verify:

```sql
SELECT count(*) FILTER (WHERE creator_account_id IS NULL) AS missing,
       count(*) AS total
FROM events
WHERE source_feed_url = 'api-key:<key-id>'
  AND source_method = 'api';
```

If `missing > 0`, run the backfill explicitly:

```sql
UPDATE events
SET creator_account_id = '<linked-account-id>'
WHERE source_feed_url = 'api-key:<key-id>'
  AND source_method = 'api'
  AND creator_account_id IS NULL;
```

Done. Consumer can PATCH/DELETE again.

**If no row comes back:** key is unlinked — proceed to Step 3.

## Step 3 — Link the existing key to an account

Find or create the account that should own this key's events. For Merrie:

```sql
-- Look for an existing account that represents Merrie
SELECT id, business_name, email, status
FROM portal_accounts
WHERE email ILIKE '%merrie%' OR business_name ILIKE '%merrie%';
```

If one exists, link the key to it. If not, create a minimal account first:

```sql
INSERT INTO portal_accounts (business_name, email, status)
VALUES ('Merrie', 'admin@merrie.co', 'active')
RETURNING id;
```

Then link:

```sql
INSERT INTO api_key_account_links (api_key_id, portal_account_id)
VALUES ('<key-id>', '<account-id>');
```

Backfill ownership on this key's existing events:

```sql
UPDATE events
SET creator_account_id = '<account-id>'
WHERE source_feed_url = 'api-key:<key-id>'
  AND source_method = 'api'
  AND creator_account_id IS NULL;
```

The consumer can now PATCH/DELETE these events. No code change on their side, no key change — the link is server-side.

## Step 4 — Recover events from a key that no longer exists

If the consumer rotated their key in env without telling you, and the old key was already revoked or deleted from `api_keys`, the events are stranded. The consumer's logs should have the old key UUID (or the prefix from any old `[CONTRIBUTE]` log lines).

```sql
-- Find stranded events (no creator_account_id, source_feed_url references a key not in api_keys)
SELECT count(*)
FROM events e
WHERE e.source_method = 'api'
  AND e.creator_account_id IS NULL
  AND e.source_feed_url = 'api-key:<OLD-KEY-UUID>';
```

Reassign them to the consumer's current account:

```sql
UPDATE events
SET creator_account_id = '<current-account-id>'
WHERE source_feed_url = 'api-key:<OLD-KEY-UUID>'
  AND source_method = 'api'
  AND creator_account_id IS NULL;
```

## Step 5 — Verify

Have the consumer attempt the failing operation. Expected: success, plus a webhook firing if the change crossed `published` status.

If they're still seeing 403 `KEY_NOT_LINKED`, the API key middleware cache may need a request to refresh — try a fresh request.

If they're seeing 404 on a specific event, double-check `creator_account_id` on that row matches the account you linked.

## Going forward

New API keys must be issued via `POST /service/api-keys` with an `account_id` for non-service tiers — that endpoint enforces the link at creation, so this runbook will not be needed for new integrations. Keep it around for legacy keys that pre-date migration 057.
