# Neighborhood Commons — Development Guide

Open neighborhood public-facts infrastructure. Built on the [Neighborhood API](https://github.com/The-Relational-Technology-Project/neighborhood-api) spec.

This document is the shared backdrop for development. Read it before writing code. It articulates the mission, the principles, and the operational rules that everything in this repo is meant to serve.

## The Mission, Plainly

The Neighborhood Commons is a public store of public facts about neighborhoods. That's the whole job.

Two kinds of public facts. The first kind is **durable** — who is here, what they are, where they are, when they're open. These are facts about the standing reality of a neighborhood: a cafe at the corner of 5th and Christian, called Ultimo, opens at 7. These don't change much week to week, but when they do, getting them right matters.

The second kind is **transactional** — what's happening, what's offered, what's being said. These are facts about the moving life of a neighborhood: a chess tournament Tuesday, a handyman taking work in the area, a poetry reading Saturday. Dense, fast-moving, episodic. They proliferate and expire.

Both kinds are public facts. Both belong here. They differ in the rigor required to publish them and the longevity they enjoy, but they share a license, a substrate, and a discipline of attribution.

The Commons doesn't gatekeep what gets published, doesn't rank what's there, doesn't decide what to surface. It holds the data, holds the publishers, holds the attribution, holds the license. Everything else — surfacing, curation, discovery, design — happens in the consumer apps and publications that participate.

## Type A vs Type B Public Facts

This is the load-bearing distinction. Every schema decision, every API decision, every authorization decision tests against it.

**Type A — Durable profile data, first-party only.**
What an entity *is*. Name, address, hours, contact, logo, description, accessibility. The way the entity presents itself to the world. Type A data is asserted only by the verified first party. Until verification, the Commons may hold claimed/seeded data (from ingestion pipelines, scrapes, suggestions) but flags it as unverified. Consumers can tell at a glance whether it's authoritative. Errors in Type A persist indefinitely as infrastructure misinformation — high stakes.

**Type B — Transactional/episodic data, first-party-rooted but inherently publishable.**
What an entity *does*. Events, broadcasts, classifieds, list memberships. Publisher must have structural authority over their specific contribution, but "authority" admits three valid shapes (see below). Errors in Type B are bounded — the event passes, the offer expires.

Verification machinery scopes narrowly to Type A. That's what makes it load-bearing rather than optional or overengineered.

## No Users in the Commons

The Commons holds zero user accounts, zero PII, zero personal-identity records. Apps that have users own their users.

When Alice signs up for Merrie to start her chess club, her email and name are between Alice and Merrie. They never enter the Commons. The Commons knows the chess club exists; it does not know Alice exists.

A username or handle is the same kind of thing as an email — an identifier for a person, not a public fact about the neighborhood. A user does not become a Commons entity by signing up, and not even by publishing: their content enters under the app's **collective organization** (a community identity like "Fiber Community" or "Go There By Bike Community"), and the person stays with the app. The only way a human appears in the Commons is as a **public persona they deliberately present** — a performing name, a named crew, a business — which is an organization, not a user (see [Organizations — the unified entity](#organizations--the-unified-entity)). Letting an app mint an entity per user account — surfacing handles as if they were venues or organizations — is the failure mode this rule exists to prevent.

This is non-negotiable. It dissolves whole categories of problems — PII handling, GDPR exposure, cross-app identity portability, the temptation to build social-graph features — by simply not taking on the responsibility.

Operational tables that hold email (currently `portal_accounts`) exist for service-key tenant claims and legacy OTP-claimed accounts. They are never surfaced via public API.

### Trusted-tenant pattern

A service consumer optionally provisions one `portal_account` (a "tenant" — a single shared operational shell for the consumer, not a per-publisher account) and binds it to its API key via `api_keys.tenant_account_id`. When the key creates Organizations via `POST /service/organizations`, the new org's `owner_account_id` is derived from the bound tenant. The org has a claimed owner; the photo-eligibility gate is satisfied; no per-publisher Commons account is required.

Required for photo uploads (a contributor-warranty boundary — someone has to be on the hook for the rights claim). Optional otherwise; orgs without an owner_account_id still work for everything that doesn't carry image bytes.

Used by publication-tool consumers (Merrie, future similar shapes) where individual publishers don't have Commons accounts. Provision once at integration time; document the tenant UUID in the consumer's env (`COMMONS_PORTAL_ACCOUNT_ID`); the binding is server-side from then on.

## Constrained Publishing — Three Authority Paths

Publishers contribute from a position of authority over what they publish. The wild-west "anyone publishes anything" model is explicitly rejected. Three valid authority shapes:

1. **Entity-runs-it.** A verified organization publishing about itself. JB posting JB's shows. Carlotta's Hair publishing its hours. Alice's chess club publishing chess club events.
2. **Pipeline-proxies-an-authoritative-source.** Studio scrapes JB's website calendar; events arrive attributed to the website as source. The pipeline is a faithful proxy for a known source; attribution is honest.
3. **Witnessed-with-evidence.** A Fiber user OCRs a public flyer; the event enters attributed to "Fiber Community" (a collective identity, never the individual), with the photo as evidence. The publisher is collective; the evidence is documentary.

What's explicitly excluded:
- Curator-as-publisher (Bob can't post events he didn't run or witness; his picks live in his Substack and get ingested via a feed if he exposes one).
- List-maker role in user-facing apps (lists are editorial overlays referencing existing primitives, never a license to invent).

The constrained model means most events come from one authoritative publisher; conflict cases are rare exceptions handled by match-key clustering plus the authority hierarchy.

Schema enforcement: `events.organizer_org_id` is required. The calling service key must be linked to that organization via `api_key_organization_links` (entity-runs-it; `source_method='self_asserted'`), OR the source_method is `'witnessed'` and the calling key has `witness_authority=true` (witnessed-with-evidence), OR the source_method is `'proxied'` from an authorized ingestion key (pipeline-proxies). See [`docs/four-roles.md`](docs/four-roles.md) and [`docs/provenance.md`](docs/provenance.md) for the full doctrine.

## The Five Primitives

The substrate is five typed atoms. Each maps (mostly) to a Schema.org concept. Every response is self-contained — no implicit knowledge, no extra joins to interpret a record.

| Type | Schema.org | What it represents |
|---|---|---|
| `Place` | Place | Physical location — a venue, a park, an address. |
| `Organization` | Organization | The unified entity primitive. Businesses, community groups, nonprofits, collectives, solo operators, app-affiliated collectives. **Persons are not a separate primitive.** A touring DJ is an organization-of-one. |
| `Event` | Event | Activity at a specific time, organized by an Organization, at a Place. |
| `Broadcast` | (novel) | Ephemeral signal from an Organization, pinned to a Place, max 24h lifetime. |
| `List` | ItemList | Editorial overlay — sequence of references to existing events, organizations, or places. Lists do not create primitives. |

Future primitives expected: `Classified` (paid public offers, see Sustainability below). Other Schema.org-aligned public-fact types as demand emerges.

### Organizations — the unified entity

Everything that publishes or organizes is an organization, regardless of how many humans operate it. Alice's chess club is an organization-of-twenty-five. DJ Karma is an organization-of-one. Johnny Brenda's is an organization-of-a-staff. From the Commons' perspective they are structurally identical: named, slugged, public entities that do things.

**An organization-of-one is a public persona, not a user.** This distinction is load-bearing. DJ Karma, Philly Bike Train, a handyman who advertises as "Joe's Handyman" — public-facing identities that stand on their own — are legitimately organizations-of-one. But a person who simply signs up for an app and posts something is *not* an entity; a username is identity, not a public fact (see [No Users in the Commons](#no-users-in-the-commons)). The test: **would the identity still make sense if the person walked away?** "DJ Karma," yes; "korin," a handle on a bike app, no. A private user's content enters the Commons under a community/collective organization — never under the person's handle — and presenting as a public persona is something the user opts into at publish time, not a byproduct of having an account.

No `kind` discriminator. Earlier versions had `kind` as an enum (local_business, community_group, curator, etc.) but those values mixed structural facts with vibes with legal status and forced false choices that narrowed reach. Replaced with:

- **`commercial`** (boolean, nullable) — the one binary that actually matters at the Commons level.
- **`tags`** (text[]) — free-form descriptive labels, optional, low-stakes, not load-bearing for filtering.

Consumer apps derive classification from structural signals already present:
- The org's place (Google Place ID + OSM categories — see Place Categorization below).
- The events the org has published over time (a music venue is whatever posts mostly live-music events).
- Tags, when the publisher has added them.
- Text search on name and description.

This pushes classification work to consumer apps where editorial judgment belongs. The Commons does not opine on org typology.

### Place Categorization — OSM-first

Place categorization comes from OpenStreetMap, stored in `places.place_categories` (text[]). OSM is licensed under ODbL — open data, indefinite storage permitted, attribution required (acknowledged in our public materials).

Google's Places API can be consulted at runtime (e.g., for admin reference during venue review in Studio), but Google's response data is **never persisted**. Google's terms permit indefinite storage of `place_id` only; other Content is restricted. The cleanest discipline: store `google_place_id` as the stable real-world identifier (and the join key across sources), use OSM for category data, never cache Google's other fields.

`category_source` on places records provenance (`'osm'`, `'admin_review'`, `'publisher_declaration'`). The contribute-back-to-OSM workflow, when built in Studio, will only act on `admin_review` and `publisher_declaration` rows.

## Verification — Narrow Scope

Verification has one job: anchor Type A authority. Confirm that an organization claiming to be a real-world entity actually corresponds to it. That's the entirety of the load.

What verification does NOT do (deliberately walked back from earlier framing):
- Not a cross-app reputation graph. "Verified by N apps" is not a meaningful signal the Commons computes or exposes.
- Not an identifier portability mechanism. The Commons does not maintain portable verification credentials across apps.
- Not a network-effect prize. The anti-extraction work is done by CC-BY plus many readers (the multiplicative thesis), not by verification machinery.

Methods evolve to admit different evidence:
- `domain_email_loop` — email loop to the entity's public contact (default for businesses with public-facing contact info).
- `manual_review` — for entities without clean email-loop access (community groups like neighborhood associations); evidence reviewed by an operator.
- `stewardship_attestation` — community body vouches for entities within its scope; future addition as the pattern emerges.

App-native organizations (Alice's chess club, Edith's composting collective) don't verify — they're intrinsically authoritative because they're constituted by their creator's act of declaring them. Verification only applies to real-world entities with external referents.

The verification record names: the organization, the service key that attested (and thus the app), the method, the timestamp. Stored in `organization_verifications`. The identifier value (email) is held operationally for re-verification, never publicly exposed.

## The Classifieds Sustainability Story

One long-term sustainability mechanism is classifieds. See `docs/classifieds.md` for the design.

Brief summary: structured public offers (jobs, housing, services, lost-and-found, for-sale) from organizations, paid distribution through participating local publications. Publications set their own per-ad rates and accepted categories. Targeting is by app/publication affinity (a self-declared audience signal), never by individual user. Revenue flows from advertiser through the Commons to the participating publication, with the Commons taking a small infrastructure cut.

Not built in this release. Designed and documented now so the option exists when conditions warrant building it.

## Funding and direction

The Commons isn't primarily a grant-funded project; it's a substrate for sustainable businesses (apps, publications, tools) built on top of shared neighborhood public-fact infrastructure. Direction is responsive to early participants — currently Fiber, Merrie, Holler, and Studio (all operator-owned). If new developers, entrepreneurs, or foundations get involved with different needs, the Commons evolves in those directions.

Several funding pathways are valid:
- **Classifieds revenue** (designed in `docs/classifieds.md`) — anti-monopolistic two-sided market that routes revenue to local media; the long-term self-sustaining path once at scale.
- **Grant funding** — civic infrastructure is grant-eligible; appropriate for security audits, expansion work, specific functional additions. Not the primary identity but a valid path.
- **Foundation partnerships** — e.g., a journalism-affiliated foundation could shape the Commons toward press-aligned features; a civic-tech foundation toward government-data integration.
- **Participant cost-sharing** — multiple apps/publications drawing on the substrate could cooperatively fund operations.

The Commons doesn't have to win one funding pathway to succeed. It needs to be useful enough to participants that some combination of these emerges.

## Two Audiences, One System

This project serves two audiences simultaneously. Every decision must hold up for both.

**The API serves developers and entrepreneurs.** They're building event apps, community dashboards, civic tools, newsletters. They need structured, predictable, complete data atoms. Every event must be self-sufficient — carrying its full story without implicit knowledge or undocumented carry-forward. Rigidity here is a feature.

**The homepage serves first-time visitors and grant readers.** Someone arriving cold needs to understand what this is, why it exists, and how to participate — in under a minute. The homepage at `/` is a single-page document that does this work. The spec viewer at `/spec` is the developer-friendly view of every endpoint. Both surfaces should be honest about state (what's live vs. bootstrapping).

When goals conflict, resolve in favor of the data. The homepage can present rigid data more gently. But if the data is sloppy to make the page easier, every downstream consumer inherits the mess.

## The Neighborhood API Spec

This project implements and extends the [Neighborhood API](https://github.com/The-Relational-Technology-Project/neighborhood-api) — an open spec stewarded by the [Relational Technology Project](https://relationaltechproject.org). The spec is connective tissue; we're one implementation.

**Faithfully implement the spec.** Where the spec defines a behavior, follow it exactly. Where the spec is silent, we may extend — but extensions must not contradict or conflict with spec-defined behavior.

### Event Schema Alignment

The public API (`/api/v1/events`) must return events conforming to the Neighborhood API event schema. Internal database columns may use different names; the response layer transforms.

| Spec Field | Our DB Column | Notes |
|------------|---------------|-------|
| `id` | `id` (UUID) | Spec allows slugs or UUIDs. |
| `name` | `content` | Spec says `name`, not `title`. |
| `start` | `event_at` | ISO 8601 with DST-aware offset. |
| `end` | `end_time` | Same format as start. |
| `timezone` | `event_timezone` | IANA name; authoritative for DST. |
| `description` | `description` | Direct. |
| `category` | `category` | Spec uses array; we wrap on output. |
| `place_id` | `place_id` | Google Place ID, stored as text. |
| `location` | flat columns | Nested `{name, address, lat, lng}` on output. |
| `url` | `link_url` | |
| `images` | `event_image_url` | Wrap as array on output. |
| `organizer` | derived from organizer_org_id | Always an organization reference. |
| `cost` | `price` | |
| `source` | constructed | `{method, url, contributor, collected_at, license}` — four-role frame; `organizer.name` carries the "who is this from?" role |

### Required Endpoints

| Endpoint | Status |
|----------|--------|
| `GET /meta` | Implemented |
| `GET /events` | Implemented |
| `GET /events/{id}` | Implemented |
| `GET /events.ics` | Implemented |
| `GET /events.rss` | Implemented |
| `GET /organizations` | Implemented |
| `GET /organizations/{idOrSlug}` | Implemented |
| `GET /places` | Implemented |
| `GET /broadcasts` | Implemented |
| `GET /lists` | Implemented |
| `GET /publishers` | Implemented (v2) — replaces `/accounts` |

### What We Don't Do

- Don't fork the spec. If the spec says `name`, we use `name`.
- Don't anticipate unspecified schemas. Assets/dreams/plans/notices don't have full schemas yet; we don't invent.
- Don't lock in. Extensions documented well enough that other implementations could adopt them.

## Architecture

### Request Flow

Every request follows the same path. No exceptions.

```
Request → Security headers → CORS → Rate limit → Auth (if required) → Validate input → Execute → Format response → Error handler
```

No middleware that conditionally applies based on runtime state. The stack is static and deterministic.

### Database Access

- `supabaseAdmin` (service role) for system operations — cron jobs, webhook delivery, admin routes, service API.
- Never construct raw SQL. Every query through PostgREST. If PostgREST can't express it, write an RPC function in a migration.
- Every RPC: `SECURITY DEFINER`, `SET search_path = public, extensions`, and `REVOKE EXECUTE FROM PUBLIC, authenticated, anon` unless explicitly public.

### Row Level Security

Every table has RLS enabled. Defense-in-depth.

- Public-fact tables (`places`, `organizations`, `events`, `broadcasts`, `lists`): public read policy, service-role write.
- Operational tables (`portal_accounts`, `api_keys`, `webhook_*`, `audit_logs`): RLS enabled, no public policies — default-deny.
- Verification tables (`organization_verifications`, `verification_challenges`, `verification_pending_reviews`): service-only.

**Never disable RLS on any table.** If a table is server-only, enable RLS with no policies — that's the safest configuration.

### Route Files

Each route file is self-contained: schemas at top, constants, helpers, then route handlers, then export. No cross-route imports. Shared logic lives in `lib/`.

Route handler pattern:

```typescript
router.post('/resource', authMiddleware, rateLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(schema, req.body);
    // business logic
    res.status(201).json({ resource: result });
  } catch (err) {
    next(err);
  }
});
```

No variations. No inline validation. No `res.status(400).json()` scattered through handlers — use `throw createError(message, status, code)`.

### Error Responses

One shape. Always.

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Human-readable explanation" } }
```

Status codes mean what HTTP says:
- `400` — malformed request
- `401` — not authenticated
- `403` — authenticated but not authorized
- `404` — doesn't exist (or can't see it — don't leak existence)
- `409` — conflicts with existing state
- `429` — slow down
- `500` — our fault (never expose internals)

### Adding Features

Before adding anything, answer:

1. **Does it serve the public-facts mission?** If it's about individual users, social features, or personalization, it doesn't belong here.
2. **What's the security surface?** Every endpoint is an attack surface. Every stored field is a data liability.
3. **Can you delete it later?** If removing it would break consumers, think harder. Public APIs are forever.
4. **What's the simplest version?** Build that. Ship. See if anyone needs more.

## Service API

The Service API (`/api/v1/service/*`) provides CRUD access for trusted external tools. Service-tier keys represent platform-operator-equivalent authority.

### How Keys Are Issued

Service keys ship in `pending` status via the OTP flow at `/v1/service/register/*`. Pending keys can read everything at the service-tier rate limit but cannot write. Activation flips a column; no rotation required. Admin keys (`is_admin=true`) bypass scoping; currently used by Studio.

### Scoping

Service keys are scoped to organizations via `api_key_organization_links`. Writes against any organization not linked return `403 NOT_LINKED`. Witnessed-evidence writes require `witness_authority=true` on the key (rare, granted at activation for specific use cases like Fiber's OCR pipeline).

### Endpoints

- Typed resources: `Place`, `Organization`, `Broadcast`, `List` — full CRUD per Schema.org-aligned shape.
- Events: full CRUD with required `organizer_org_id` and key-org link enforcement.
- Images: upload via the magic-byte + Sharp re-encode pipeline.
- Verifications: issue identifier challenges, submit manual reviews, query routing path.
- Self-service registration: apps register service-tier keys at `/v1/service/register/*`; activate via one-time review.

### Design Principles

- Uses `supabaseAdmin`; bypasses RLS by design.
- Validation schemas and transform logic in shared helpers (`lib/event-operations.ts`, etc.).
- External tools should not need to know Supabase internals. The Service API is a clean REST interface.

## Security Rules

### Non-Negotiable

- **All input validated with Zod before use.** No `req.body.whatever` without a schema. Use `validateRequest(schema, data)`.
- **All route params validated.** Use `validateUuidParam(value, name)` for UUIDs.
- **All image uploads re-encoded through Sharp.** Magic byte check first, then Sharp re-encode. Strips metadata, kills polyglot payloads.
- **No secrets in logs.** Tokens truncated, emails masked, IPs hashed, user IDs hashed via `hashId()`.
- **No secrets in error responses.** Error handler strips stack traces and replaces 5xx messages with generic text.
- **Webhook URLs validated for SSRF.** DNS resolution + RFC 1918 block + cloud metadata block.
- **Timing-safe comparisons for secrets.** Use `crypto.timingSafeEqual` for service keys, cron secrets, HMAC verification.

### Authentication

Two auth models:

| Model | Middleware | Use Case |
|-------|-----------|----------|
| Developer-tier API Key | `requireApiKey` | Reads with dedicated rate limit; webhook subscriptions. |
| Service-tier API Key | `requireServiceApiKey` | Full write access via scoped Service API. |

Don't add a third auth model. If a feature doesn't fit, reconsider the feature.

### Rate Limiting

Every route has an explicit rate limit:

| Tier | Limit | Use |
|------|-------|-----|
| `browseLimiter` | 30/min | Public data reads |
| `writeLimiter` | 10/min | State-changing operations |
| `serviceLimiter` | 300/min per key | Authenticated service-tier writes |
| `enumerationLimiter` | 5/min | Lists, stats, anything revealing cardinality |

### Privacy

- **No individual user tracking on public endpoints.** Browse counters use IP hashes with 24-hour TTL. After cleanup, zero record that any individual viewed any event.
- **Audit logs hash actor identities.** `hashId(userId)` produces a one-way hash.
- **Location data is transient.** Latitude/longitude in requests is used for distance calculation and discarded.

## Code Quality

### Naming

- Files: `kebab-case.ts`
- Functions: `camelCase`, verb-first (`validateRequest`, `dispatchWebhooks`)
- Constants: `UPPER_SNAKE_CASE` for true constants
- Types: `PascalCase`
- Log prefixes: `[UPPERCASE]` matching domain (`[ADMIN]`, `[WEBHOOKS]`, `[CRON]`)

### Comments

Write comments for:
- **Why**, never **what**. If the code needs a "what" comment, the code is unclear.
- **Security decisions.** Why this auth model, why this rate limit, why this validation.
- **Non-obvious constraints.** Database column limits, external API quirks, timezone edge cases.

Don't write comments for:
- Function signatures (TypeScript handles this)
- Import groups
- Anything a competent reader infers in 3 seconds

### Dependencies

Before adding a runtime dependency:

1. Can you do it with Node built-ins? (`crypto`, `http`, `url`, `fs`)
2. Can you do it in 50 lines in a lib file?
3. Is the dependency well-maintained, small, auditable?

Don't add: ORMs, logging frameworks, DI containers, utility libraries, anything that adds abstractions we don't need.

## Testing

**Tests are not optional. They expand alongside every change.**

Other apps (currently all the operator's) depend on this data. A silent column mismatch means bad data flowing everywhere. Tests are the only thing standing between a code change and corrupted data downstream.

### Run Before Every Push

```
npm run test:run
```

All tests must pass.

### Test Philosophy

Tests should find real bugs. If a test can't fail in a way that matters, delete it.

The suite is designed around: **what would silently break the experience of people discovering and attending neighborhood events?** Bad data in API response. Broken transform that drops the venue address. Column rename that nulls every event description. Auth change that locks businesses out.

### What We Test

| Test File | What It Catches |
|-----------|----------------|
| `schema-alignment.test.ts` | Column name mismatches. Supabase silently returns null for nonexistent columns; this test turns silent data loss into loud failures. **Update the `SCHEMA` constant when migrations change columns.** |
| `event-transform.test.ts` | Neighborhood API spec violations in public responses. |
| `api-integration.test.ts` | End-to-end Express tests through the real middleware stack. |
| `url-validation.test.ts` | SSRF protection. |
| `image-validation.test.ts` | Image upload security (magic bytes, Sharp re-encoding). |
| `webhook-signing.test.ts` | HMAC signing, secret encryption. |
| `validation.test.ts` | Input validation failures. |
| `security.test.ts` | Security regressions. |

### When Adding Code

- **New route or query?** The schema alignment test picks up new column references automatically.
- **New migration?** Update the `SCHEMA` constant in `schema-alignment.test.ts` first.
- **New public endpoint?** Add integration tests in `api-integration.test.ts`.
- **Changed auth, RLS, rate limits?** Update `public/llms.txt` and `docs/consumer-guide.md` in the same commit.
- **New, changed, or removed endpoint/parameter/field/code/auth requirement?** Update `public/openapi.json` in the same commit.
- **Any user-visible change to the API surface?** Add a one-line entry to `CHANGELOG.md` under today's date.

## The Commons Contract

Three documents form the Commons Contract:

1. **The Spec** — `public/openapi.json` — machine-readable, authoritative. Wins every conflict.
2. **The Guide** — `public/llms.txt` — narrative companion, explains *why* and *how*. Must not contradict the Spec on matters of fact.
3. **The Log** — `CHANGELOG.md` — dated record of every contract-affecting change.

A fourth doc, `docs/consumer-guide.md`, orients new consumers and points at the Spec.

**A PR is not shippable if it:**
- Adds a route that isn't in the Spec
- Changes a Zod schema without updating the matching request/response schema in the Spec
- Adds an error code that isn't in the Spec
- Removes or renames a field without deprecating it in the Spec first
- Changes the contract without adding a dated one-liner to the Log

Log entries are terse, factual, dated. No marketing copy. Breaking changes prefixed `BREAKING:`.

### The SDK and additive-only stability

The Spec is realized as a TypeScript SDK published on npm as `neighborhood-commons` (source in `/sdk`). Generated from `public/openapi.json` via `openapi-typescript`. Republished by CI on tagged releases.

The SDK is intentionally thin: generated types and a minimal `createCommonsClient()` wrapper around `openapi-fetch`. Resist adding convenience helpers, retry logic, caching. The bar for wrapper logic is "consumers genuinely cannot easily do this themselves." Almost nothing meets that bar.

**The Spec is additive-only by intent within a major version.** It grows but doesn't shrink. Breaking changes are bundled into major releases (1.x → 2.x) and measured in years, not months. The deepest value the Commons offers is *time*: certainty that what works today works in 18 months. That promise is more valuable than any individual feature addition.

When you're tempted to "just tweak" the Spec, you're tempted to drift the ecosystem. Don't. Default to "no" on additions, "wait" on breaking changes.

## Migrations

- One file per migration in `migrations/`
- Name format: `NNN_description.sql` (sequential)
- Every migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`)
- Every SECURITY DEFINER function sets `search_path = public, extensions`
- Never modify an existing migration. Create a new one.
- Test migrations against a fresh Supabase instance before merging.

## Environment Setup

Required (see `src/config.ts` for Zod validation):

```bash
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
AUDIT_SALT=                       # min 16 chars
```

Optional:

```bash
NODE_ENV=                         # 'development' | 'test' | 'production'
RESEND_API_KEY=                   # transactional email
RESEND_FROM_DOMAIN=
COMMONS_R2_*=                     # Cloudflare R2 for image hosting
CRON_SECRET=                      # min 16 chars
DEFAULT_REGION_ID=                # UUID of default region
IP_FILTER_ENABLED=true            # block datacenter IPs on public endpoints
SSRF_STRICT=0                     # '1' = SSRF-hardened outbound fetches
WEBHOOK_ENCRYPTION_KEY=           # AES-256-GCM key, REQUIRED in production
                                  # Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CORS_ORIGINS=                     # Comma-separated allowed origins
API_BASE_URL=                     # Override auto-detected base URL
```

## What Not To Do

- **Don't add user accounts.** This is a public-facts service. User-specific features belong in the consuming application.
- **Don't add social features.** No likes, comments, follows, feeds. The social layer lives elsewhere.
- **Don't add admin tooling.** Admin features belong in Studio, the operator-facing tool. The Commons is infrastructure, not an application.
- **Don't add ingestion pipelines.** Feed polling, newsletter extraction, LLM classification — all in Studio. The Commons stores and serves; it doesn't collect.
- **Don't add caching layers.** HTTP cache headers are fine. Application-level caching adds complexity we don't need at this scale.
- **Don't add GraphQL.** REST is simple and sufficient.
- **Don't reintroduce `persons`.** A *public persona* (a solo DJ, a named crew) is an organization-of-one; a private user is not an entity at all — they stay in the app, and their content publishes under a collective organization (see No Users in the Commons).
- **Don't reintroduce `kind` discriminator on organizations.** Use tags + commercial + derived signals.
- **Don't reintroduce cross-app verification reputation graph.** Verification anchors Type A authority; that's all.
- **Don't store Google Places API response data.** Only `place_id` is permitted indefinite storage. Other data is OSM-sourced or admin-curated.
- **Don't add a curator-as-publisher role.** Curators contribute via feeds ingested by Studio, attributed via `source.contributor`.
- **Don't over-abstract.** Three similar database queries are better than a query builder. Four similar route handlers are better than a route factory.
- **Don't "improve" working code.** If you're fixing a bug, fix the bug. One concern per change.

## The Discipline

**Every line of code in this repo should be defensible.** Not "it works" defensible — "here's why this is the right approach and here's what we considered and rejected" defensible.

- **Fewer things, done completely.** One auth model per concern, fully implemented. One validation approach, used everywhere. One error shape. Don't add a feature unless you're willing to own its security surface, edge cases, and maintenance burden forever.
- **Public data, private infrastructure.** Public facts are public. Everything else — IP addresses, identifiers, access patterns, business email addresses — is private by default and must be justified to store, log, or transmit.
- **No magic, no tricks.** Every behavior should be traceable from route handler to database query to response. No ORMs, no middleware that silently transforms data, no "smart" defaults that surprise readers.

The hard work is keeping it plain.
