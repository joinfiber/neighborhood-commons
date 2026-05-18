# Service-tier Onboarding & Developer Dashboard — Redesign

**Status:** Design approved (May 2026). Implementation pending in stages — see §12.
**Authors:** Operator + Claude.
**Supersedes:** the hodgepodge documented in §1.

## 0. The framing

The Neighborhood Commons is a two-sided market. Readers get aggregated content; **writers get distribution and brand exposure to readers they wouldn't reach on their own.** A user in Fiber discovering Merrie via attribution — "Tuesday Knit Night, via Merrie" — and tapping through to "what is Merrie?" is the literal mechanism by which the ecosystem grows.

For this loop to function, three things have to be true:

1. **Onboarding is short and dignified.** A developer can get from interest to "I have credentials and can build" in minutes, via a self-service flow that signals "this is a serious endeavor." If onboarding feels makeshift, the type of contributor we want — the true-hearted participant who'll put effort into ecosystem fit — bounces.
2. **Every contributing app has presentable identity.** Not just a name attached to events — a description, a logo, a tagline, a "who this is for." When a reader taps "via Merrie," they get a splash that lets them understand the app and consider joining it.
3. **That identity is under the developer's control.** They edit it themselves, on their schedule, without operator labor. Protected by MFA because once it's live, it's a distribution surface.

This document is the design for delivering those three properties. The current state delivers none of them cleanly. The endpoint exists for some pieces but the path is a maze; the data exists for others but isn't surfaced; the polish needed for the rest is yet to be built.

## 1. What we have today

A new developer who wants to publish into the Commons currently traverses up to five API surfaces plus an out-of-band operator script:

| # | Surface | Who calls | What it does |
|---|---------|-----------|--------------|
| 1 | `POST /v1/service/register/send-otp` | Developer | Generates OTP, emails it. No application metadata captured. |
| 2 | `POST /v1/service/register/verify-otp` | Developer | Validates OTP, issues pending key. Captures `app_name`, `app_url`, `what_youre_building`, `verification_process` into `application_metadata`. |
| 3 | `POST /v1/service/api-keys/{id}/activate` | Operator | Flips `activated_at`. Optionally accepts `provision_account`, `brand_config`, `verification_authority`, `rate_limit_per_hour` — each typed in manually. |
| 4 | `POST /v1/service/accounts/link` | Developer (post-activation) | Find-or-create tenant portal_account. Overlaps with `activate-with-provision_account`. Doesn't set `tenant_account_id`. |
| 5 | `POST /v1/service/organizations` | Developer | Creates an organization, auto-links the calling key. |

Plus operator-only escape hatches:

- `POST /v1/service/api-keys` — direct admin issuance, bypasses OTP.
- `scripts/provision-merrie-tenant.ts` — manual SQL-as-script for Merrie's existing key.

### 1.1 What's wrong with this

- **Capture-twice.** `app_name`/`app_url` captured at `/verify-otp`, then `brand_config.app_name` typed in *again* by the operator at activation. Same data, no derivation.
- **Tenant provisioning is split across three paths** (`activate-with-provision_account`, `/accounts/link`, the Merrie script). None set `tenant_account_id`. The result: every consumer hits the photo-eligibility gate on their first event-with-image because no upstream step wired ownership.
- **Sentinel-email patterns leak into the spec** — `/accounts/link` documentation tells consumers to use `tenant@no-reply.your-domain`, exposing operational defense-in-depth as a contract concept.
- **No public-facing presentation surface.** `source.contributor` exists on events but is a thin attribution string. There's no way for Fiber to render a "what is Merrie?" splash; no place for Merrie to describe itself; no logo, no tagline, no description. The ecosystem-flourishing loop has no surface to flow through.
- **No self-service management.** Every change to brand identity (description, app name, logo, sender domain) requires operator labor.
- **No dignity signal.** The onboarding ritual today is "curl six endpoints, copy values between them, wait for SQL." That's not what we want a polished citywide-civic-tech contributor to encounter on day one.

## 2. The goal

A developer:

1. Lands at `neighborhood-commons.org/developers`, fills a single form (email, app identity, application narrative), and verifies via OTP.
2. Returns to a dashboard that shows their pending status, their service key, and a preview of how they'll present across the ecosystem. Reads work; writes return `KEY_PENDING`. They build.
3. Receives an activation email when the operator reviews and approves. The email prompts MFA enrollment. They scan a TOTP QR, confirm.
4. Returns to the dashboard with writes live. From here, every edit to public-facing presentation requires a TOTP step-up.

A reader in Fiber:

1. Sees an event with a small "via Merrie" badge.
2. Taps. A splash card renders, drawing from the public `/v1/contributors/merrie` endpoint — Merrie's name, tagline, description, logo, link to merrie.co.
3. Reads, understands, optionally clicks through to Merrie's own site.

For Merrie, the same flow as a brand-new developer, but with a retrofit path that promotes their existing key into the new model without re-issuing credentials.

## 3. The data model

### 3.1 `contributor_profiles` (new table)

```
contributor_profiles
─────────────────────────
id                   uuid PRIMARY KEY
slug                 text UNIQUE NOT NULL   -- stable cross-key identifier
name                 text NOT NULL          -- display name; "Merrie"
tagline              text                   -- ~80 chars; one-liner
description          text                   -- ~2000 chars; markdown-ish
who_its_for          text                   -- ~500 chars; audience description
app_url              text                   -- public marketing/app URL
logo_url             text                   -- R2-served logo
category             text                   -- optional grouping tag
status               text NOT NULL          -- 'pending' | 'active' | 'suspended'
created_at           timestamptz NOT NULL DEFAULT now()
updated_at           timestamptz NOT NULL DEFAULT now()
```

Each row is the *public-facing identity* of one contributing app. Survives api_key rotation (the slug stays stable; new keys point at the same profile row).

### 3.2 `api_keys` additions

```
api_keys
─────────────────────────
... (existing columns) ...
contributor_profile_id   uuid REFERENCES contributor_profiles(id) ON DELETE SET NULL
mfa_secret_encrypted     bytea           -- TOTP shared secret, encrypted at rest
mfa_enrolled_at          timestamptz     -- null until developer enrolls TOTP
mfa_backup_codes_hashed  text[]          -- one-time recovery codes (SHA-256)
```

The MFA columns are on `api_keys` rather than a separate table because MFA is per-key (or per-account; see §9.5). In practice each consumer has one primary key; we can model differently later if we add multi-key per developer.

### 3.3 `developer_sessions` (new table)

```
developer_sessions
─────────────────────────
id                   uuid PRIMARY KEY DEFAULT gen_random_uuid()
api_key_id           uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE
token_hash           text NOT NULL                    -- session cookie value, hashed
mfa_verified_at      timestamptz                      -- null until step-up; resets at 15min
last_seen_at         timestamptz NOT NULL DEFAULT now()
expires_at           timestamptz NOT NULL              -- 24h from creation
created_at           timestamptz NOT NULL DEFAULT now()
```

DB-backed sessions (not JWTs) so the operator can revoke instantly. Token is a random 256-bit string; cookie carries the raw, DB stores the hash.

### 3.4 `magic_login_tokens` (new table)

```
magic_login_tokens
─────────────────────────
id                   uuid PRIMARY KEY DEFAULT gen_random_uuid()
email                text NOT NULL                    -- normalized lowercase
token_hash           text NOT NULL                    -- the magic-link value, hashed
expires_at           timestamptz NOT NULL              -- 15 minutes from creation
consumed_at          timestamptz                      -- single-use
created_at           timestamptz NOT NULL DEFAULT now()
```

Same pattern as `developer_otps` (registration OTP), separate table because the lifecycle and consumption rules differ.

## 4. The canonical onboarding path

### 4.1 Step 1 — Developer fills the sign-up form

URL: `neighborhood-commons.org/developers/sign-up`

Single page form. Fields:

- **Email** (required)
- **App name** (required)
- **Tagline** (required, ~80 chars)
- **Description** (required, ~2000 chars, markdown-aware)
- **Who it's for** (optional, ~500 chars)
- **App URL** (required)
- **Logo upload** (optional, image; routed through Sharp pipeline)
- **Category** (optional, free-form)
- **What you're building** (required, internal — for operator review only)
- **Verification process** (required, internal — operator review)

Form POSTs to `POST /v1/developers/register`. Server:

1. Generates an OTP (8-digit numeric, 10-minute expiry), stores hashed in `developer_otps`, emails it.
2. Holds the rest of the form data in a `pending_registrations` table keyed by email (so the OTP step doesn't lose data on refresh).

Developer is redirected to `/developers/verify` with a code input.

### 4.2 Step 2 — Developer verifies

URL: `neighborhood-commons.org/developers/verify`

Enters the OTP. Form POSTs to `POST /v1/developers/register/verify`. Server atomically:

1. Validates the OTP against `developer_otps`. Consumes it.
2. Reads the held form data from `pending_registrations`.
3. Slugifies `app_name` to derive a unique slug (`merrie`, with collision handling — see §9.1).
4. Creates a `contributor_profiles` row with the form data, `status='pending'`.
5. Creates a `portal_accounts` row with sentinel email `<slug>-tenant@no-reply.neighborhood-commons.org`, `claimed_at=now()`, `claimed_by=<slug>`.
6. Issues a `pending` service-tier api_key. Sets:
   - `application_metadata` from the operator-review fields
   - `contributor_profile_id` to the new profile row
   - `tenant_account_id` to the new portal_account
   - `brand_config` derived from `app_name` and `app_url`
7. Clears the `pending_registrations` row.
8. Establishes a developer session (24h cookie).
9. Redirects to `/developers/dashboard`.

The developer sees their dashboard, with their service key, status (`pending`), and preview of their public profile. They can copy the key, start building. Reads work; writes return `KEY_PENDING`.

### 4.3 Step 3 — Developer builds while pending

The dashboard remains accessible (logged in via the session from step 2). Developer can:

- View status
- See and rotate the service key (only via the security page)
- Edit profile fields (no MFA gate yet — operator hasn't approved; edits feed into the eventual review)
- Read documentation links

Behind the scenes: any `POST /v1/service/events` or other write call from the developer's key returns `KEY_PENDING`. Read paths work — the developer integrates against the real API.

### 4.4 Step 4 — Operator activation

Operator's view: `/operator/applications` (admin-keyed page) lists pending applications. Each shows:

- Application metadata (`what_youre_building`, `verification_process`)
- Public-profile preview (how the contributor will look in Fiber etc.)
- Stats (when registered, dev's email)
- Two buttons: **Activate** | **Request revisions** (with note)

On Activate: handler `POST /v1/service/api-keys/{id}/activate`:

1. Flips `activated_at`.
2. Sets `contributor_profiles.status = 'active'` for the linked profile.
3. Sends the **activation email** to the developer. Subject: "Your Neighborhood Commons key is active." Body includes:
   - "Writes are now live."
   - A link to `/developers/security/enroll-mfa` (one-time enrollment trigger).
   - A link to the docs.

On Request revisions: handler updates `contributor_profiles` with a `revision_request_note` field (new column on the table), emails the developer with the note. Profile status stays `pending`. Developer logs in, sees the note, revises, resubmits (effectively just saves — next-time-operator-looks they see the update).

### 4.5 Step 5 — MFA enrollment

Developer clicks the activation email link. Lands on `/developers/security/enroll-mfa`. Page shows:

- A QR code (TOTP shared secret encoded for Google Authenticator etc.)
- A text field to enter the first 6-digit code
- A note: "Save your backup codes" + 10 backup codes displayed once.

Submits the code. Server validates, stores the secret (encrypted), persists hashed backup codes, marks `mfa_enrolled_at`.

From this moment forward, every edit to public-presentation fields on the developer's profile requires a fresh TOTP step-up (15-min window).

### 4.6 Step 6 — Ongoing management

Developer can return to `/developers/dashboard` anytime. To edit anything, they request a TOTP step-up (enter their current TOTP code). Once verified, the session is "elevated" for 15 minutes — any number of edits during that window pass. After 15 minutes, the next edit prompts another TOTP.

For sensitive operations (rotating the service key, deleting the account), step-up is required even within an active elevated window (fresh challenge).

## 5. The security model

### 5.1 Threat model

We're protecting against four scenarios:

1. **Email compromise.** Someone gets into the developer's email. They could read magic-link emails and log in. MFA gates writes, so they can read the dashboard but can't edit the public profile or rotate the key.
2. **Session cookie theft.** Someone steals the developer's session cookie. They can read the dashboard but can't edit anything (MFA step-up needed for writes).
3. **TOTP device loss.** Developer loses their phone. Backup codes cover this; if those are also lost, operator-mediated recovery via out-of-band identity verification.
4. **Hijacked active account distributing malicious content.** This is the worst case — attacker gets full access. MFA at every write boundary keeps this hard; rapid revocation via the DB-backed session table contains it if it happens.

### 5.2 Auth boundaries

| Operation | Pre-activation | Post-activation |
|-----------|----------------|-----------------|
| Submit registration form | nothing (anyone can attempt) | n/a |
| Verify OTP, establish session | OTP via email | n/a |
| Log in (return visitor) | magic link via email | magic link via email |
| View dashboard / read own data | session | session |
| Edit profile fields | session | session + TOTP step-up |
| Rotate service key | session + TOTP step-up | session + fresh TOTP |
| Delete account | session + TOTP step-up + email re-confirmation | session + fresh TOTP + email re-confirmation |
| Enroll/rotate MFA device | session + current TOTP (or backup code) | session + current TOTP (or backup code) |

### 5.3 Session lifecycle

- Session created at OTP verification (registration) or magic-link verification (login).
- 24-hour absolute expiry. No sliding renewal — if the developer wants longer-lived persistence, they re-login.
- Server-side row in `developer_sessions`; cookie holds an opaque token; cookie is `httpOnly`, `Secure`, `SameSite=Lax`.
- Step-up sets `mfa_verified_at`; 15-minute window from that timestamp; any sensitive operation outside the window prompts again.
- Operator can revoke any session by deleting the row.

### 5.4 MFA implementation

- TOTP via [`otplib`](https://www.npmjs.com/package/otplib) or equivalent. Industry-standard RFC 6238.
- Shared secret stored encrypted-at-rest using the same `WEBHOOK_ENCRYPTION_KEY` machinery already in place.
- Backup codes: 10 single-use codes, generated at enrollment, displayed once, stored as SHA-256 hashes. Consuming a backup code marks it used and prompts the developer to re-enroll.
- Recovery (lost device, used all backup codes): developer emails `hi@neighborhood-commons.org`. Operator verifies identity out-of-band (video call, or comparing against `application_metadata.what_youre_building`, etc.) and resets MFA via an admin endpoint.

### 5.5 Things we deliberately do not do

- **Passwords.** Not stored, not requested. Magic-link login is sufficient.
- **SMS MFA.** TOTP only. SMS is a known weak link (SIM swap attacks) and has per-message costs.
- **WebAuthn/passkeys.** Defer to a future iteration. TOTP is enough for v1; WebAuthn is strictly stronger but adds implementation complexity and browser-support edge cases.
- **"Remember this device" tokens.** Every elevated operation requires TOTP. Convenience would weaken the model; we'd rather have the friction.

## 6. The dashboard

Server-rendered HTML routes from the existing Express backend (same pattern as `routes/pages.ts`). Lives under `/developers/*` on the apex.

### 6.1 Routes

| Path | Purpose |
|------|---------|
| `GET /developers` | Entry point: log in or register CTA |
| `GET /developers/sign-up` | Registration form (renders the consumer-facing profile fields prominently) |
| `POST /developers/sign-up` | Submit form; emails OTP |
| `GET /developers/verify` | OTP code entry |
| `POST /developers/verify` | Submit OTP; create account; establish session; redirect |
| `GET /developers/login` | Magic-link request form |
| `POST /developers/login` | Send magic link |
| `GET /developers/login/verify` | Consume magic-link token; establish session; redirect |
| `GET /developers/dashboard` | Status, key (truncated), profile preview |
| `GET /developers/profile` | Edit profile (MFA-gated for writes post-activation) |
| `POST /developers/profile` | Save edits |
| `POST /developers/profile/logo` | Upload logo (Sharp pipeline) |
| `GET /developers/security` | MFA status, key rotation, session list |
| `POST /developers/security/enroll-mfa` | Enroll TOTP |
| `POST /developers/security/rotate-key` | Issue a new key, mark old as revoked |
| `GET /developers/docs` | Curated links: spec, getting-started, CHANGELOG, status page |

Plus operator-side:

| Path | Purpose |
|------|---------|
| `GET /operator/applications` | Pending applications list (admin-keyed) |
| `GET /operator/applications/:id` | Single application detail |
| `POST /operator/applications/:id/activate` | Activate (calls existing `/v1/service/api-keys/{id}/activate` internally) |
| `POST /operator/applications/:id/request-revisions` | Send a revision note |

### 6.2 Visual / UX principles

- **All business, no marketing.** No hero copy, no graphics. Forms, tables, status indicators. Looks like Stripe's old dashboard, GitHub's settings pages, or a bank.
- **Server-rendered.** No client framework. Forms POST; pages re-render. Minimal JavaScript — only for the QR code rendering and copy-to-clipboard on the key value.
- **Inherits `pages.css`.** Reuses the existing typography and color tokens from event/venue pages. No new design system.
- **Mobile-friendly.** Forms work on a phone. The dashboard is readable on a phone. Logo upload supports the mobile camera.
- **Accessible.** Semantic HTML, label-input pairing, focus indicators, color contrast that passes WCAG AA.

## 7. The contributor-profile read surface

### 7.1 New public endpoints

```
GET  /v1/contributors                     — paginated list of active contributors
GET  /v1/contributors/:slug               — single contributor profile
```

Response shape for `/v1/contributors/:slug`:

```json
{
  "contributor": {
    "slug": "merrie",
    "name": "Merrie",
    "tagline": "Publish your community group's events without a website.",
    "description": "Merrie is a tool for community group organizers in Philadelphia...",
    "who_its_for": "Group organizers, neighborhood association leaders...",
    "url": "https://merrie.co",
    "logo_url": "https://r2.../merrie/logo.png",
    "category": "community-publishing",
    "stats": {
      "events_contributed": 247,
      "organizations_published": 31,
      "active_since": "2026-05-17"
    },
    "active_since": "2026-05-17T..."
  }
}
```

### 7.2 Event responses gain contributor slug

`source.contributor` on events grows a `slug` field so reader apps can resolve to the profile:

```json
"source": {
  "publisher": "Knitters of Philadelphia",
  "contributor": {
    "slug": "merrie",
    "name": "Merrie",
    "url": "https://merrie.co"
  },
  "method": "api",
  "license": "CC BY 4.0"
}
```

The denormalized `name` and `url` are kept so reader apps can render a minimal attribution string without the profile lookup. The full profile is for the "tap to learn more" expansion.

### 7.3 Caching

- Profile endpoints set `Cache-Control: public, max-age=3600` (1 hour). Profile edits propagate within an hour.
- Stats are computed at read time; they're approximate (counts may lag a few minutes vs. the actual events table).

## 8. Handler changes — concrete diff

| Surface | Today | After |
|---------|-------|-------|
| `/v1/service/register/send-otp` | Generates OTP | Replaced by `POST /v1/developers/register` (server-side form-driven); keeps the OTP step internally |
| `/v1/service/register/verify-otp` | Validates OTP, issues pending key | Replaced by `POST /v1/developers/register/verify`. New atomic provisioning includes profile creation, tenant binding, brand_config from metadata |
| `/v1/service/api-keys/{id}/activate` | Flips activated_at; optional provision_account/brand_config/verification_authority/rate_limit_per_hour | Flips activated_at; sets profile status=active; sends activation email. Optional verification_authority/rate_limit overrides only |
| `/v1/service/accounts/link` | Find-or-create tenant; doesn't set tenant_account_id | Demoted to operator-only legacy retrofit path. **Will** set tenant_account_id when binding (the Merrie-shape retrofit case) |
| `/v1/service/api-keys` POST | Direct admin issuance | Unchanged — operator escape hatch for special cases (admin keys etc.). `account_id` parameter removed from the body |
| **NEW** `GET /v1/contributors` | — | Paginated list |
| **NEW** `GET /v1/contributors/:slug` | — | Single profile |

Plus the developer dashboard surface (§6.1) and operator surface (§6.1) are entirely new.

## 9. Decisions made

Each is a concrete commit; collected here for reviewability.

1. **App-slug derivation:** auto-slugify on server from `app_name`. Collisions append a counter.
2. **`brand_config.from_email` at registration:** capture nothing for now; default null; can be set later via the profile editor (when domain verification work is done — separate effort).
3. **Self-service profile editing:** in scope for this redesign (the dashboard `/developers/profile` page).
4. **Pending-key auto-revoke:** no; rows persist.
5. **Multiple registrations from same email:** allow; operator dedupes at review.
6. **`/accounts/link` setting `tenant_account_id`:** yes, when binding a key that doesn't have one.
7. **Activation email:** yes, send it. Includes MFA enrollment link.
8. **Dashboard URL space:** apex `/developers/*`, not a subdomain.
9. **Session token strategy:** DB-backed (revocable), not JWT.
10. **MFA recovery:** TOTP + 10 backup codes + operator-mediated recovery as fallback.
11. **Operator profile access at review:** read-only preview + "request revisions" with note. Operator does not edit developer copy.
12. **MFA enrollment timing:** required at activation (not at registration). Pre-activation edits don't require MFA because operator hasn't approved anything yet.
13. **MFA step-up window:** 15 minutes after a successful TOTP challenge.
14. **Session lifetime:** 24 hours, hard expiry, no sliding renewal.

## 10. Migration story

### 10.1 Existing consumers (Merrie, Fiber, Holler, Studio)

The bulk of the retrofit moves to PR 5. No per-consumer scripts, no SQL backfills run by hand between v2 close and PR 5 — with one specific exception covered in §10.1.1 below. The script in `feat/trusted-tenant` (`provision-merrie-tenant.ts`) is *not* run; it stays in the codebase only until PR 5 lands, then deletes.

This is a deliberate trade. The cost is that Merrie's photo uploads stay blocked from v2 close until PR 5 ships (~1 week of focused build time). The benefits:

- **Merrie's first interaction with the new system *is* the new system.** No transitional state, no script-then-dashboard handoff. They log into the dashboard, retrofit through it, and that's their permanent management surface.
- **The retrofit path is tested against the consumer that most needs it.** If it works for Merrie, it works for the rest.
- **One throwaway script avoided.** Per-consumer migration scripts proliferate hodgepodge.

For each consumer, the PR 5 one-shot does three things atomically:

1. **Provision a `contributor_profiles` row.** Slug from app name, name + url from already-known data. Description/tagline/logo stay null until the developer logs in and fills them.
2. **Link the existing api_key.** Sets `api_keys.contributor_profile_id` and (for tenant-umbrella consumers) `api_keys.tenant_account_id`, with a tenant `portal_account` provisioned the same way registration provisions one for a fresh consumer.
3. **Backfill data that the existing key had no way to write before:** existing organizations' `owner_account_id` (for the photo gate), existing events' `source_contributor_name` for v2-service events (so historical attribution shows up — depends on (2), so co-located here).

Per consumer:

| Consumer | Profile setup | Tenant binding | Data backfill |
|----------|---------------|----------------|---------------|
| Merrie | Slug `merrie`, name "Merrie", url merrie.co. Description placeholder; developer fills via dashboard. | Yes: create tenant `portal_account`, bind `tenant_account_id`. | Existing Merrie-created orgs get `owner_account_id` set. Existing Merrie-attributed events get `source_contributor_name='Merrie'`. |
| Go There by Bike | Slug `go-there`, name "Go There by Bike". | Yes (same shape as Merrie if they publish for ride hosts). | Same pattern as Merrie if applicable. |
| Holler | Slug `holler`, name "Holler". | No (verification consumer, not tenant umbrella). | No org-ownership backfill needed; contributor name backfill same pattern. |
| Studio | Slug `studio`, name "Studio". | No (admin key, bypasses scoping). | No backfill needed (admin actions are operationally attributed elsewhere). |

### 10.1.1 What runs at v2 close

Two operator actions complete the substrate before the dashboard work begins. Everything else waits for PR 5.

**Apply migration 084** (`api_keys.tenant_account_id`). Idempotent and additive. No data writes; makes the column available for PR 5 to populate.

**Apply migration 085** (the 3.0 substrate cleanup — four-role event provenance, type-general method field on organizations/broadcasts/lists). Idempotent. Normalizes legacy `source_method` values, drops `events.source_publisher`, adds `method` to organizations/broadcasts/lists. See [`docs/four-roles.md`](four-roles.md) and [`docs/provenance.md`](provenance.md) for the doctrine.

### 10.1.2 What we deliberately don't run

**No legacy-contribute contributor backfill.** An earlier draft of this doc included a one-shot UPDATE intended to restore `source.contributor` on events created via the retired `/api/v1/contribute` path:

```sql
-- DO NOT RUN
UPDATE events
   SET source_contributor_name = source_publisher
 WHERE source_contributor_name IS NULL
   AND source_method = 'api'
   AND source_feed_url LIKE 'api-key:%';
```

The premise — that `source_publisher` always held the app name for legacy-contribute events — is false. The legacy `/api/v1/contribute` API accepted `source_publisher` as an arbitrary string and stored it heterogeneously: for some consumers it was the app name (Merrie-shaped), for others it was the publisher's actual real-world name (e.g. events tagged PorchFest-2026 stored `source_publisher='PorchFest Philadelphia'`).

Running the backfill produces structurally wrong attribution for the second class — publisher and contributor end up identical, yielding nonsensical attribution like *"PorchFest Philadelphia, via PorchFest Philadelphia"*. Consumer apps with defensive UI correctly hide such events.

This was one of the load-bearing reasons for the 3.0 substrate cleanup (migration 085) — the `source_publisher` column is now retired, the field is no longer surfaced via the public API, and `organizer.name` fills the role cleanly. The v2-service-events backfill folded into PR 5 stays as written (it operates on rows where the organizer name is verifiably the right value).

### 10.2 Existing key holders log in and edit

After the retrofit, each consumer's key still works as before. The new addition: they can log into `neighborhood-commons.org/developers` (magic link to their registered email) and edit their profile. First login they'll need to enroll MFA before any edits go through.

For Merrie/Go There/Holler specifically, this is the dogfood arc: log in, polish description, upload logo, save. Then visit Fiber to see the rendered profile in a "via Merrie" splash.

### 10.3 Endpoints and scripts

- Old `/service/register/send-otp` + `/verify-otp` removed from the spec; the dashboard `/developers/register*` surface replaces them. (Internally they may share the same backend handlers — the dashboard routes call into the same OTP machinery.)
- `provision-merrie-tenant.ts` runs one final time for the retrofit, then is deleted.
- `/v1/service/accounts/link` kept in the codebase as the retrofit endpoint for legacy keys, but removed from developer-facing docs.

## 11. The three test cases

Three real consumers to validate against before declaring the redesign done:

1. **Merrie** — tenant-umbrella shape, existing key, retrofit path. Validates: contributor profile creation, tenant binding via existing key, dashboard login, profile editing with MFA, photo gate satisfied for new orgs, Fiber renders "via Merrie" splash.
2. **Go There by Bike** — similar tenant-umbrella shape (publishes events on behalf of ride organizers), existing or near-existing key. Validates: the same path doesn't have Merrie-specific edge cases baked in.
3. **Holler** — verification-focused, existing key with `verification_authority`. Validates: non-tenant consumers also get a clean profile experience; existing `verification_authority` doesn't conflict with anything new.

For each, the end-state we want: the consumer logs in, edits their profile, sees it live on `/v1/contributors/:slug`, sees it surfaced as a tap-through splash in Fiber.

## 12. Implementation order

Five increments, each shippable independently. Each gets its own branch + PR + review.

### PR 1: Schema + read surface (server-side foundations)
- Migration 085: `contributor_profiles`, `developer_sessions`, `magic_login_tokens`, `pending_registrations` tables. New columns on `api_keys`.
- Public read endpoints `/v1/contributors` and `/v1/contributors/:slug`.
- Event responses include `source.contributor.slug`.
- Integration test for the read path.

**Ship target:** ~half day.

### PR 2: Registration via dashboard (replaces curl)
- `/developers/sign-up` form + handler. Replaces `/v1/service/register/send-otp` callers.
- `/developers/verify` form + handler. Atomic provisioning: profile + tenant portal_account + tenant_account_id + brand_config.
- `/developers/dashboard` (read-only view of status, key, profile preview).
- Establishes session at verify.
- Integration test for the full registration flow.

**Ship target:** ~1 day.

### PR 3: Magic-link login + profile editing
- `/developers/login` + `/developers/login/verify` magic-link flow.
- `/developers/profile` GET + POST.
- `/developers/profile/logo` upload route (Sharp pipeline).
- No MFA yet — pre-activation edits flow freely.

**Ship target:** ~half day.

### PR 4: MFA + activation flow
- TOTP enrollment endpoint and page (`/developers/security/enroll-mfa`).
- Step-up middleware for profile edits.
- Backup codes.
- Activation email (template + transactional send).
- Operator activation page (`/operator/applications/*`).
- Integration test for the full activation → MFA → first-edit flow.

**Ship target:** ~1 day.

### PR 5: Retrofit existing consumers
- One-shot migration script: provision `contributor_profiles` rows for Merrie, Go There by Bike, Holler, Studio. Link existing api_keys.
- Operator-mediated MFA recovery endpoint.
- Documentation updates: `getting-started.md` referencing the dashboard URL.
- Delete `scripts/provision-merrie-tenant.ts`.

**Ship target:** ~half day.

**Total estimate:** 3.5 focused days of implementation, plus review/iteration time. Realistic calendar: a week.

## 13. Open questions remaining

None blocking. Items to revisit after first production use:

- **Multi-app per developer.** Today one account = one api_key = one profile. If a developer wants to register a second integration under the same email, they currently can't from the dashboard. Future enhancement; not in scope here.
- **Profile review on edit.** Right now edits go live immediately (post-activation). If profile-content spam becomes an issue, we can add a pre-publish moderation queue. Not in scope.
- **Internationalization.** Description/tagline are English-only for now. Future: language tag + multi-language fields.
- **WebAuthn / passkeys.** Defer until TOTP is shipped and stable.
- **API key visibility.** Today we show the raw key once at creation. Should the dashboard ever re-show it? Decision: no — rotation is the recovery path. If a developer loses their key they rotate.

## 14. What "done" looks like

- A new developer can register, build, and ship in one screen of activity per phase. No curl.
- Merrie has a profile they manage themselves.
- Fiber renders "via Merrie" splashes that pull from the public `/v1/contributors/:slug` endpoint.
- All three test consumers (Merrie, Go There, Holler) are successfully retrofitted and using the dashboard for their own profile management.
- The spec describes one canonical onboarding path. Other endpoints exist as documented legacy/edge surfaces.
- The Merrie tenant script and the hodgepodge of overlapping endpoints can be retired from the developer-facing documentation; they remain in the codebase as operator/legacy paths until deprecation-removal in v3.
