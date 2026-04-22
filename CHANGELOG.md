# Changelog

**This is the Log, part of the Commons Contract.** The Contract is three files together:

- **The Spec** — [`public/openapi.json`](public/openapi.json) — machine-readable, authoritative.
- **The Guide** — [`public/llms.txt`](public/llms.txt) — narrative companion.
- **The Log** — this file — dated record of every contract-affecting change.

Rule when they disagree: Spec wins. Guide explains. Log dates.

Consumers building against the Commons should watch this file (or diff it on each release) to know what changed. Most recent at top.

Format: one line per change, grouped under the date it shipped. Terse and factual. Breaking changes prefixed with `BREAKING:`.

---

## 2026-04-22

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

---

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
