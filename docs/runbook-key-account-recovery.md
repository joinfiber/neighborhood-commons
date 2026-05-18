# Runbook: Service key can't write to a consumer's events

**When to use:** A consumer reports they can't PATCH or DELETE events that they previously created (or that another tool created on their behalf). Symptom: API returns `403 NOT_LINKED` or `403 NO_OWNER` on writes.

This runbook handles the v3 authority model: writes are gated by `api_key_organization_links` — the calling key must be linked to the event's `organizer_org_id` (or be admin, or be writing a witnessed event with `witness_authority`).

For the older "missing tenant portal_account for photo uploads" failure (`IMAGE_NOT_PERMITTED`), see the trusted-tenant pattern in [`CLAUDE.md`](../CLAUDE.md) and migration 084.

## Step 1 — Identify the key

Get the key prefix (first ~12 chars of the raw key) from the consumer or from their environment. Then:

```sql
SELECT id, key_prefix, name, contact_email, contributor_tier, status,
       is_admin, witness_authority, activated_at, tenant_account_id, created_at
FROM api_keys
WHERE key_prefix LIKE 'nc_xxxxxxxx%';
```

Things to check on the row:
- `status = 'active'` — otherwise the key is revoked and can't be used at all.
- `activated_at IS NOT NULL` — pending keys get `403 KEY_PENDING` on writes; flip via `POST /v1/service/api-keys/:id/activate`.
- `contributor_tier = 'service'` — non-service tiers can't use write endpoints.

## Step 2 — Identify the failing event's organizer

Get the event's organizer from the failing operation:

```sql
SELECT e.id, e.content, e.source_method, e.organizer_org_id, o.slug, o.name
FROM events e
LEFT JOIN organizations o ON o.id = e.organizer_org_id
WHERE e.id = '<event-id>';
```

`organizer_org_id` is the load-bearing field. After v3 cleanup, every event has one (migration 081 enforced NOT NULL). If somehow null, jump to Step 5.

## Step 3 — Check whether the key is linked to that organization

```sql
SELECT k.id AS api_key_id, k.name, k.is_admin,
       l.created_at AS linked_at
FROM api_keys k
LEFT JOIN api_key_organization_links l
       ON l.api_key_id = k.id
      AND l.organization_id = '<organizer_org_id-from-step-2>'
WHERE k.id = '<key-id-from-step-1>';
```

**If a row comes back with `linked_at IS NOT NULL`:** the key is linked. The 403 must be from a different path — check `source_method`:

- `source_method = 'witnessed'` requires the calling key to have `witness_authority = true`, not just an org link.
- `is_admin = true` keys bypass scoping; the failure is probably elsewhere (check logs).

**If `linked_at IS NULL`:** the key isn't linked to that org — proceed to Step 4.

## Step 4 — Link the key to the organization

```sql
INSERT INTO api_key_organization_links (api_key_id, organization_id)
VALUES ('<key-id>', '<organizer_org_id>')
ON CONFLICT DO NOTHING;
```

The consumer can now PATCH/DELETE events whose organizer is that org. No code change on their side; the link is server-side.

If the consumer reports needing to manage many orgs (e.g. a tenant-umbrella consumer like Merrie publishing for community groups), link the key to each org individually. The endpoint `POST /v1/service/organizations/link` does this from the consumer side; this SQL is the operator-side equivalent for batches.

## Step 5 — Recover orphan events (organizer_org_id is null or wrong)

If `organizer_org_id` is null (legacy data) or points at an org the consumer doesn't control, the event needs to be reassigned to the right organizer. Reassignment requires that the target org exists and that the calling key is linked to it.

Find or create the right organization:

```sql
-- Look for an existing organization
SELECT id, slug, name, method, owner_account_id
FROM organizations
WHERE slug = '<slug>' OR name ILIKE '%<consumer-name>%';
```

If you need to create one, do it via `POST /v1/service/organizations` from the consumer's key — that auto-links the new org to the key. Don't manually INSERT here; the route does the right thing with tenant binding and `method = 'self_asserted'` defaults.

Reassign the orphan events:

```sql
UPDATE events
SET organizer_org_id = '<target-org-id>'
WHERE id IN ('<event-id-1>', '<event-id-2>', ...);
```

Reassignment by id-list is intentional — avoid bulk reassignment without an explicit allowlist. The PATCH `/v1/service/events/:id/organizer` endpoint does this from the consumer side with proper authority checks; prefer that when the consumer can run it themselves.

## Step 6 — Verify

Have the consumer attempt the failing operation. Expected: success, plus a webhook firing if the change crossed `published` status.

If they're still seeing 403 `NOT_LINKED`, double-check that the `organization_id` you linked matches the event's actual `organizer_org_id` (UUIDs are easy to fat-finger).

If they're seeing 404 on a specific event, check the event's `status` — `suspended` events return 404 to non-admin keys by design.

## Going forward

New API keys are issued via the self-service registration flow at `/v1/service/register/*` and activated via `POST /v1/service/api-keys/:id/activate`. The atomic-activation path can optionally provision a tenant portal_account and link it — see the "Trusted-tenant pattern" subsection in [`CLAUDE.md`](../CLAUDE.md) and [`migrations/084_api_key_tenant_account.sql`](../migrations/084_api_key_tenant_account.sql).

Org-linking is the consumer's job post-activation: they call `POST /v1/service/organizations` (which auto-links the new org to the calling key) or `POST /v1/service/organizations/link` (which links the calling key to an existing org). This runbook is for the rare cases where ops needs to intervene.
