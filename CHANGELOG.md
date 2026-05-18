# Changelog

**This is the Log, part of the Commons Contract.** The Contract is three files together:

- **The Spec** — [`public/openapi.json`](public/openapi.json) — machine-readable, authoritative.
- **The Guide** — [`public/llms.txt`](public/llms.txt) — narrative companion.
- **The Log** — this file — dated record of every contract-affecting change.

Rule when they disagree: Spec wins. Guide explains. Log dates.

Consumers building against the Commons should watch this file (or diff it on each release) to know what changed. Most recent at top.

Format: one line per change, grouped under the date it shipped. Terse and factual. Breaking changes prefixed with `BREAKING:`.

---

## 2026-05-18 — operator review portal (PR 4a)

No contract change. Internal review surface for pending developer registrations. Per [`docs/onboarding-redesign.md`](docs/onboarding-redesign.md) §12 (PR 4a).

- **Gated by `COMMONS_OPERATOR_EMAIL`** — comma-separated allowlist (single email still works). Anyone whose dashboard session matches an address on the list sees `/operator/*`; anyone else gets `404` (route existence not leaked).
- **`GET /operator/applications`** — list of registrations filtered by status (default `pending`, also `all` / `active` / `rejected` / `suspended`).
- **`GET /operator/applications/:id`** — detail view: application_metadata, contributor profile, brand config, prior review record (if any), approve/reject forms.
- **`POST /operator/applications/:id/approve`** — flips `api_keys.activated_at`, sets `contributor_profiles.status='active'`, sends activation email with dashboard link + quickstart pointer.
- **`POST /operator/applications/:id/reject`** — flips `api_keys.status='rejected'`, sets `contributor_profiles.status='suspended'`, sends rejection email with the operator's optional free-text reason. Login is blocked for the rejected key (`status` filter on `api_keys` lookup); applicant is invited to reply for clarification.
- Review record stored in `application_metadata.review = { action, at, by, notes }`.
- All POSTs CSRF-protected (double-submit cookie).
- No new database columns. Status transitions reuse the existing `api_keys.status` + `contributor_profiles.status` enums.

PR 4b (MFA enrollment + step-up middleware) lands next.

## 2026-05-18 — developer portal: magic-link login + profile editing (PR 3)

No contract change. Returning-developer login flow + profile management at `/developers/profile`. Per [`docs/onboarding-redesign.md`](docs/onboarding-redesign.md) §4.6 and §12 (PR 3).

- **Magic-link login:**
  - `GET /developers/login` — email entry form.
  - `POST /developers/login` — issues a 15-minute, single-use token to `magic_login_tokens`, sends the URL by email. Same response shape regardless of whether the email has an account (no user enumeration).
  - `GET /developers/login/verify?token=…` — consumes the token, creates a session, sets the cookie, redirects to `/developers/dashboard`.
- **Profile editing:**
  - `GET /developers/profile` — pre-filled edit form (requires session).
  - `POST /developers/profile` — validates + updates the `contributor_profiles` row, redirects with `?saved=1`. No MFA gate yet (PR 4 adds that for post-activation edits).
  - Editable fields: `name`, `tagline`, `description`, `app_url`, `logo_url`, `who_its_for`, `category`. Logo via URL field for now; file upload (multer) comes in a follow-up.
- **Dashboard updates:** "Edit profile" button on the profile preview card. Sign-up page footer links to login.

---

## 2026-05-18 — developer dashboard registration flow (PR 2 of the onboarding-redesign build)

No contract change. New user-facing surface at `neighborhood-commons.org/developers` that replaces the curl-based service-key registration flow with a server-rendered HTML form. Documented in [`docs/onboarding-redesign.md`](docs/onboarding-redesign.md) §4.1–4.3.

- **New pages** (server-rendered HTML, no JS required):
  - `GET /developers/sign-up` — registration form (email, app name, tagline, description, app URL, internal review fields).
  - `GET /developers/verify` — OTP entry form.
  - `GET /developers/dashboard` — read-only view of status, service key, profile preview. Surfaces the just-issued key exactly once.
- **New form handlers** (POST):
  - `/developers/register` — validates, holds form data in `pending_registrations`, sends 8-digit OTP, redirects to verify.
  - `/developers/verify` — validates OTP, runs atomic provisioning (creates `contributor_profile` + tenant `portal_account` + pending `api_key` + `developer_session`), sets session cookie, redirects to dashboard.
  - `/developers/logout` — destroys session, clears cookie.
- **DB-backed sessions** via `developer_sessions`. 24-hour expiry; revocable by deleting the row.
- **CSRF protection** via double-submit cookie (`nc_dev_csrf`). All form POSTs validated.
- **Rate limited:** 10 form submissions / 15 min / IP; 60 page renders / min / IP.
- **The existing `/v1/service/register/*` curl flow remains** for backward compatibility. PR 5 retires it.

---

## 2026-05-18 — 3.1.0 — contributor profiles (foundation for the developer dashboard)

Additive. PR 1 of the onboarding-redesign build ([`docs/onboarding-redesign.md`](docs/onboarding-redesign.md) §12). Lays the schema and public read surface for the developer portal at `/developers`. Subsequent PRs add the dashboard UI; this one ships the foundation underneath.

- **New public reads:** `GET /v1/contributors` and `GET /v1/contributors/{idOrSlug}`. Returns the public-facing identity of each contributing app — slug, name, tagline, description, logo, app URL. Only `status = 'active'` profiles surface. Use these to render the "via {contributor}" tap-through splash card.
- **New schema:** [`ContributorProfile`](public/openapi.json) — the stable cross-key identity of one consumer app. Slug survives api_key rotation.
- **Event response `source.contributor` expanded.** When an event is linked to a registered contributor_profile (via the new `events.contributor_profile_id` column), `source.contributor` now carries `{name, url, slug, logo_url, description, profile_url}`. Pre-3.1 events fall back to the legacy `{name, url}` snapshot with the new fields as null. The expansion is additive — existing consumers reading `contributor.name` / `contributor.url` continue to work unchanged.
- **Migration 086:** new tables `contributor_profiles`, `developer_sessions`, `magic_login_tokens`, `pending_registrations`. New columns on `api_keys` (`contributor_profile_id`, `mfa_*`) and `events` (`contributor_profile_id`). RLS enabled (default-deny) on all new tables.
- **SDK bumped to 3.1.0.** New `ContributorProfile` type export from [`neighborhood-commons`](sdk/src/index.ts).

What's *not* in this release (PR 2–5): the registration form, magic-link login, MFA enrollment, profile management UI, operator activation page, retrofit script. Those land in subsequent PRs of the onboarding-redesign build.

---

## 2026-05-18 — 3.0.0 — provenance doctrine and four-role event frame

Pre-launch coherent fix. The 2.0.0 draft carried a confused `source.publisher` field whose contents were heterogeneous (sometimes app name, sometimes organizer name), producing real downstream bugs. The model is fixed before any external consumer builds against the contract. The 3.0.0 contract is the foundation the substrate launches with; additive-only stability begins from here.

- **BREAKING: removed `source.publisher` from the public event response.** The role "who is this from?" is filled by `organizer.name` (the joined organizations row). No consumer should read `source.publisher`; read `organizer.name` instead.
- **BREAKING: `source.method` values changed.** The new vocabulary is `self_asserted` / `proxied` / `witnessed`. Legacy values (`api`, `portal`, `import`, `feed`, `admin`, `merrie`, `csv`) are mapped to the new vocabulary in migration 085. `seeded` is added but not valid for events.
- **`source.url` added** — non-null when method is `proxied` (carries the URL the contributor extracted from, for transparency).
- **Service API `source_method` enum is now `['self_asserted', 'witnessed']`** for caller-set provenance. `proxied` is reserved for internal pipeline code paths.
- **Added `Organization.method`** carrying the standard provenance vocabulary (`self_asserted`, `proxied`, `witnessed`, `seeded`). Bulk-imported rows default to `seeded`; orgs with a verified `organization_verifications` row are backfilled to `self_asserted`. Consumers can filter for `self_asserted` orgs to surface only first-party-asserted records.
- **Added `Broadcast.method` and `List.method`** for symmetry across primitives. Only `self_asserted` is valid today on these types.
- **New doctrine docs:** [`docs/provenance.md`](docs/provenance.md) (type-general doctrine: every public-fact primitive carries a `method` field) and [`docs/four-roles.md`](docs/four-roles.md) (event-specific application: organizer, venue, contributor, method+URL). Both replace the earlier draft.
- **OpenAPI spec bumped to 3.0.0.** SDK `neighborhood-commons` bumped to 3.0.0.

Migration 085 (`085_provenance_method_cleanup.sql`) handles the data and schema changes. Idempotent.

---

## 2026-05-17 — source.contributor auto-fill (ecosystem attribution)

Service-tier event POSTs now auto-fill `source.contributor.name` from the calling key's `brand_config.app_name` when the caller didn't supply a `contributor` field explicitly. Makes ecosystem attribution work by default: every event Merrie pushes shows `source.contributor = { name: "Merrie", url: null }` on the read path without Merrie having to remember the field. Same for other consumer apps. Admin keys (Studio, operator tools) skip the auto-fill — they act on behalf of organizations, they're not ecosystem contributors. The transform-time fallback that previously used `source_publisher` as a stand-in for `contributor` on api-method events is removed — that conflated publisher (who the event is FROM) with contributor (which app pushed it IN). Events created before this change with a null `source_contributor_name` will now show `source.contributor: null` instead of incorrectly echoing the publisher name; that's a more honest read.

---

## 2026-05-17 — trusted-tenant pattern (operational follow-up)

Photo-eligibility gate fix surfaced by Merrie. The v2 gate requires every Organization to have a claimed owner account; tenant-umbrella consumers (Merrie publishing on behalf of community groups) don't have per-publisher portal_accounts, so photo uploads failed with `IMAGE_NOT_PERMITTED` on every Merrie-created org.

- Migration 084: `api_keys.tenant_account_id uuid REFERENCES portal_accounts(id)` — optional one-to-one binding. When set, `POST /service/organizations` auto-derives `owner_account_id` from this column. Tenant-umbrella consumers provision one shared `portal_account` and bind their key; future orgs they create inherit the ownership relationship server-side; consumer payloads need no extra fields.
- `CLAUDE.md` § "No Users in the Commons" gains a "Trusted-tenant pattern" subsection documenting the model.
- `scripts/provision-merrie-tenant.ts` updated to set `tenant_account_id` after provisioning the tenant row.
- Backfill SQL for existing Merrie-created orgs in commit notes (not a generic migration — operator runs once with the actual Merrie key + tenant UUIDs).

The parallel-scope model still holds: `api_key_organization_links` is write authority; `api_keys.tenant_account_id` is ownership-derivation. Different concerns, different storage.

---

## 2026-05-17 — v2.0.0

The v2 release. Coherent bundle of breaking changes that simplify the substrate around a tighter conceptual model. Documented in full in [`docs/v2-migration-plan.md`](docs/v2-migration-plan.md) and articulated in [`CLAUDE.md`](CLAUDE.md). The substrate is now defined around **Type A (durable profile data, first-party only)** vs **Type B (transactional/episodic, constrained publishing)** with three valid authority paths: entity-runs-it, pipeline-proxies, witnessed-with-evidence.

### Schema

- Migration 078: additive v2 columns — `organizations.tags`, `organizations.commercial`, `places.place_categories`, `places.category_source`, `places.category_reviewed_{at,by}`, `events.match_key`, `api_keys.witness_authority`. Extended `events.source_method` enum to include `'witnessed'`. All non-breaking; defaults / nullables.
- Migration 079: migrated `persons` rows to `organizations` (preserved UUIDs; PII-flavored fields like `given_name`/`family_name` not copied). Re-pointed `events.organizer_person_id`, `lists.curator_person_id`, and `account_verified_identifiers.target_type='person'` references to the migrated organizations.
- Migration 080: created `organization_verifications` table (the v2 replacement for `account_verified_identifiers` — no polymorphic `target_type`, no `identifier_domain`). Migrated active `target_type='organization'` rows.
- Migration 081: backfilled `events.organizer_org_id` for any remaining orphans via location_place_id and creator_account_id chains; placeholder "Unknown Organizer" org for unresolvable rows; added NOT NULL constraint on `events.organizer_org_id`.
- Migration 082: dropped deprecated schema. Tables: `persons`, `account_verified_identifiers`, `groups`, `group_venues`, `api_key_account_links`, `developer_otps`. Columns: `events.organizer_person_id`, `lists.curator_person_id`, `organizations.kind`, `event_performers.person_id`. Added `event_performers.performer_name` for free-form fallback. Narrowed `portal_accounts` to operational columns only (email, claim, status, timestamps) — business-profile data lives on organizations.

### API

- `BREAKING:` Removed `/v1/accounts` and `/v1/accounts/:idOrSlug`. Replaced by `/v1/publishers` and `/v1/publishers/:idOrSlug` reading from organizations.
- `BREAKING:` Removed `/v1/persons` and `/v1/persons/:idOrSlug`. Solo performers/DJs/individual hosts are now organizations.
- `BREAKING:` Removed `/v1/verifiers` and `/v1/verifiers/:appName/recent_approvals`. The cross-app reputation graph was overengineered and not load-bearing under the v2 model. Verification's job narrowed to anchoring Type A authority for organizations only.
- `BREAKING:` Removed `/api/v1/contribute` (and `/contribute/batch`, `/contribute/mine`, `/contribute/:id`). The wild-west publishing path is gone. All event writes go through `/v1/service/events` with organizer authority enforcement.
- `BREAKING:` Removed `/v1/service/persons`.
- `BREAKING:` Service API event writes (`POST /v1/service/events`, `PATCH /v1/service/events/:id`) now require `organizer_org_id`. The calling service key must be linked to that organization via `api_key_organization_links`, OR have `witness_authority=true` with `source_method='witnessed'`. Cross-organization writes return `403 NOT_LINKED`.
- `BREAKING:` Service API list writes constrain to reference-only — list items must reference existing primitives.
- `BREAKING:` Verification submission API drops the `targetType` field; only organizations verify.
- `BREAKING:` Event response `organizer` is always an organization reference (no Person variant). Same for list `curator`.
- `BREAKING:` Organization response drops `kind` field. Replaced by `tags` (text[]) and `commercial` (boolean | null).
- New: `GET /v1/publishers` and `GET /v1/publishers/:idOrSlug` — organizations that publish, with verification status hydrated.
- New: `GET /v1/meta/tags` — recommended organization tag starter vocabulary.
- New: `/v1/events` filters extended — `first_party=true|false` (authority tier), `tag=` (organization tags), `commercial=true|false`, `place_category=` (OSM-sourced).
- New: Event response gains `organizer.{id, slug, verified}` and `place.{placeCategories, categorySource}`.
- New: Webhook event payloads carry the same enriched organizer block, including `verified` — consumer tier-rendering can use it directly without a separate verification lookup.

### Spec + SDK

- `BREAKING:` `public/openapi.json` bumped to 2.0.0, rewritten for the v2 surface. All removed endpoints documented as gone; new endpoints and field additions documented.
- `BREAKING:` SDK `neighborhood-commons@2.0.0` published. Types regenerated from the new spec — no Person, no kind enum, single organizer shape, etc. Push `sdk-v2.0.0` tag to trigger publish workflow per `sdk/RELEASING.md`.

### Documentation

- `CLAUDE.md` rewritten for v2. Mission framed plainly: public store of public facts about neighborhoods. Type A/B framing as the load-bearing distinction. No-users principle explicit. Three authority paths (entity-runs-it, pipeline-proxies, witnessed-with-evidence). Verification scope narrowed. Funding pathways acknowledged as multiple — classifieds is the designed mechanism; grants are one path; foundation partnerships and participant cost-sharing are others.
- `public/llms.txt` rewritten to match. Five typed atoms (no more six). Pillars reframed (Trusted → Authoritative). Section 5 (Verification) narrowed substantially. New Section 8 (Sustainability) pointing at the classifieds design doc.
- `public/index.html` updated for v2 across both marketing and docs sections.
- `docs/classifieds.md` (new): sustainability story design. Anti-monopolistic two-sided market (publications set rates AND accepted categories), anti-surveillance by app-affinity targeting, two-layer grant pathway as one option.
- `docs/future-considerations.md` (new): deferred decisions and their reasoning (identity claims layer, match-key clustering algorithm, OSM contribute-back, stewardship attestation, etc.).
- `docs/v2-migration-plan.md` (new): formalized phased migration plan.
- `docs/consumer-guide.md`: thinned to a pointer document; canonical Guide is now `llms.txt`.
- Four per-app migration briefs in `docs/migration-brief-{fiber,merrie,holler,studio}.md` for use by Claude Code sessions in those repos.

### Place categorization — new policy

- Google's Places API can be consulted at runtime; only `google_place_id` is permitted indefinite storage under Google's terms.
- Place categorization comes from OpenStreetMap (ODbL, attributed in licensing notes) stored in `places.place_categories`.
- Admin review and publisher self-declaration are alternate sources, tracked via `places.category_source`.
- Studio's contribute-back-to-OSM workflow (future, post-v2) acts only on `admin_review` and `publisher_declaration` rows — never on data sourced from Google.

### Migration guide for consumers

The Commons currently has one consumer ecosystem (Fiber, Merrie, Holler, Studio — all operator-owned). Per-app migration impact:

- **Fiber** (~0.5 day) — v2-clean by construction; mechanical updates only.
- **Merrie** (~3-4 days code + voices product transition) — retire curator/list-maker role; enforce organizer_org_id on writes.
- **Holler** (~2-3 days) — simplify verification messaging; endpoint renames.
- **Studio** (~13 days) — includes ~7-day Google compliance scrub (pre-existing gap surfaced by v2 planning).

See the per-app migration briefs in `docs/migration-brief-*.md` for the full audit shape.

---

## 2026-05-14

- New: `POST /service/api-keys/{id}/activate` now accepts an optional `provision_account` body — atomically (a) flips the pending key to active, (b) creates the consumer's tenant `portal_account`, and (c) links the now-active key to it. The activation response includes the new `account.id`. Tenant-umbrella consumers (Merrie, GoThere, etc.) include `provision_account` in their activation request email; the operator passes it through; the consumer receives their UUID in the activation reply with no second round-trip required. Per-operator portable consumers omit the field and continue to call `/service/accounts/link` per operator — strictly additive change.
- Architectural principle, made explicit: pending service-tier keys are strictly read-only. No portal_account, no organization, no event can be created before activation. The atomic `provision_account` path exists precisely so consumers never have a pre-activation footprint that might pressure the activation review — review remains the single quality gate.
- Spec: 409 CONFLICT added to the activate endpoint responses, raised when `provision_account` matches an existing account with `auth_user_id` set or claimed under a different `claimed_by`. The activation itself still succeeds in those cases; only the bundled provision step fails, and admin can resolve via `/service/accounts/link` after the fact.
- Documentation: `docs/consumer-guide.md` "Getting a service key" section reframed. Activation is positioned as a substantive review of the consumer's use case and data quality plan, not an SLA-driven turnaround. The activation request template now asks for the `provision_account` block directly. The "Setup (one-time)" section under Consumer patterns documents the atomic-provisioning flow as the canonical tenant-umbrella path; `/service/accounts/link` remains documented for per-operator portable consumers.
- Documentation: `docs/consumer-guide.md` gained a "Growing from reader to contributor" section walking the read → webhook → contribute progression explicitly, and a "Writing isn't reading: how publisher reputation actually works" section articulating the consumer-filter mechanic. The latter is the philosophical anchor: **the Commons gives you write access; it doesn't give you readership.** Both sections mirrored to `public/llms.txt` (§4.0 and §4.0.1) so AI assistants reading the canonical guide can articulate the design + reasoning. Webhook section now flags the self-feedback loop (your own writes generate webhooks back to you). Email contact aligned across docs to `hi@neighborhood-commons.org`.
- Documentation + policy: new "Copyright and image rights" section in `docs/consumer-guide.md` and mirrored as §4.13 in `public/llms.txt`. Covers the contributor-warranty model (you upload, you warrant, you indemnify), the takedown procedure (`copyright@neighborhood-commons.org`, 48-hour turnaround for substantiated claims), the repeat-infringer policy (1st: warning; 2nd: suspension; 3rd: revocation), and explicit guidance for both contributors (safe vs unsafe content) and consumers (filter for confidence, handle 404s gracefully, no rights certificates promised). LICENSE section reframed to distinguish CC BY 4.0 on data (which we hold the right to license) from images (where the license is asserted in good faith based on contributor warranties). Activation request template expanded to require an explicit image-sourcing plan from the consumer.
- Bug fix: `IMAGE_NOT_PERMITTED` photo-eligibility gate previously rejected service-key-claimed accounts (the entire tenant-umbrella pattern we just shipped). The check used `account.auth_user_id` as a proxy for "claimed", but service-key-claimed tenant accounts have `claimed_at` set and `auth_user_id` null. Gate now accepts either signal; `lib/contributor-policy.ts` helper updated to match. Without this, Merrie's tenant could not have uploaded a single event poster.
- Spec: `IMAGE_NOT_PERMITTED` added to the `ErrorCode` enum in `public/openapi.json` and to the description's "Media / content" group. The code has been throwing it from the service-events handler since at least migration 048, but the spec hadn't documented it — closing a quiet contract gap.
- Test fix: `tests/contract-drift.test.ts` regex for `createError(...)` calls didn't match the multi-line form with a trailing comma after the code string (which is the form the rest of the codebase actually uses). That's how `IMAGE_NOT_PERMITTED` slipped past the ErrorCode-enum guard. Regex now accepts an optional comma between the code and the closing paren, with a comment explaining why.
- Legal: registered a Designated DMCA Agent with the U.S. Copyright Office, effective today (Registration No. DMCA-1072738). The Commons now has formal safe-harbor standing under 17 U.S.C. § 512(c). Agent of record: Zachary Benjamin, 937 N 2nd St 3F, Philadelphia, PA 19123, 503-449-5572, `dmca@neighborhood-commons.org`. Published in `docs/consumer-guide.md` and `public/llms.txt` § 4.13 as the law requires. The designation reflects the current posture of the Commons as operated by an individual; a formal entity is expected to succeed this filing once funded under grant-supported legal counsel.
- The registered agent email is `dmca@neighborhood-commons.org`, a role-based address that forwards to the operator's inbox. Routing the federal channel through a project-branded address rather than a personal one keeps the operator's personal email off the public-facing DMCA surface entirely; the personal email never appears on `neighborhood-commons.org`. Recommended setup for any consumer or partner project mirroring this pattern.
- Followup deferred: linking the DMCA agent disclosure from the homepage footer (rather than only from `docs/consumer-guide.md` and `llms.txt`) is a polish item for when the homepage gets its next pass.

---

## 2026-05-12

- New: `PATCH /api/v1/service/events/{id}/organizer` is now implemented (the endpoint was previously in the Spec but not the runtime). Body: `{ organizerOrganizationId?: string | null, organizerPersonId?: string | null }`. Sets exactly one of `events.organizer_org_id` / `events.organizer_person_id`; sending both non-null returns 400 VALIDATION_ERROR. Sending both null clears the organizer.
- Tightened: Spec language for the organizer endpoint to reflect the actual auth rule. Authorization for non-admin keys: caller's key is linked to **either** the event's `creator_account_id` (covers the initial-set case where organizer is NULL on a brand-new event) **or** its current `organizer_org_id` (covers re-attribution by the current organizer). When the current organizer is a Person, only admin keys can re-assign until person-link semantics ship. The previous "scoped to events whose current organizer is linked to the calling key" wording didn't cover the first-set case and would have failed every Merrie golden-path call.
- Hardened: `POST /service/accounts/link` now refuses (409 CONFLICT) to link an account that has `auth_user_id` set (Supabase Auth owner) or has been claimed under a different `claimed_by` identifier. Admin keys bypass. Defense-in-depth alongside the tenant-umbrella pattern, where a sentinel email is the primary defense against unwanted claim attempts.
- New: `OrganizationInput` schema description now documents the parallel model explicitly — `account_id` (on events) and `organizerOrganizationId` are parallel fields, not hierarchical; authorization flows through two separate key-link tables (`api_key_account_links` and `api_key_organization_links`). No `owner_account_id` input field on org create — never was, now documented.
- New: `docs/consumer-guide.md` "Consumer patterns" section walks through the two consumer postures — tenant umbrella (one shared `account_id`, organizations under it, used by publishing platforms like Merrie) vs per-operator portable (one account per operator, claimable, used by business-operator tools like Holler). Tenant umbrella is recommended default; per-operator opt-in when portability is the value being sold.
- SDK 1.1.0: new `assertPublicPayload(body, allowedKeys, label?)` runtime helper exported from `neighborhood-commons`. Defensive PII-boundary check for consumer apps publishing under the tenant-umbrella pattern — throws synchronously on the first disallowed key in the payload. Tag `sdk-v1.1.0` after merge to publish.
- Documented: `POST /service/accounts/link` is now in `public/openapi.json` (was runtime-only since the 1.0.0 transition). The endpoint is the canonical self-service entry point for both consumer patterns — tenant-umbrella apps call it once with a sentinel email; per-operator-portable apps call it per operator. Typed SDK clients (`commons.POST("/service/accounts/link", ...)`) now work without raw fetch. No runtime behavior change; closing a contract gap.
- Documented: `docs/consumer-guide.md` now includes a "Getting a service key" section walking through the full key lifecycle — self-service OTP registration → development against a pending key → emailing `hello@neighborhood-commons.org` for activation → `POST /service/accounts/link` for tenant provisioning. Closes the "what do I do between getting a pending key and being able to write" gap; previously implicit, now explicit.
- Provisioning script: `scripts/provision-merrie-tenant.ts` clarified as an operator-only one-shot for the Merrie case (operator and Merrie operator are the same person) and the rare pre-activation-provisioning case. Third-party consumers should use `POST /service/accounts/link` instead.
- Known downstream gap: the public API's `organizer.name` is still derived from `portal_accounts.business_name` (creator account), not from `organizer_org_id`. Setting an organizer via the new PATCH endpoint correctly persists the column but won't surface in `GET /v1/events/{id}` responses until `event-transform.ts` is updated to read the linked organization. Separate fix; tracked for the verification-aware transform pass.

---

## 2026-05-06

- Canonical URL is now the apex `https://neighborhood-commons.org`. The previous `api.neighborhood-commons.org` host now 308-redirects every path to the apex (preserves method + body), so existing clients keep working. The OpenAPI spec, SDK default base URL, llms.txt, and README all point at the apex. CSP no longer needs to allowlist the api subdomain. One canonical host means the rendered `/spec` page can call its own server without cross-origin friction; future docs/UI never have to pick which subdomain to reference.
- SDK 1.0.1: `DEFAULT_BASE_URL` is now `https://neighborhood-commons.org/api/v1`. Patch bump because consumers passing an explicit `baseUrl` are unaffected, and consumers relying on the default get transparently redirected to the same data via the 308 even on older SDK versions. Tag `sdk-v1.0.1` after merge to publish.
- No spec field changes, no error-code changes, no rate-limit changes.

---

## 2026-05-06 (SDK 1.0.0)

- Canonical URL is now the apex `https://neighborhood-commons.org`. The previous `api.neighborhood-commons.org` host now 308-redirects every path to the apex (preserves method + body), so existing clients keep working. The OpenAPI spec, SDK default base URL, llms.txt, and README all point at the apex. CSP no longer needs to allowlist the api subdomain. One canonical host means the rendered `/spec` page can call its own server without cross-origin friction; future docs/UI never have to pick which subdomain to reference.
- SDK 1.0.1: `DEFAULT_BASE_URL` is now `https://neighborhood-commons.org/api/v1`. Patch bump because consumers passing an explicit `baseUrl` are unaffected, and consumers relying on the default get transparently redirected to the same data via the 308 even on older SDK versions. Tag `sdk-v1.0.1` after merge to publish.
- No spec field changes, no error-code changes, no rate-limit changes.

---

## 2026-05-06 (SDK 1.0.0)

- SDK: published `neighborhood-commons@1.0.0` on npm, aligning the SDK major version with the spec major version. Generated types now reflect the corrected `first_party` semantics (server-computed, not caller-provided). No code changes from prior 0.0.4 generation other than the spec-driven type updates and the version bump itself. Per `sdk/RELEASING.md`: `git tag sdk-v1.0.0 && git push origin sdk-v1.0.0` on master after merge to trigger the publish workflow.
- Fixed: `events.first_party` is now computed server-side at insert time from the organizer's verification state, never trusted from caller input. Pre-1.0 the portal route auto-set `first_party=true` on every portal-submitted event ("Portal events are always entered by the originator"), and the service-tier `ServiceEventInput` accepted it as a free-form boolean. Both were inherited from a time when verification didn't yet exist; in the new model, `first_party=true` means *the organizer is a verified business* and that's a fact about the system, not a claim a caller can self-issue.
- Spec: removed `first_party` from `ServiceEventInput` (input shape). Still present on the `Event` and `ServiceEvent` output shapes; description updated to reflect server-computed semantics. Existing service-tier callers sending `first_party` now have it silently stripped by the input parser; no 4xx, no breakage.
- Migration 076: `UPDATE events SET first_party = false WHERE first_party = true`. The 25 existing events with `first_party=true` were misattributed by the legacy portal logic — no organization is currently verified, so no event should be first-party. Backfilled to false. Going forward, first_party flips to true automatically as venues' verifications land.
- New helper: `isFirstPartyByOrganizer(orgId, personId)` in `src/lib/verification-hydrate.ts`. Used by both portal and service write paths.

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
