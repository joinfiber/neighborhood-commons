# 3.0 Launch Runbook

**Audience:** the Commons operator. The sequence below moves production from 2.x to 3.0. Strict order matters — skipping or reordering causes consumer-visible drift.

The PR that delivers 3.0 is `feat/v2-substrate-cleanup` (PR #53). Don't merge it until you're ready to walk the rest of the runbook the same day.

## What "3.0" means in concrete terms

After this runbook completes:

- `public/openapi.json` declares `info.version = "3.0.0"`.
- The live `/api/v1/events*` response shape carries `source.method ∈ {self_asserted, proxied, witnessed}`, `source.url`, `source.contributor`, `source.collected_at`, `source.license`. No `source.publisher` field.
- `Organization`, `Broadcast`, and `List` responses carry a `method` field with the standard provenance vocabulary.
- `neighborhood-commons` on npm is at 3.0.0; consumer apps `npm install` and pick it up.
- Merrie's photo eligibility works for new and existing orgs.

## The sequence

The hard ordering constraint: **migration 085 must apply before or simultaneously with the code deploy.** Pre-migration data carries legacy `source_method` enum values (`api`, `portal`, `import`, etc.); post-migration code returns those values verbatim into the `source.method` slot, silently emitting wrong-vocabulary strings to consumers. Run 085 first, then deploy. Both are idempotent, so a retry is safe if anything stalls.

### Step 1 — Apply migration 084 (if not already done)

```sql
-- Check whether it's already applied
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'api_keys' AND column_name = 'tenant_account_id';
-- Empty result → run the migration
```

Apply [`migrations/084_api_key_tenant_account.sql`](../migrations/084_api_key_tenant_account.sql) against production Supabase via the SQL editor or `supabase db push`.

### Step 2 — Apply migration 085

```sql
-- Check whether it's already applied
SELECT constraint_name FROM information_schema.table_constraints
 WHERE table_name = 'events' AND constraint_name = 'events_source_method_check';
-- Empty result → run the migration
```

Apply [`migrations/085_provenance_method_cleanup.sql`](../migrations/085_provenance_method_cleanup.sql). The migration wraps everything in a single `BEGIN/COMMIT`; if any data state violates the new `CHECK` constraint, the transaction rolls back cleanly. Idempotent — safe to re-run.

**Important: 085 defaults all legacy `source_method` values to `proxied`.** This is the conservative default — legacy values (`api`, `portal`, `import`, etc.) were heterogeneous in practice (used both for consumer-app writes AND for operator-run scrapes), and over-claiming first-party authority is worse than under-claiming. After the migration, promote known first-party consumer-app events to `self_asserted` with a follow-up UPDATE keyed on `source_contributor_name`:

```sql
-- Promote known first-party consumer-app writes to self_asserted.
-- Adjust the contributor name list to match your operator's known
-- first-party consumers.
BEGIN;
UPDATE events SET source_method = 'self_asserted'
 WHERE source_contributor_name IN ('Merrie', 'Go There', 'Go There by Bike', 'Holler');

-- And promote witnessed if any non-witnessed Fiber events exist (rare —
-- Fiber's collective-evidence path normally sets source_method='witnessed'
-- at write time):
UPDATE events SET source_method = 'witnessed'
 WHERE source_contributor_name ILIKE '%fiber%'
   AND source_method <> 'witnessed';

-- Verify
SELECT source_method, count(*) FROM events GROUP BY source_method;
COMMIT;
```

Post-migration validation:

```sql
-- Should return zero rows
SELECT source_method, count(*) FROM events
 WHERE source_method NOT IN ('self_asserted', 'proxied', 'witnessed')
 GROUP BY source_method;

-- Should return non-zero for each (depending on legacy data)
SELECT source_method, count(*) FROM events GROUP BY source_method;

-- New columns exist
SELECT column_name FROM information_schema.columns
 WHERE table_name IN ('organizations', 'broadcasts', 'lists')
   AND column_name = 'method';
-- Expect three rows.

-- source_publisher gone
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'events' AND column_name = 'source_publisher';
-- Expect zero rows.
```

### Step 3 — Merge PR #53

Standard merge to `master`. The PR is squash-ready; the commit message will reference the 3.0 contract.

### Step 4 — Deploy to Railway

`railway.toml` has `watchPatterns = ["src/**", "public/**", "package.json", "Dockerfile", "railway.toml"]`. Push-to-master triggers the deploy automatically. Watch logs for the build to complete (~2 minutes).

Smoke test the live API:

```bash
curl -s https://neighborhood-commons.org/api/v1/events?limit=1 | jq '.events[0].source'
# Expected: { "method": "self_asserted|proxied|witnessed", "url": null|"...",
#             "contributor": {...}|null, "collected_at": "...", "license": "CC BY 4.0" }
# Note: no "publisher" key.

curl -s https://neighborhood-commons.org/api/v1/organizations?limit=1 | jq '.organizations[0].method'
# Expected: "self_asserted" | "proxied" | "witnessed" | "seeded"
```

### Step 5 — Tag and publish the SDK

```bash
git tag sdk-v3.0.0
git push origin sdk-v3.0.0
```

The tag triggers `.github/workflows/sdk-publish.yml` which publishes `neighborhood-commons@3.0.0` to npm via OIDC Trusted Publishing. Watch the Actions tab for the workflow to complete (~1 minute).

Verify:

```bash
npm view neighborhood-commons version
# Expected: 3.0.0
```

### Step 6 — Provision Merrie's tenant (if not already done)

```bash
npx tsx scripts/provision-merrie-tenant.ts
# Optional flags: --dry-run to preview, --key-id <id> if multiple Merrie keys exist
```

The script creates the shared tenant `portal_account`, binds `api_keys.tenant_account_id` on Merrie's key, and prints the operator next-steps SQL.

### Step 7 — Backfill ownership + method on Merrie's existing orgs

Two short SQL statements, printed by the provisioning script. The pattern is:

```sql
-- (a) Set owner_account_id on Merrie's existing orgs.
UPDATE organizations
   SET owner_account_id = '<tenant-account-id-from-step-6>'
 WHERE id IN ('<merrie-org-uuid-1>', '<merrie-org-uuid-2>', ...)
   AND owner_account_id IS NULL;

-- (b) Promote them from 'seeded' to 'self_asserted' (post-085 doctrine —
--     owner_account_id IS NOT NULL means the org has first-party authority
--     via the trusted-tenant pattern).
UPDATE organizations
   SET method = 'self_asserted'
 WHERE owner_account_id = '<tenant-account-id-from-step-6>'
   AND method = 'seeded';
```

To find Merrie's existing org IDs:

```sql
SELECT id, slug, name FROM organizations
 WHERE id IN (
   SELECT organization_id FROM api_key_organization_links
    WHERE api_key_id = '<merrie-key-id>'
 );
```

### Step 8 — Tell the consumer apps

Once steps 1–7 are done and the smoke tests in step 4 pass, post the consumer-app refresh prompt. Each consumer (Fiber, Merrie, Holler) should:

1. `npm install neighborhood-commons@3.0.0`
2. Regenerate types if they import from `components`.
3. Fix the type errors: `source.publisher` is gone; read `organizer.name` instead. `source.method` enum is the new vocabulary. New optional fields (`source.url`, `Organization.method`, etc.) can be ignored or surfaced.
4. Test against the live API.

The full developer onramp is in [`quickstart.md`](quickstart.md) and the four-role frame in [`four-roles.md`](four-roles.md).

## What can go wrong

| Symptom | Cause | Fix |
|---|---|---|
| Consumer sees `source.method = "api"` | Code deployed before migration 085 ran | Apply 085 (idempotent; existing rows get renamed) |
| `npm install neighborhood-commons` returns 2.0.0 | SDK tag not pushed | Run step 5 |
| Merrie hits `IMAGE_NOT_PERMITTED` on existing orgs | Step 7(a) ownership backfill skipped | Run the UPDATE from step 7 |
| Merrie-published events show `organizer.method = "seeded"` | Step 7(b) method promotion skipped | Run the UPDATE from step 7(b) |
| Smoke test shows `source.publisher` still present | Code deploy didn't pick up the new transform | Check Railway logs; redeploy |
| Migration 085 fails mid-apply | Some event has a `source_method` value the migration's mapping doesn't recognize | The `DO $$` backstop in 085 coerces unknowns to `'self_asserted'`; check `RAISE NOTICE` output in the SQL editor log. If it still fails, query for the offending value and decide how to map it before re-running. |

## Rollback

Code-side: revert PR #53 and redeploy. The 2.0.0 spec is at git tag `sdk-v2.0.0`.

Data-side: harder. Migration 085 drops `events.source_publisher`. To roll back, you'd need to restore that column (`ALTER TABLE events ADD COLUMN source_publisher text`) and re-populate from a backup. Re-renaming `source_method` values back is easy SQL. Don't roll back unless you have to.

The cleaner recovery for in-flight contract drift is **forward, not back**: fix whatever was wrong about 3.0 in a 3.0.1 (additive) or 3.1.0 (additive) — the contract has stability machinery for this.

## Test before / after the runbook

Before merging PR #53:
- `npm run test:run` — all 444 tests pass
- `npm --prefix sdk run typecheck` — passes
- `npm run typecheck` — passes
- Spot-check `public/openapi.json` declares version 3.0.0

After step 4 (deploy live):
- Smoke tests in step 4
- `curl https://neighborhood-commons.org/openapi.json | jq .info.version` → `"3.0.0"`
- `curl https://neighborhood-commons.org/.well-known/neighborhood` → reflects current state

After step 5 (SDK publish):
- `npm view neighborhood-commons version` → `3.0.0`

After step 7 (Merrie backfill):
- Smoke test Merrie's photo upload flow against staging or with a test image
- Sanity-query `SELECT count(*) FROM organizations WHERE method = 'self_asserted'` — should be substantially nonzero
