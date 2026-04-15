# Changelog

**This is the Log, part of the Commons Contract.** The Contract is three files together:

- **The Spec** — [`public/openapi.json`](public/openapi.json) — machine-readable, authoritative.
- **The Guide** — [`public/llms.txt`](public/llms.txt) — narrative companion.
- **The Log** — this file — dated record of every contract-affecting change.

Rule when they disagree: Spec wins. Guide explains. Log dates.

Consumers building against the Commons should watch this file (or diff it on each release) to know what changed. Most recent at top.

Format: one line per change, grouped under the date it shipped. Terse and factual. Breaking changes prefixed with `BREAKING:`.

---

## 2026-04-15

- Fixed: `POST /service/events` now actually downloads and attaches the `image_url` field declared in `ServiceEventInput`. The field was being accepted by validation but silently dropped by the portal-input mapping, so events were persisted with `event_image_url = null`. The image is attached fire-and-forget after the event insert (or for every instance, in the recurring branch); a failed image fetch logs but does not fail event creation.

## 2026-04-14

- Fixed: `POST /service/events` no longer sends `NULL` for `source_method` when the caller omits it, which was tripping the column's `NOT NULL` constraint. `source_method` is now hardcoded to `'api'` on the Service path and removed from `ServiceEventInput` — it was never meant to be caller-overridable, and its prior zod enum (`'manual' | 'auto'`) didn't match the DB `CHECK` constraint (`'portal' | 'api' | 'feed' | 'admin' | 'merrie'`) anyway. `source_publisher` is likewise server-controlled now, derived from the linked account's `business_name`.
- BREAKING: `ServiceEventInput` now uses Neighborhood API friendly-shape field names — `name`, `start` (ISO 8601 with offset), `end`, `timezone`, `location.{name,address,lat,lng,place_id}`, `url`, `cost` — symmetric with the public read schema and the Contribute API. Previous DB-shape (`title`, `event_date`, `start_time`, `event_timezone`, `venue_name`, `address`, `latitude`, `longitude`, `link_url`, `price`) is rejected with `400 VALIDATION_ERROR`. Applies to `POST /service/events`, `PATCH /service/events/:id`, `PATCH /service/events/series/:seriesId`. Migration: rename per the Spec's `ServiceEventInput`. Reference consumer FTL (Go There) is migrating to a generated client against `openapi.json`; other integrators should do the same.
- Fixed: `recurrence` is now optional on `ServiceEventInput`. One-off events no longer need to send a recurrence field — omit it. Spec `required` list no longer contains `recurrence`.
- Spec bumped to `0.3.0`.
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
