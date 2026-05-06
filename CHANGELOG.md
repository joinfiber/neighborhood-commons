# Changelog

**This is the Log, part of the Commons Contract.** The Contract is three files together:

- **The Spec** — [`public/openapi.json`](public/openapi.json) — machine-readable, authoritative.
- **The Guide** — [`public/llms.txt`](public/llms.txt) — narrative companion.
- **The Log** — this file — dated record of every contract-affecting change.

Rule when they disagree: Spec wins. Guide explains. Log dates.

Consumers building against the Commons should watch this file (or diff it on each release) to know what changed. Most recent at top.

Format: one line per change, grouped under the date it shipped. Terse and factual. Breaking changes prefixed with `BREAKING:`.

---

## 2026-05-06 (later)

- New: `?first_party=true|false` filter on `GET /v1/events`. The Commons holds two tiers of authority on the same data substrate: **public-facts** (information *about* a business — scrapers, feeds, ingestion pipelines) and **first-party** (information *from* a business, posted by the business itself after verification). The filter lets apps choose which tier to surface. Schema-level filter (not post-fetch), so `meta.total` reflects the filtered count.
- Fixed: `verified=true` / `verified_by` / `not_verified_by` filters on `/v1/organizations`, `/v1/persons`, and `/v1/broadcasts` no longer report misleading `meta.total`. The previous post-fetch filter pattern returned the unfiltered count (e.g., `total: 328` while the array was empty), which broke pagination semantics. Filters now resolve to an org/person ID set up front and apply at the SQL layer via `IN`/`NOT IN`. Behavior change: pagination over verified-filtered results is now correct.
- Documentation: pillar 03 on the homepage reframed from "Verify once. Recognized everywhere." to "Two tiers of authority." Verification is repositioned as the gate that unlocks first-party publishing, not just an identity proof. Imagine block, stats line, and verification docs section all reflect the two-tier model honestly. Stats line now surfaces a public-facts vs first-party breakdown so visitors see the bootstrapping state rather than an undifferentiated total.
- No spec breaking changes. SDK regenerated against the updated spec.

---

## 2026-05-06

- New: self-service registration for service-tier API keys. `POST /api/v1/service/register/send-otp` + `POST /api/v1/service/register/verify-otp` issue a service-tier key in pending status. Pending keys authenticate for reads (at the service-tier rate limit) and for `/service/verifications/path`, but every write under `/service/*` returns `403 KEY_PENDING` until activation. The whole integration — auth wiring, request shapes, schema validation — can be built and demoed without operator involvement.
- New: `POST /api/v1/service/api-keys/{id}/activate` (admin) flips a pending service key to live; optionally sets `brand_config`, `verification_authority`, and `rate_limit_per_hour` in the same call. Idempotent.
- New: ErrorCode `KEY_PENDING` — service-tier writes against an unactivated key.
- Migration 075: `api_keys.activated_at` (timestamptz) and `api_keys.application_metadata` (jsonb) columns. Existing keys backfilled to `activated_at = created_at`.
- Documentation: `public/llms.txt` and `public/index.html` writing-data sections rewritten around self-issuance. Cuts the Resend pricing table and the operator-as-character framing — those were operator-implementation details that distracted from "how do I integrate."

---

## 2026-05-05 — 1.0.0

The pre-1.0 consolidation. The Commons spec moves from "open events API" to **typed substrate for neighborhood-scale public facts**. Schema.org-aligned types, Commons-orchestrated verification, public reputation graph, opt-in filter primitives. Pre-1.0 was the breaking-changes window; 1.0.0 commits to additive-only stability — future minor versions add types/fields/endpoints without breaking existing consumers, and breaking changes require 2.0.0 with strong justification.

OpenAPI `info.version` bumped to `1.0.0`. SDK regenerates and gets a major version bump.

### New types (Schema.org-aligned)

- Added: `Place` (Schema.org `Place`). Physical locations deduplicated by `googlePlaceId`. Structured address (`PostalAddress` with `streetAddress`, `addressLocality`, `addressRegion`, `postalCode`, `addressCountry`) and `geo` (`GeoCoordinates` with `latitude`, `longitude`). Read: `GET /v1/places`, `GET /v1/places/:id`. Service write: `POST /v1/service/places` (idempotent on `googlePlaceId`).
- Added: `Organization` (Schema.org `Organization`, with `LocalBusiness` semantics via `primary_place_id`). One unified type with `kind` discriminator: `local_business`, `business`, `community_group`, `nonprofit`, `curator`, `collective`. Heavy verification rigor for `local_business`/`business`/`nonprofit`; light for the rest. Properties: `legalName`, `url`, `logo`, `image`, `telephone`, `email`, `sameAs`, `keywords`, `openingHoursSpecification`, `location`. Read: `GET /v1/organizations`, `GET /v1/organizations/:idOrSlug`. Service write: `POST /v1/service/organizations`, `PATCH /v1/service/organizations/:id`, `POST /v1/service/organizations/link`, `POST /v1/service/organizations/:id/logo`, `POST /v1/service/organizations/:id/image`.
- Added: `Person` (Schema.org `Person`). Individuals — DJs, performers, curators, individual organizers. Light verification (email loop, any domain). Properties: `givenName`, `familyName`, `alternateName`, `description`, `image`, `url`, `sameAs`, `jobTitle`. Read: `GET /v1/persons`, `GET /v1/persons/:idOrSlug`. Service write: `POST /v1/service/persons`, `PATCH /v1/service/persons/:id`.
- Added: `Broadcast` — ephemeral signal from a verified Organization, pinned to a Place. Max 24h lifetime. No Schema.org analog (`SpecialAnnouncement` checked and rejected as a bad fit for ephemeral commercial signals); conventions borrowed (`datePosted`, `expires`). Verification gate is consumer-app editorial, not a Commons-side write check. Read: `GET /v1/broadcasts`, `GET /v1/broadcasts/:id`. Service write: `POST /v1/service/broadcasts`, `POST /v1/service/broadcasts/:id/retract`.
- Added: `List` (Schema.org `ItemList`). Curatorial selections by an Organization or Person. Polymorphic items (events, organizations, places) via `itemListElement` array of `ListItem` objects with `position`, `item`, `curatorNote`. Read: `GET /v1/lists`, `GET /v1/lists/:idOrSlug`. Service write: `POST /v1/service/lists`, `PATCH /v1/service/lists/:id`, `POST /v1/service/lists/:id/items`, `DELETE /v1/service/lists/:id/items/:position`.
- Added: `Event.performer` array via new `event_performers` join table. Each performer is a Person or Organization (xor) with optional `performerRole` and `position`. Mirrors Schema.org's `Event.performer` distinction from `Event.organizer`.

### Verification system

- Added: identifier-based verification attached to typed targets (Organization or Person). `account_verified_identifiers` table is the source of truth — presence of any active row means `verified=true`. The identifier set itself enables cross-app portability.
- Added: `GET /v1/service/verifications/path` — Commons routing authority. Apps query with `(target_type, target_id, identifier_type, identifier_value)`; Commons returns which submission endpoint to call. Apps follow; submission endpoints reject mismatches in both directions.
- Added: `POST /v1/service/verifications/challenges` + `POST /v1/service/verifications/challenges/:id/confirm` — auto-track via email-loop. Code stored hashed, never raw. Rejects personal-email domains (gmail/yahoo/etc.) when target is a heavy-rigor Organization, redirecting to manual review.
- Added: `POST /v1/service/verifications/manual` — slow-track for manual review. Required structured evidence (`phone`, `verifiedVia`, `reviewerAttestation`, `reviewerAccountId`, `businessAddressObserved`, `idDocumentObserved`). Apps with `verification_authority` for the matching method auto-approve on submit; others queue.
- Added: `GET/POST /v1/service/verifications/pending`, `/approve`, `/reject` (admin-tier). Manual review queue endpoints. Approval criteria documented in `docs/verification-policy.md`.
- Added: `POST /v1/service/disputes` — minimum-viable dispute recording. Stores claims for operator review; no automated action in 1.0.0.
- Added: `api_keys.brand_config` (jsonb) — per-app verification email sender identity. Operator sets at issuance. Per-app domains must be verified in the shared Resend account.
- Added: `api_keys.verification_authority` (jsonb array) — methods this key may auto-approve, e.g. `["manual_review:in_person", "manual_review:video_call"]`. Operator-granted after onboarding review.
- Added: `account_verified_identifiers.approved_by_app` (snapshot, stable across key rotation) — drives the public reputation graph.

### Reputation graph

- Added: `GET /v1/verifiers` — public read of the verifier registry. Returns per-app counts (approval, active, revoked) and methods used. Anyone reading the Commons can compose `verified_by` filters that match their trust policy.
- Added: `GET /v1/verifiers/:appName/recent_approvals` — public spot-check of recent approvals issued by a specific verifier. Maximum sunlight — auditable by any consumer.
- Added: `verification.verifiedByApp` exposed publicly on Organization/Person reads. The reputation graph is intentionally transparent — sloppy verification creates a market consequence (filtered out by other apps), which is the discipline mechanism.

### Read filters — opt-in not firehose

- Added: `?verified=true`, `?verified_by=app1,app2`, `?not_verified_by=app-x`, `?created_by_contributor=AppName` filter parameters on `GET /v1/organizations`, `/persons`, `/broadcasts`, `/events`. Composable. There is no default firehose: apps construct their consumed view via filters they explicitly choose. App C trusts a different verifier set than App B; both express that as filter parameters.

### BREAKING removals

- BREAKING: Removed `/v1/groups`, `/v1/groups/:id`, `/v1/service/groups/*`, `/v1/contribute/groups/*`. Replaced by `/v1/organizations` (`kind` filter for subtype). The legacy `groups` table stays readable in the database through 1.0.0 and gets dropped in v1.1.0.
- BREAKING: Removed `/v1/accounts`, `/v1/accounts/:idOrSlug`, `/v1/service/accounts/*`. Account-as-business-profile endpoints are replaced by `Organization` reads/writes. `portal_accounts` table narrows to its actual job (auth identity) in v1.1.0; for now it retains business-profile columns for backward-compat read paths.
- BREAKING: **Contribute tier eliminated.** Removed `/v1/contribute/*` (all 11 paths) and `/v1/developers/register/send-otp`, `/verify-otp`, `/me`, `/keys/rotate` (developer self-service registration). The `contributeApiKey` security scheme is gone. Schema `ContributeEventInput` removed. Two effective tiers remain: Browse (read, no auth or basic API key) and Service (write, operator-issued service key with `is_admin` variant). Apps with bulk-contribution use cases push through a service-tier app (Merrie, Holler, Studio) or apply for their own service key. The contribute-tier OTP path was a half-measure — neither low-friction enough to compete with reading nor high-friction enough to enforce app-level accountability.
- BREAKING: Renamed `PATCH /v1/service/events/:id/group` → `PATCH /v1/service/events/:id/organizer`. Body shape changed: `{ group_id }` → `{ organizerOrganizationId, organizerPersonId }`. The "group" assignment was always logically about who organized the event; the new name and shape are honest about that.
- BREAKING: `Group` schema removed; `Account` schema removed; `ServiceAccount` schema removed; `ContributeEventInput` schema removed. Generated SDK clients lose these types and must regenerate to pick up the replacement `Organization` type.
- Added: 5 new ErrorCodes — `IDENTIFIER_DISPUTED`, `IMPOSTER_SIGNALS`, `INSUFFICIENT_EVIDENCE`, `OUT_OF_POLICY`, `WRONG_METHOD` — covering verification flow rejections and Commons-routed-path mismatches.

### Database migrations (064 through 074)

- 064: `places` table.
- 065: `organizations` + `organization_places` tables.
- 066: `persons` table.
- 067: `events.location_place_id`, `events.organizer_org_id`, `events.organizer_person_id` (nullable FKs; CHECK constraint deferred to a future migration after backfill is verified).
- 068: `event_performers` table.
- 069: `broadcasts` table + `expire_broadcasts()` cron function.
- 070: `lists` + `list_items` tables.
- 071: `account_verified_identifiers`, `verification_challenges`, `verification_pending_reviews` tables + `cleanup_expired_challenges()` cron function.
- 072: `api_keys.brand_config`, `api_keys.verification_authority`, `api_keys.is_admin` columns. Non-service-tier keys deactivated.
- 073: `api_key_organization_links` table — replaces the `api_key_account_links` pattern.
- 074: backfill — populates new tables from `groups`, `portal_accounts`, `group_venues`, `api_key_account_links`, and event references. Atomic transaction; idempotent; prints stats via `RAISE NOTICE`.

Legacy tables (`groups`, `group_venues`, `api_key_account_links`, `developer_otps`) and legacy columns on `portal_accounts` are NOT dropped in 1.0.0. They become dead-code-readable until v1.1.0 removes them after operational confidence accumulates. This decoupling — API-layer consolidation now, DB-layer cleanup later — preserves reversibility for weeks.

### SDK

- The published `neighborhood-commons` npm package gets a major-version bump aligned to spec 1.0.0. Generated TS types for all new resources. Verification helpers (`commons.verifications.path`, `commons.verifications.challenges`, etc.) become first-class methods. Reputation-graph helpers. Typed filter parameters. Removed types: `Group`, `Account`, `ServiceAccount`, `ContributeEventInput`. Removed namespace: `commons.contribute`.
- SDK release runbook (operator only): after this branch merges to `master`, edit `sdk/package.json` to set `"version": "1.0.0"`, commit on master, then `git tag sdk-v1.0.0 && git push origin sdk-v1.0.0`. The `sdk-publish.yml` GitHub Actions workflow regenerates types from `public/openapi.json` on master, builds, and publishes to npm with provenance + OIDC attestation. Verify with `npm view neighborhood-commons` after the workflow finishes (~1 min).

### Documentation

- Added: `docs/verification-policy.md` — Commons-defined approval criteria, evidence schemas, app-onboarding requirements for earning `verification_authority`. Reviewers are bound by the documented floor.
- Updated: `public/llms.txt` — narrative companion rewritten to lead with the substrate framing. Events are 1.0.0's first slice; future slices (Notice, Plan, Asset, Offer, Job — the Craigslist-shaped expansion) come additively as consumer apps need them.

---

## 2026-04-23

- New: `event.image_processed` webhook event_type. Fires once per event when the async image download + R2 re-encode pipeline reaches a terminal state (success or permanent failure), so consumers polling `images[]` get a stop signal in either direction. Payload shape is intentionally focused — `{ event_type, event_id, status, image_url, error_code, timestamp, delivery_id }` — not a mirror of `event.updated`. Failure `error_code` values: `URL_BLOCKED`, `DOWNLOAD_FAILED`, `INVALID_FORMAT`, `ENCODE_FAILED`, `UPLOAD_FAILED`. Opt-in: NOT included in the default `event_types` for new subscriptions because the payload differs from the standard `{ event_type, event, ... }` shape — existing subscribers who don't explicitly opt in keep receiving exactly what they receive today. Documented in `public/llms.txt` Part 4.
- New: `event_id` query parameter on `GET /api/v1/webhooks/{id}/deliveries`. Lets a writer or consumer confirm a specific event reached a specific subscriber without paginating the full delivery history. Combine with `status=delivered` to answer "did this event land?" in one call. Same auth model and rate limit (`enumerationLimiter`, 5/min) as the existing endpoint.
- Documented: `GET /api/v1/webhooks/{id}/deliveries` parameters and response shape now match what the server actually returns (`status` and `offset` query params surfaced; response includes `event_id`, `error_message`, `attempt`, `next_retry_at`, and the `meta` pagination block). The endpoint behavior is unchanged — this corrects pre-existing spec-vs-server drift.
- OpenAPI document version (`public/openapi.json` → `info.version`) bumped to `0.8.0`. All changes above are non-breaking — `event.image_processed` requires explicit subscription, the `event_id` filter is optional, and the response shape clarifications match what every existing caller already sees on the wire.
- SDK published as `neighborhood-commons@0.0.4` regenerated against spec `0.8.0`. Per `sdk/RELEASING.md`, tag `sdk-v0.0.4` after merge to trigger publish.

---

## 2026-04-22

- New: `tmdb_id` server-side implementation. The forward-declared field from earlier today (see below) is now a real DB column on `events` (migration 063, with a partial index on non-null values), accepted as input via `ServiceEventInput.tmdb_id` (POST/PATCH `/service/events`), passed through on every read response (`Event.tmdb_id` on the public `/events` shape, `ServiceEvent.tmdb_id` on the service shape), and filterable via `GET /events?tmdb_id={id}` for server-side film clustering. Consumers can now publish the same film at three theaters with a shared `tmdb_id` and cluster client-side, OR query `?tmdb_id={id}` directly for "every showing of one film." `public/llms.txt` clustering paragraph updated to reflect availability. OpenAPI document version bumped to `0.7.0`. Non-breaking — `tmdb_id` is optional and nullable on every surface; existing consumers keep working.
- New: Official SDK published as `neighborhood-commons@0.0.1` on npm. Generated from `public/openapi.json` via `openapi-typescript` + `openapi-fetch`. Lives in this repo at `/sdk` and regenerates with every spec change. Install: `npm install neighborhood-commons`. The SDK is the chosen forcing function for consumer alignment — drift becomes a TypeScript compile error rather than a documentation argument. Existing consumers (Merrie, Go There, Fiber API, Studio) can migrate incrementally; root `package.json` was renamed from `neighborhood-commons` to `neighborhood-commons-server` to free the unscoped name for the SDK.
- New: `tmdb_id` field on Event schema (forward-declared) for clustering film-category events across theaters and dates. Sets the convention for consumers: `?category=film` + group-by `tmdb_id` → one card per film with showtimes nested. Server-side population (DB column, validation, passthrough) lands in a follow-up release; until then, every event returns `tmdb_id: null`. Documented in `public/llms.txt` Part 2. The existing same-day same-film `series_id` model (per the 2026-04-20 entry) remains unchanged — `tmdb_id` is orthogonal, providing the cross-theater/cross-date dimension `series_id` does not cover.
- New: `ServiceEvent` schema in `public/openapi.json`, documenting the actual response shape returned by `GET /service/events/{id}` and `PATCH /service/events/{id}`. Previously these responses were typed as `{ event: object }` with no further detail, forcing consumers (notably Go There) into runtime narrowing and `as any` casts. The schema reflects the existing `toPortalEvent` transform in `src/lib/event-operations.ts` — DB-flavored field names like `title`/`event_date`/`venue_name` (distinct from the public `Event` shape's `name`/`start`/`location.name`). No server-side change; this documents reality.
- `ServiceAccount` schema now declares `id`, `email`, `business_name`, `status`, `created_at`, `updated_at` as required. These fields were always returned non-null in practice but the spec marked them all optional, forcing consumers into runtime narrowing (e.g., Go There's `CommonsAccountRaw & { id: string }` workaround). No server-side change; this documents reality.
- OpenAPI document version (`public/openapi.json` → `info.version`) bumped to `0.6.0`. All changes above are non-breaking — consumers gain typed access to existing realities without any required code change.

---

## 2026-04-21

- Added `POST /service/migrate-image-urls` to `public/openapi.json` (the one-time image URL migration endpoint). Previously served but undocumented; now matches the Spec. Caught by the new contract-drift CI guard (see below).
- New CI guard: `tests/contract-drift.test.ts`. Three mechanical checks run as part of the regular test suite, failing the build on: (1) middleware using `res.status().json()` instead of `next(createError(...))`, (2) a `createError` code that isn't listed in the OpenAPI `ErrorCode` enum, (3) a `router.METHOD` call in an in-contract route file that isn't documented in `openapi.json`. No custom ESLint plugin or new CI step — just a test.
- Middleware cleanup: converted 17 sites across `auth.ts`, `api-key.ts`, `cron-auth.ts`, and `ip-filter.ts` from direct `res.status().json({ error: ... })` to `next(createError(...))`. Matches the "one error shape" doctrine in CLAUDE.md. `error-handler.ts` is the one exempt file (it IS the shape). No behavior change — the error handler produces the same wire response either way.
- Folded `docs/commons-contract.md` into `public/llms.txt` and deleted it. The three-document Commons Contract (Spec / Guide / Log) is now literal — one Spec (`openapi.json`), one Guide (`llms.txt`), one Log (this file), no competing fourth. Unique content preserved: the "thin / durable / authoritative" design-principles framing moved to the llms.txt intro; the explicit visibility rules (status gate, suspended-account-returns-404, open_window time gate, region filter) moved to Part 2. README links updated to point at the Guide directly.
- `public/openapi.json` `Error.code` is now a typed enum (`ErrorCode` schema) covering all 39 codes thrown across the API. Previously it was `type: string` — consumers couldn't generate discriminated unions. Groups: Auth (13), Validation/Resource (7), URL/Domain (7), Rate Limit (3), CSV/Import (4), Server/Infrastructure (5). OpenAPI `info.version` bumped to `0.5.0`.

---

## 2026-04-20

- BREAKING: Removed `runtime_minutes`, `content_rating`, and `showtimes` fields from the Event schema and from the `events` table (migration 061). These were added by migration 029 as a parallel data model for film screenings but were never written to — every INSERT set them null. They were also not part of the upstream Neighborhood API spec. Film screenings now use the same primitives as every other event: one row per individual showtime, `category=film`, shared `series_id` across same-film showings on the same day, runtime derivable from `end - start`, rating conveyed as a tag with `rating:` prefix (e.g., `"rating:r"`). Consumer apps that parsed the three fields should stop reading them; nothing needs to change on the write side. OpenAPI `info.version` bumped to `0.4.0`.
- Added: `ServiceEventInput` accepts an optional `contributor: { name, url? }` (migration 062 adds `events.source_contributor_name`; `source_contributor_url` already existed). Decouples per-event attribution from `source.publisher` so a Service-API caller can publish as e.g. "Go There" while organizer/publisher stay on the linked account's `business_name`. Surfaces as `source.contributor` on every read path (GET, ICS/RSS propagation via the event shape, webhooks, series template). Purely additive: existing callers who omit `contributor` keep the legacy derivation — on `source_method='api'` events without a new override, `source.contributor` still derives from `source_publisher` as before. Passing `contributor: null` on PATCH clears the override. Propagates through `base_event_data` so auto-extended series instances inherit it.

## 2026-04-17

A security and thin-spine hardening session. Nine PRs shipped across one evening; the audit-driven cleanup landed in full.

- BREAKING: Removed `/api/portal/import/preview` and `/api/portal/import/confirm`. iCal and Eventbrite feed ingestion now lives in Studio, not here. The portal UI's import screen is gone too. Migration: external tools should ingest into their own database and push events to Commons via `/api/v1/contribute` or `/api/v1/service/events`.
- BREAKING: Removed `/api/internal/*` legacy sync endpoints. `GET /health` is the canonical health endpoint. The alias `GET /api/internal/health` is preserved serving the same handler so existing uptime probes don't break.
- BREAKING: Removed the `COMMONS_SERVICE_KEY` env var and the `requireServiceKey` middleware (the "fifth auth model"). CLAUDE.md's four-auth-models rule is now literal. If you were signing internal requests with it, migrate to a service-tier API key (`X-API-Key`) on `/api/v1/service/*`.
- Security: `/api/v1/contribute/groups/:id*` now requires ownership — either a service-tier key or a key linked to the group's `portal_account_id`. Non-matching pending-tier writes return `403 FORBIDDEN`. `POST /api/v1/contribute/groups` attributes new groups to the caller's linked account. Groups with `NULL` owner are writable only by service-tier keys (migration 058).
- Security: New `SSRF_STRICT` env var (default `0`). When `'1'`, outbound fetches to user-supplied URLs route through an undici connect hook that re-resolves DNS at connect time and rejects private IPs, defeating DNS rebinding attacks. Applies to webhook delivery, image fetch from URL, and image-verification cron. Unconditional `redirect: 'error'` now enforced on all six user-URL fetch sites — a 302 to a private IP can no longer bypass the upstream URL check.
- Security: `WEBHOOK_ENCRYPTION_KEY` now required in production. Boot fails with a clear error if unset while `NODE_ENV=production`. Previously the system silently fell back to plaintext secrets at rest.
- Security: iCal feed output (`GET /api/v1/events.ics`, per-venue ICS on `/pages.ts`) now escapes the `URL:` field with a shared `icsEscape` helper that handles CR and strips C0 control chars. Prevents calendar-feed injection via a `link_url` containing `\r\n`.
- Fixed: PATCH handlers for `/api/v1/service/events/:id` and `/api/v1/contribute/:id` now preserve wall-clock time on timezone-only updates. Previously changing only `timezone` left `event_at` as the old UTC instant, silently shifting the displayed event time by the offset delta. `event_at` is now recomposed via `fromTimestamptz` + `toTimestamptz` in the new tz.
- Fixed: Contribute API rate limiting is now atomic. The previous read-then-write counter allowed concurrent batches at the limit boundary to both succeed. New `reserve_contribute_slot` RPC (migration 059) performs an atomic UPSERT against a dedicated `api_key_rate_usage` table with a conditional `WHERE` that blocks over-limit increments.
- Fixed: Webhook signing secrets created via `POST /api/v1/webhooks` since 2026-04-08 had corrupt `signing_secret_encrypted` bytea columns — a `Buffer` was serialized as JSON across the Supabase RPC boundary, storing `{"type":"Buffer","data":[...]}` bytes instead of ciphertext. Every delivery attempt failed AES-GCM auth and stranded the delivery row in `pending` state forever. New `bufferToBytea` helper sends `\x<hex>` format; new `resolveSigningSecret` helper wraps decryption in try/catch and marks deliveries failed loudly instead of silently pending. Existing corrupt rows recovered via `scripts/reencrypt-webhook-subscriptions.ts`.
- Internal: Dropped ingestion tables `newsletter_sources`, `newsletter_emails`, `event_candidates`, `feed_sources` (migration 060). All were empty — vestigial from when Studio was being built inside Commons. No API surface change.

## 2026-04-15

- Fixed: `POST /service/events` now actually downloads and attaches the `image_url` field declared in `ServiceEventInput`. The field was being accepted by validation but silently dropped by the portal-input mapping, so events were persisted with `event_image_url = null`. The image is attached fire-and-forget after the event insert (or for every instance, in the recurring branch); a failed image fetch logs but does not fail event creation.

## 2026-04-14

- Fixed: `POST /service/events` no longer sends `NULL` for `source_method` when the caller omits it, which was tripping the column's `NOT NULL` constraint. `source_method` is now hardcoded to `'api'` on the Service path and removed from `ServiceEventInput` — it was never meant to be caller-overridable, and its prior zod enum (`'manual' | 'auto'`) didn't match the DB `CHECK` constraint (`'portal' | 'api' | 'feed' | 'admin' | 'merrie'`) anyway. `source_publisher` is likewise server-controlled now, derived from the linked account's `business_name`.
- BREAKING: `ServiceEventInput` now uses Neighborhood API friendly-shape field names — `name`, `start` (ISO 8601 with offset), `end`, `timezone`, `location.{name,address,lat,lng,place_id}`, `url`, `cost` — symmetric with the public read schema and the Contribute API. Previous DB-shape (`title`, `event_date`, `start_time`, `event_timezone`, `venue_name`, `address`, `latitude`, `longitude`, `link_url`, `price`) is rejected with `400 VALIDATION_ERROR`. Applies to `POST /service/events`, `PATCH /service/events/:id`, `PATCH /service/events/series/:seriesId`. Migration: rename per the Spec's `ServiceEventInput`. Reference consumer FTL (Go There) is migrating to a generated client against `openapi.json`; other integrators should do the same.
- Fixed: `recurrence` is now optional on `ServiceEventInput`. One-off events no longer need to send a recurrence field — omit it. Spec `required` list no longer contains `recurrence`.
- OpenAPI document version (`public/openapi.json` → `info.version`) bumped to `0.3.0` to reflect this date's breaking changes. The upstream Neighborhood API spec version that this service conforms to — exposed as `meta.spec` — remains `neighborhood-api-v0.2` until the Relational Technology Project publishes a newer spec.
- BREAKING: Contribute API ownership is now by linked **account**, not by API key UUID. Previously `source_feed_url = 'api-key:{id}'` was the auth signal, which silently broke editorial control on every key rotation. Now PATCH/DELETE/GET-mine/series-edit/group-link all check `creator_account_id` against the calling key's linked portal_account. Migration 057 backfills `creator_account_id` on existing api-sourced events from `source_feed_url` via `api_key_account_links`. `source_feed_url` is preserved for provenance/audit.
- New: a Contribute API key without a linked portal_account returns `403 KEY_NOT_LINKED` on any write. Issuance via `POST /service/api-keys` requires `account_id` for non-service tiers (`400 ACCOUNT_REQUIRED` otherwise).
- Added: `POST /service/api-keys` (admin) — issue a new API key with an optional `account_id` link. Returns the raw key string once. Use for both initial issuance and rotation (issue new linked to same account → revoke old when ready).
- Migration runbook for the bug-cause case (existing keys created before this change without linked accounts) lives in [`docs/runbook-key-account-recovery.md`](docs/runbook-key-account-recovery.md).

## 2026-04-13

- BREAKING: Removed `start_time_required` and `rsvp_limit` from the Event schema. Replaced by:
  - `open_window` (boolean, default `false`) — inverse of the old `start_time_required`. `true` for come-and-go events (happy hour, open swim, market). Controls feed visibility: open-window events stay visible until `end` (or start + 3h).
  - `capacity` (integer or null) — informational max attendance. Commons does NOT track signups or enforce caps.
  - `rsvp` (`null` | `"recommended"` | `"required"`) — signal whether RSVP is a thing for this event. Commons does not manage RSVPs.
  - Migration: `open_window = !start_time_required`, `capacity = rsvp_limit`, `rsvp = null` (set explicitly on events that need it).
  - Ticketing remains in `link_url` / `url` — that's where Eventbrite, Partiful, venue reservation pages, etc. go.

## 2026-04-12

- **Contract audit complete.** `public/openapi.json` now documents all 56 public-facing endpoints (previously ~8). It is the authoritative contract — narrative docs (`llms.txt`, `consumer-guide.md`) defer to it when they disagree.
- Added shared component schemas: `Event`, `Account`, `ServiceAccount`, `Group`, `Venue`, `Webhook`, `ApprovedDomain`, `DomainApprovalRequest`, `Error`, `Meta`. Security schemes formalized: `browseApiKey`, `contributeApiKey`, `serviceApiKey`.
- Added `PATCH /api/v1/contribute/series/:seriesId` and `PATCH /api/v1/service/events/series/:seriesId` — the correct endpoints for editing a recurring event across all future instances. Past instances preserved; series template (`base_event_data`) is updated so the auto-extend cron inherits the change for newly materialized instances.
- `series_instance_count` is now populated on `GET /api/v1/events` (previously always null there). Bounded series RRULE responses now carry `COUNT=N` from the list endpoint, matching the single-event endpoint.
- Contribute API rate-limit tier `service` added (2000/hr, 20000/day). Service-tier keys on `/contribute` previously fell through to the `pending` default (20/hr) — this was a bug.

## 2026-04-11

- **Contribute URL validation rewritten.** The hardcoded domain allowlist is replaced by a DB-backed table (`approved_domains`) plus a review queue (`domain_approval_requests`). Non-allowlisted domains now return `400 DOMAIN_PENDING_REVIEW` with `error.domain` populated (previously `DOMAIN_NOT_APPROVED`, a hard rejection). Consumers should treat the new code as a soft moderation hold. The legacy code is kept for back-compat.
- New normalcy checks: `INVALID_URL`, `INVALID_SCHEME`, `URL_CREDENTIALS`, `IP_LITERAL`, `BLOCKED_HOSTNAME`. These are always hard-rejected. `http://` URLs are silently coerced to `https://`, and tracking params (`utm_*`, `fbclid`, etc.) are stripped.
- Added admin-only Service API endpoints for managing the allowlist: `GET/POST/DELETE /service/approved-domains`, `GET /service/domain-approval-requests`, `POST /service/domain-approval-requests/:id/{approve,reject}`.
- Added `first_party` boolean on every `Event`. Indicates whether the event was entered by its originator (venue, host, group) or by a third party (curator, ingestion pipeline). Output-only.

---

## Format guidance for contributors

Adding an entry: insert at the top under the current date's heading (create a new date heading if none exists). One sentence per entry. Name the endpoint, field, or error code explicitly. No marketing copy, no redundant context.

Good: "Added `PATCH /service/events/series/:seriesId`."
Bad: "Improved the developer experience for managing recurring events by introducing a convenient new bulk-update capability."

Breaking changes MUST be prefixed `BREAKING:` and include a brief migration note.
