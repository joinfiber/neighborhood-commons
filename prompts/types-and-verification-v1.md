# Brief: Types and Verification — v1.0.0 Spec Consolidation

> **Origin:** Design conversation 2026-05-04 / 2026-05-05.
>
> **Status:** Architecture decided. Schema.org property names verified. **Aggressive consolidation chosen** — this is the 1.0.0 cut. Pre-1.0 breaking changes happen now; post-1.0 the additive-only doctrine takes effect.
>
> **Predecessor:** `prompts/verification-layer.md` (2026-04-29) — that brief proposed verification as a flag on accounts. This brief supersedes it: verification attaches to typed entities (Organization, Person), uses an identifier-set model, and is part of the larger Schema.org-aligned type expansion that 1.0.0 commits to.

## The frame

The Neighborhood Commons is the **typed substrate for neighborhood-scale public facts** — the plumbing under a class of neighborhood applications, starting with events but designed to absorb additional fact-types over time. v1.0.0 lands the foundation: Place, Organization, Person, Event, Broadcast, List — Schema.org-aligned types — plus the verification + reputation system that lets apps trust contributors and trust each other.

**Why 1.0.0 now.** Pre-1.0 is the time for breaking consolidation. The user is the only consumer party (across Merrie, Holler, Studio, future apps), so coordinated breaking changes are tractable. From 1.0.0 forward, additive-only stability is the doctrine — additions happen via 1.x; removals or rename require 2.0.0 with very strong justification.

The consolidation removes a tangle of legacy:
- `groups` (table + endpoints) absorbed into `organizations` (kind discriminator)
- `portal_accounts` business-profile columns absorbed into `organizations`; `portal_accounts` narrows to its actual job (auth identity)
- `Account` and `ServiceAccount` schemas removed; replaced by `Organization`
- **Contribute tier removed entirely** — only Browse (read) and Service (write) tiers remain
- `/contribute/*` endpoints removed
- `/developers/*` self-registration endpoints removed
- `/accounts/*` and `/groups/*` endpoints removed (replaced by `/organizations/*`)

## Two tiers, hard floor

| Tier | Auth | Purpose |
|---|---|---|
| Browse | None or optional API key | Public reads. Zero friction. |
| Service | Service-tier API key (operator-issued) | All writes. Apps with brand identity, real onboarding, accountability. `is_admin=true` is the operator/Studio variant. |

The contribute tier doesn't exist in 1.0.0. Casual contribution is an app-side concern — anyone with bulk events to contribute pushes through Merrie (which holds a service-tier key) or builds their own app and applies for one. Gaps in app coverage are business opportunities, not Commons-tier concerns.

## Schema.org canonical naming reference

Every type maps to a Schema.org concept. **DB columns use snake_case** (Postgres convention). **API responses use camelCase Schema.org-canonical names** (so consumers and JSON-LD scrapers see what they expect).

| Our type | Schema.org type | Notes |
|---|---|---|
| Place | `Place` | Pure location |
| Organization (kind=local_business) | `LocalBusiness` (subtype of both Organization and Place) | Multiple inheritance simulated via `primary_place_id` link |
| Organization (other kinds) | `Organization` | Subtype expressed via `additionalType` URL |
| Person | `Person` | Individuals |
| Event | `Event` | Already in Neighborhood API spec |
| Broadcast | (no canonical analog) | Custom primitive, named conventionally |
| List | `ItemList` | With `ListItem` for ordered items |

### Property-name crosswalk (DB column → API field → Schema.org rationale)

**Place** (Schema.org Place; PostalAddress for `address`, GeoCoordinates for `geo`)

| DB column | API field | Note |
|---|---|---|
| `id` | `id` | Our UUID |
| `google_place_id` | `identifier[].value` where `propertyID="googlePlaceId"` | |
| `name` | `name` | |
| `street_address` | `address.streetAddress` | PostalAddress nested |
| `address_locality` | `address.addressLocality` | "Philadelphia" |
| `address_region` | `address.addressRegion` | "PA" |
| `postal_code` | `address.postalCode` | |
| `address_country` | `address.addressCountry` | ISO 3166-1 alpha-2 |
| `latitude` | `geo.latitude` | GeoCoordinates nested |
| `longitude` | `geo.longitude` | |

**Organization**

| DB column | API field |
|---|---|
| `id`, `slug`, `name` | same |
| `legal_name` | `legalName` |
| `kind` | `kind` (flat enum) + `additionalType` (Schema.org URL) |
| `description` | `description` |
| `url` | `url` |
| `logo_url` | `logo` |
| `image_url` | `image` |
| `telephone` | `telephone` |
| `email` | `email` |
| `same_as` (jsonb array) | `sameAs` |
| `keywords` (text[]) | `keywords` |
| `opening_hours_specification` (jsonb) | `openingHoursSpecification` |
| `primary_place_id` | `location` (Place reference) |

**Person**

| DB column | API field |
|---|---|
| `bio` | `description` |
| `avatar_url` | `image` |
| `links` | `sameAs` |
| `given_name`, `family_name`, `alternate_name`, `job_title` | camelCase equivalents |

**Event** — keeps existing Neighborhood API spec shape (`start`, `end`, `location`, `organizer`, `category`). Additive: organizer can now be a typed reference; performers added via `performer` array; `event_performers` table.

**Broadcast** (no Schema.org analog; SpecialAnnouncement vocabulary borrowed for `datePosted` and `expires`)

| DB column | API field |
|---|---|
| `organization_id` | `organization` (Organization reference) |
| `place_id` | `location` (Place reference) |
| `message`, `status` | same |
| `created_at` | `datePosted` |
| `expires_at` | `expires` |
| `source` (jsonb) | `source` |

**List** (Schema.org ItemList) — uses `itemListElement[]`, `itemListOrder`, `numberOfItems`. Curator can be Org or Person.

## The type model

### Place

```sql
CREATE TABLE places (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_place_id     text UNIQUE,
  name                text NOT NULL,
  street_address      text,
  address_locality    text,
  address_region      text,
  postal_code         text,
  address_country     text NOT NULL DEFAULT 'US',
  latitude            double precision NOT NULL,
  longitude           double precision NOT NULL,
  region_id           uuid REFERENCES regions(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

No identity verification — the place either exists or it doesn't.

### Organization

```sql
CREATE TABLE organizations (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                          text UNIQUE NOT NULL,
  name                          text NOT NULL,
  legal_name                    text,
  kind                          text NOT NULL CHECK (kind IN (
                                  'local_business',
                                  'business',
                                  'community_group',
                                  'nonprofit',
                                  'curator',
                                  'collective'
                                )),
  description                   text,
  url                           text,
  logo_url                      text,
  image_url                     text,
  telephone                     text,
  email                         text,
  same_as                       jsonb DEFAULT '[]',
  keywords                      text[] DEFAULT '{}',
  opening_hours_specification   jsonb,
  primary_place_id              uuid REFERENCES places(id),
  owner_account_id              uuid REFERENCES portal_accounts(id),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_places (
  organization_id   uuid REFERENCES organizations(id) ON DELETE CASCADE,
  place_id          uuid REFERENCES places(id) ON DELETE CASCADE,
  is_primary        boolean DEFAULT false,
  relationship      text CHECK (relationship IN ('operates_at','hosts_events_at','headquartered_at')),
  PRIMARY KEY (organization_id, place_id)
);

-- New: replaces api_key_account_links pattern
CREATE TABLE api_key_organization_links (
  api_key_id        uuid REFERENCES api_keys(id) ON DELETE CASCADE,
  organization_id   uuid REFERENCES organizations(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, organization_id)
);
```

### Person

```sql
CREATE TABLE persons (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text UNIQUE NOT NULL,
  name              text NOT NULL,
  given_name        text,
  family_name       text,
  alternate_name    text,
  description       text,
  image_url         text,
  url               text,
  same_as           jsonb DEFAULT '[]',
  job_title         text,
  owner_account_id  uuid REFERENCES portal_accounts(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
```

### Event (additive changes)

Add to existing `events` table:
- `location_place_id uuid REFERENCES places(id)` — required going forward (backfill from existing place_id text)
- `organizer_org_id uuid REFERENCES organizations(id)` and `organizer_person_id uuid REFERENCES persons(id)` with CHECK that exactly one is set
- New `event_performers` table for many performers per event

```sql
CREATE TABLE event_performers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id         uuid REFERENCES persons(id),
  organization_id   uuid REFERENCES organizations(id),
  performer_role    text,
  position          integer,
  CHECK ((person_id IS NOT NULL) <> (organization_id IS NOT NULL)),
  UNIQUE (event_id, person_id, organization_id)
);
```

### Broadcast

```sql
CREATE TABLE broadcasts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  place_id          uuid NOT NULL REFERENCES places(id),
  message           text NOT NULL CHECK (length(message) BETWEEN 1 AND 280),
  expires_at        timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','expired','retracted')),
  retracted_at      timestamptz,
  source            jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

Verification gate: broadcast creation does NOT require verified status. Verification is a *consumer-app filter* on visibility, not a Commons-side gate.

### List

```sql
CREATE TABLE lists (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text UNIQUE NOT NULL,
  name                text NOT NULL,
  description         text,
  curator_org_id      uuid REFERENCES organizations(id),
  curator_person_id   uuid REFERENCES persons(id),
  CHECK ((curator_org_id IS NOT NULL) <> (curator_person_id IS NOT NULL)),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE list_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id           uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  position          integer NOT NULL,
  event_id          uuid REFERENCES events(id),
  organization_id   uuid REFERENCES organizations(id),
  place_id          uuid REFERENCES places(id),
  curator_note      text,
  added_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (event_id IS NOT NULL)::int + (organization_id IS NOT NULL)::int + (place_id IS NOT NULL)::int = 1
  ),
  UNIQUE (list_id, position)
);
```

## Verification system

### Identifier sets attached to typed entities

```sql
CREATE TABLE account_verified_identifiers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type       text NOT NULL CHECK (target_type IN ('organization','person')),
  target_id         uuid NOT NULL,
  identifier_type   text NOT NULL,
  identifier_value  text NOT NULL,
  identifier_domain text,
  method            text NOT NULL,
  verified_at       timestamptz NOT NULL DEFAULT now(),
  evidence          jsonb,
  approved_by_app   text NOT NULL,
  approved_by_key   uuid REFERENCES api_keys(id),
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','revoked')),
  revoked_at        timestamptz,
  revoked_reason    text,
  UNIQUE (target_type, target_id, identifier_type, identifier_value),
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

### Verification rigor scales with harm potential

| Target | kind | Default rigor | Method |
|---|---|---|---|
| Organization | `local_business`, `business`, `nonprofit` | Heavy | Business email loop OR manual review with structured evidence |
| Organization | `community_group`, `curator`, `collective` | Light | Email loop, any domain |
| Person | (any) | Light | Email loop, any domain |
| Place | (n/a) | Implicit via google_place_id | None |

Personal-email domains routed to manual review *only when the target is a heavy-rigor Organization*.

### Routing authority — Commons routes, apps follow

```
GET /v1/service/verifications/path
→ {
    alreadyVerified: bool,
    requiredMethod: 'domain_email_loop' | 'manual_review' | null,
    endpoint: string | null,
    reason: string | null
  }
```

Submission endpoints reject mismatches in both directions.

### App-branded verification emails + verification authority

```sql
ALTER TABLE api_keys ADD COLUMN brand_config jsonb;
ALTER TABLE api_keys ADD COLUMN verification_authority jsonb;
ALTER TABLE api_keys ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
```

Operator sets per key at issuance. Apps with `verification_authority` for the matching method auto-approve manual reviews; others queue. `is_admin=true` reserved for Studio (operator's tooling).

### Manual review path

```sql
CREATE TABLE verification_pending_reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type       text NOT NULL,
  target_id         uuid NOT NULL,
  identifier_type   text NOT NULL,
  identifier_value  text NOT NULL,
  method            text NOT NULL,
  submitted_by_key  uuid NOT NULL REFERENCES api_keys(id),
  evidence          jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
  reviewed_by_key   uuid REFERENCES api_keys(id),
  reviewed_at       timestamptz,
  decision_reason   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

Required evidence (Commons-defined, validated at submit): `phone`, `verifiedVia` (in_person | video_call), `reviewerAttestation`, `reviewerAccountId`, `businessAddressObserved`, `idDocumentObserved`, optional `supportingNotes`. Approval criteria documented in `docs/verification-policy.md`.

### Verification challenges (auto-track)

```sql
CREATE TABLE verification_challenges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type       text NOT NULL,
  target_id         uuid NOT NULL,
  identifier_type   text NOT NULL,
  identifier_value  text NOT NULL,
  code_hash         text NOT NULL,
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  attempts          int NOT NULL DEFAULT 0,
  brand_key_id      uuid NOT NULL REFERENCES api_keys(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

### Reputation graph (public reads)

```
GET /v1/verifiers
→ list of verifier registry entries with approvalCount, activeCount, revokedCount per app

GET /v1/verifiers/:appName/recent_approvals
→ recent approvals for spot-checking
```

## Read primitives — opt-in not firehose

| Filter | Meaning |
|---|---|
| `verified=true` | Only verified targets |
| `verified_by=app1,app2` | Verified by any of these apps |
| `not_verified_by=app-x` | Excludes |
| `created_by_contributor=Holler` | App's own content |
| `kind=local_business` | Organization subtype |
| `near=lat,lng&radius_km=N` | Geo filter |
| `q=...` | Text search |

No default firehose. Service-tier reads with no filters default to "your own linked organizations." Public reads require structural filters.

## Endpoint surface (1.0.0)

### Public reads
- `GET /v1/places`, `/v1/places/:id`
- `GET /v1/organizations`, `/v1/organizations/:idOrSlug`
- `GET /v1/persons`, `/v1/persons/:idOrSlug`
- `GET /v1/events`, `/v1/events/:id`, `/v1/events/changes`, `/v1/events/terms`, `/v1/events.ics`, `/v1/events.rss`
- `GET /v1/broadcasts`, `/v1/broadcasts/:id`
- `GET /v1/lists`, `/v1/lists/:idOrSlug`
- `GET /v1/verifiers`, `/v1/verifiers/:appName/recent_approvals`
- `GET /v1/meta`, `/v1/meta/regions`, `/v1/meta/categories`, `/v1/meta/stats`

### Service tier
**Verifications:**
- `GET /v1/service/verifications/path`
- `POST /v1/service/verifications/challenges`
- `POST /v1/service/verifications/challenges/:id/confirm`
- `POST /v1/service/verifications/manual`
- `GET /v1/service/verifications/pending` (admin)
- `POST /v1/service/verifications/pending/:id/approve` (admin)
- `POST /v1/service/verifications/pending/:id/reject` (admin)

**Disputes:**
- `POST /v1/service/disputes`

**Places:**
- `POST /v1/service/places` (idempotent on googlePlaceId)

**Organizations:**
- `POST /v1/service/organizations`
- `PATCH /v1/service/organizations/:id`
- `POST /v1/service/organizations/link`
- `POST /v1/service/organizations/:id/logo`
- `POST /v1/service/organizations/:id/image`

**Persons:**
- `POST /v1/service/persons`
- `PATCH /v1/service/persons/:id`

**Broadcasts:**
- `POST /v1/service/broadcasts`
- `POST /v1/service/broadcasts/:id/retract`

**Lists:**
- `POST /v1/service/lists`
- `PATCH /v1/service/lists/:id`
- `POST /v1/service/lists/:id/items`
- `DELETE /v1/service/lists/:id/items/:position`

**Events** (existing + organizer rename):
- `POST /v1/service/events`, `PATCH /v1/service/events/:id`, `DELETE /v1/service/events/:id`
- `POST /v1/service/events/batch`
- `PATCH /v1/service/events/series/:seriesId`
- `POST /v1/service/events/:id/image`
- `PATCH /v1/service/events/:id/organizer` (renamed from `/group`)

**API keys, webhooks, approved domains, stats, migration utilities** — unchanged from 0.5.0 (stays under service tier).

### Removed in 1.0.0
- `/contribute/*` (all paths) — contribute tier eliminated
- `/developers/*` (all paths) — self-service registration eliminated
- `/accounts`, `/accounts/:idOrSlug`, `/service/accounts/*`
- `/groups`, `/groups/:id`, `/service/groups/*`
- `/service/events/:id/group` (renamed to `/organizer`)

## Migration strategy (aggressive)

Big bang — drop legacy in the same migration cycle. No deprecation window since the operator coordinates all consumer deploys.

1. **places** created. Backfill: dedupe Google Place IDs from `events.place_id`, `portal_accounts.place_id`, `group_venues.place_id`. Address parsed best-effort into structured fields.
2. **organizations** created. Backfill: every `groups` row → `organizations` row (kind preserved). Every `portal_accounts` row not represented → `kind='local_business'` org with primary_place_id from default-venue data. Owner link preserved via `owner_account_id`.
3. **organization_places** created. Backfill from `group_venues` + portal default-venue data, deduplicated against `places`.
4. **api_key_organization_links** created. Backfill from `api_key_account_links`.
5. **persons** created (empty).
6. **events** gains `location_place_id`, `organizer_org_id`, `organizer_person_id`. Backfill via lookups. **Drop** existing flat venue columns (`place_id`, `place_name`, `venue_address`, `latitude`, `longitude`) AFTER verifying backfill — these become readable via `events.locationPlace` (joined Place).
7. **event_performers** created (empty).
8. **broadcasts**, **lists**, **list_items** created (empty).
9. **account_verified_identifiers**, **verification_challenges**, **verification_pending_reviews** created (empty).
10. **api_keys**: add `brand_config`, `verification_authority`, `is_admin` columns. Constraint on `contributor_tier` narrows to `'service'` only. Any existing pending/contribute keys are deactivated (operator decides which to upgrade).
11. **portal_accounts** narrows: drop business-profile columns (`business_name`, `phone`, `website_url`, `venue_name`, `venue_address`, `place_id`, `latitude`, `longitude`, `logo_url`, `description`, `operating_hours`, etc.) — that data lives on organizations. Keep `id`, `auth_user_id`, `email`, `claimed_at`, `status`, `created_at`, `updated_at`.
12. **DROP** legacy tables: `groups`, `group_venues`, `developer_otps`, `api_key_account_links` (after backfill verified).

Order matters — backfills before drops, FK creation before backfill where applicable.

## Consumer impact

### Merrie
- Birders-of-Philadelphia type groups → `Organization` with `kind='community_group'`. Light verification.
- Bubs-style businesses → `Organization` with `kind='local_business'` and `primary_place_id`. Heavy verification when operators claim them.
- DJs / individual hosts → optional `Person` records with `event_performers` rows, or freeform performer strings.
- Curators → `lists` endpoint matches the curator-list flow Merrie has been planning.
- **Merrie's service key gains `brand_config`** for Merrie-branded verification emails.

### Holler
- Businesses verified through Holler's flow → `Organization` rows with verified identifiers via `manual_review:in_person`.
- Broadcasts → `POST /v1/service/broadcasts` with `organizationId` + `placeId`.
- Holler's brand_config baked into its service key — verification emails come from `verify@holler.app`.
- **Holler gets `verification_authority: ['manual_review:in_person', 'manual_review:video_call']`** so its in-person verifications auto-approve.
- Holler's UI filter for its own feed: `?created_by_contributor=Holler`. Other apps reading Holler-onboarded businesses: `?verified_by=Holler`.

### Studio
- Stays service-tier with `is_admin=true`.
- Gains the verification review queue endpoints for any reviews that aren't auto-approved by app authority.
- Manages api_keys for new consumer apps (sets brand_config, verification_authority, is_admin per key).

## SDK regeneration

Major version bump on the SDK (1.0.0). New TS interfaces for all types. Verification helpers as first-class methods. Reputation-graph helpers. Typed filter parameters. Removed old types (Group, Account, ServiceAccount, ContributeEventInput) and the `contribute` namespace from the client.

```ts
// Approximate consumer experience
const path = await commons.verifications.path({
  targetType: 'organization', targetId: bubsId,
  identifierType: 'email', identifierValue: 'manager@bubs.com'
});
if (path.alreadyVerified) { /* skip */ }
else { await commons.verifications[path.requiredMethod]({...}); }
```

## What's NOT in 1.0.0

Deferred for additive future work via 1.x minor versions:
- De-verification / revocation endpoints (schema supports; endpoints later)
- Re-verification / identifier transfer
- Verification expiry
- Bulk revocation by approving app
- Type-specific Organization Schema.org subtypes (Restaurant, Store, etc.)
- Performer role controlled vocabulary
- Notice / Plan / Asset / Offer / Job types (the Craigslist-shaped expansion — comes when consumer apps need them)
- Rate-limiting probationary periods on newly verified accounts
- Cross-identifier sanity checks

## Open implementation questions

1. **Slug uniqueness scope.** Leaning global (URL paths disambiguate by type prefix).
2. **Performer role taxonomy.** v1: freeform text; v2: controlled vocab when patterns emerge.
3. **Persons table population.** v1: explicit creation only.
4. **Cron expiry job for broadcasts.** Pure SQL UPDATE on a schedule.
5. **Address parsing on backfill.** Best-effort split with `street_address` fallback.

## Files this brief will produce

**Migrations** (new — additive + cleanup):
- `migrations/064_places_table.sql`
- `migrations/065_organizations_table.sql`
- `migrations/066_persons_table.sql`
- `migrations/067_event_organizer_fks.sql`
- `migrations/068_event_performers.sql`
- `migrations/069_broadcasts.sql`
- `migrations/070_lists.sql`
- `migrations/071_verification_tables.sql`
- `migrations/072_api_key_brand_authority_admin.sql`
- `migrations/073_api_key_organization_links.sql`
- `migrations/074_backfill_orgs_places_links.sql`
- `migrations/075_drop_legacy_tables.sql`
- `migrations/076_narrow_portal_accounts.sql`

**OpenAPI**: `public/openapi.json` — already at 1.0.0 (this commit).

**Route files** (new):
- `src/routes/v1-places.ts`
- `src/routes/v1-organizations.ts`
- `src/routes/v1-persons.ts`
- `src/routes/v1-broadcasts.ts`
- `src/routes/v1-lists.ts`
- `src/routes/v1-verifications.ts`
- `src/routes/v1-verifiers.ts`
- `src/routes/service/organizations.ts`, `persons.ts`, `broadcasts.ts`, `lists.ts`, `places.ts`, `verifications.ts`, `disputes.ts`

**Route files** (deleted):
- `src/routes/v1-groups.ts` (replaced by organizations)
- `src/routes/v1-accounts.ts` (replaced by organizations)
- `src/routes/contribute*.ts` (entire contribute tier)
- `src/routes/developers*.ts`
- `src/routes/service/groups.ts` (if exists)
- `src/routes/service/accounts.ts` (if exists)

**Library**:
- `src/lib/verification/*` (path discovery, evidence schemas, personal-email domain list, code generation, email send)
- `docs/verification-policy.md`

**Other**:
- `CHANGELOG.md` — 1.0.0 entry with breaking changes documented
- SDK regen via existing pipeline; major version bump on the published package
- `public/llms.txt` — substantial rewrite to reflect the substrate framing
