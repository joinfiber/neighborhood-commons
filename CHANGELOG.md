# Changelog

User-visible changes to the Neighborhood Commons API. Most recent at top.

Consumers building against the Commons should watch this file (or diff it on each release) to know what changed. For the authoritative schema, see [`public/openapi.json`](public/openapi.json).

Format: one line per change, grouped under the date it shipped. Terse and factual. Breaking changes prefixed with `BREAKING:`.

---

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
