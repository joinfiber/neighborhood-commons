# Neighborhood Commons — Development Guide

Open neighborhood event data infrastructure. Built on the [Neighborhood API](https://github.com/The-Relational-Technology-Project/neighborhood-api) spec.

This document is the shared backdrop for development — whether you're a human contributor, an AI pair programmer, or both. It captures architecture decisions, security rules, and the philosophy behind the project. Read it before writing code.

## What This Is

A digital sandwich board for the neighborhood. Businesses post events — concerts, comedy, markets, community gatherings — and every app in the city can show them. One post, every audience.

The portal is where business owners come to manage their events. It must be instantly understandable: sign up, post your event, done. No jargon, no complexity. If a coffee shop owner can't figure it out in two minutes, we've failed.

The API serves structured public event data to anyone. No accounts required to read. No tracking of individuals. The data is the product.

This is infrastructure, not an application. Treat it accordingly: correctness over features, stability over velocity, simplicity over cleverness.

### Steady-State Work

Week to week, the work here is:
1. **Input fresh event data** — new events from portal users and admin entry
2. **Edit and curate existing data** — keep listings accurate, approve pending submissions
3. **Improve the portal for business users** — this is the primary development surface; make it clearer, faster, more useful for the people posting events

Everything else — API changes, new spec endpoints, infrastructure — is occasional and should be done carefully, because downstream consumers depend on stability.

## The Neighborhood API

This project implements and extends the [Neighborhood API](https://github.com/The-Relational-Technology-Project/neighborhood-api) — an open spec for sharing local events, assets, dreams, plans, and notices across neighborhood tools and communities. The spec is connective tissue, not a platform. We are one implementation of it. The [Relational Technology Project](https://relationaltechproject.org) stewards the spec.

The idea: any neighborhood tool — an event app, a community board, a local newspaper's website, a civic dashboard — can publish and consume from the same open format. No single platform owns the data. Stewards maintain feeds. Tools remix and display. The neighborhood benefits.

### Relationship to the Spec

**Faithfully implement the spec.** Where the spec defines a behavior, follow it exactly. Where the spec is silent, we may extend — but extensions must not contradict or conflict with spec-defined behavior.

The spec currently defines full schemas for Events. Assets, dreams, plans, notices, and groups are named but not yet fully specified. When those schemas are published, we adopt them. Until then, we don't invent our own — we wait, or we contribute upstream.

### Event Schema Alignment

The v1 public API (`/api/v1/events`) **must** return events conforming to the Neighborhood API event schema. Internal database columns may use different names, but the API response layer transforms to spec format:

| Spec Field | Type | Our DB Column | Notes |
|------------|------|---------------|-------|
| `id` | string | `id` (UUID) | Spec uses slugs (`evt_...`); we use UUIDs. Both valid. |
| `name` | string | `content` | Spec calls it `name`, not `title`. Transform on output. |
| `start` | ISO 8601 w/ tz | `event_at` | |
| `end` | ISO 8601 w/ tz | `end_time` | |
| `description` | string | `description` | Direct match. |
| `category` | string[] | `category` | Spec uses array; we store single string. Wrap on output. |
| `place_id` | string | `place_id` | Direct match. |
| `location` | object | flat columns | Spec nests `{ name, address, lat, lng }`. We store flat. Nest on output. |
| `url` | string | `link_url` | |
| `images` | string[] | `event_image_url` | We store one image; spec allows array. Wrap on output. |
| `organizer` | object | portal account | Nest `{ name }` from portal account data. |
| `cost` | string | `price` | Free-text in both. |
| `source` | object | constructed | Build from `source` column + portal account. |

**`source` is required.** Every event response includes provenance:
```json
{
  "source": {
    "publisher": "portal-account-slug-or-name",
    "collected_at": "2025-08-13T09:00:03Z",
    "method": "portal",
    "license": "CC BY 4.0"
  }
}
```

### Required Endpoints

| Endpoint | Status | Route File |
|----------|--------|------------|
| `GET /meta` | Implemented | `routes/meta.ts` |
| `GET /events` | Implemented | `routes/v1.ts` |
| `GET /events/{id}` | Implemented | `routes/v1.ts` |
| `GET /events.ics` | Implemented | `routes/v1.ts` |
| `GET /events.rss` | Implemented | `routes/v1.ts` |
| `GET /assets` | Not yet (spec pending) | — |
| `GET /dreams` | Not yet (spec pending) | — |
| `GET /plans` | Not yet (spec pending) | — |
| `GET /notices` | Not yet (spec pending) | — |
| `GET /groups` | Not yet (spec pending) | — |

### Query Filters

The spec defines these query parameters for collection endpoints:

| Parameter | Purpose |
|-----------|---------|
| `start_after` | Events starting after this datetime |
| `start_before` | Events starting before this datetime |
| `q` | Keyword/text search |
| `category` | Filter by category |
| `place_id` | Filter by place |
| `near` | Location coordinates |
| `radius_km` | Proximity radius |

Don't invent non-spec query parameters for the v1 public API without strong justification.

### Extending the Spec

Neighborhood Commons extends the Neighborhood API with capabilities the spec doesn't cover:

- **Portal CRUD** — businesses submit and manage events (the spec is read-only)
- **Admin curation** — platform operators approve/reject/edit events
- **Webhooks** — real-time push notifications for downstream consumers
- **Internal sync** — service-to-service sync for consuming applications
- **Image hosting** — upload, re-encode, and serve event images

These extensions live under their own route prefixes (`/api/portal/*`, `/api/admin/*`, `/api/internal/*`). The spec-aligned public API (`/api/v1/*`) remains clean and spec-compliant.

### What We Don't Do

- **Don't fork the spec.** If the spec says `name`, we use `name` in API responses — not `title`. If the spec says `category` is an array, we return an array.
- **Don't anticipate unspecified schemas.** Assets, dreams, plans, notices, and groups don't have full schemas yet. Don't build endpoints for them based on guesses.
- **Don't lock in.** The spec is MIT-licensed and designed for interoperability. Our extensions should be documented well enough that other implementations could adopt them.

## Philosophy

**Every line of code in this repo should be defensible.** Not "it works" defensible — "here's why this is the right approach and here's what we considered and rejected" defensible. This codebase will be read by skeptics. It should convert them.

- **Fewer things, done completely.** One auth model, fully implemented. One validation approach, used everywhere. One error shape, no exceptions. Don't add a feature unless you're willing to own its security surface, its edge cases, and its maintenance burden forever.
- **Public data, private infrastructure.** Events are public. Everything else — IP addresses, user identities, access patterns, business email addresses — is private by default and must be justified to store, log, or transmit.
- **No magic, no tricks.** Every behavior should be traceable from the route handler to the database query to the response. No ORMs, no middleware that silently transforms data, no "smart" defaults that surprise readers.
- **The data enables surprising things.** This API doesn't know what downstream consumers will build. A social app might show nearby events. A civic dashboard might track neighborhood vitality. Someone might crowdsource pool attendance patterns from open swim listings. Design for data atoms that can be recombined in ways we haven't imagined.

### Two Audiences, One System

This project serves two audiences simultaneously. Every decision must hold up for both.

**The API serves developers and entrepreneurs.** They're building event apps, community dashboards, civic tools, newsletters. They need structured, predictable, complete data atoms. Every event instance must be self-sufficient — carrying its full story without implicit knowledge, extra joins, or undocumented carry-forward behavior. Rigidity here is a feature: spec-correct responses, bounded recurrence rules, reliable pagination, no surprises. If a developer can't trust the data shape, they'll build around us instead of on top of us.

**The portal serves busy operators.** Bar managers, yoga studio owners, coffee shop staff, community organizers. They post events between pouring drinks and teaching classes. The portal must be deeply intuitive — pull up the dashboard, see your recurring events (happy hour, trivia, karaoke) and your one-offs (shows, popups), and have a clear path to edit, delete, add, or manage both. The portal is not forgiving (it still enforces data quality), but it's friendly in how it presents structure. Operators think "every Thursday for 3 months," not "12 instances of a weekly pattern." Meet them in their language.

**The art is in nailing both.** Backend strict enough that the commons is a respected public resource. Portal intuitive enough that someone who's never used a CMS can post their open mic night in two minutes. Neither audience should feel the other's complexity. A bar owner never sees an RRULE. A developer never gets an event instance that requires a join to interpret. Same data, two perfect interfaces.

When these goals conflict, resolve in favor of the data. The portal can always present rigid data more gently. But if the data is sloppy to make the portal easier, every downstream consumer inherits the mess.

## Architecture

### Request Flow

Every request follows the same path. No exceptions.

```
Request → Security headers → CORS → Rate limit → Auth (if required) → Validate input → Execute → Format response → Error handler
```

Don't add middleware that breaks this chain. Don't add middleware that conditionally applies based on runtime state. The middleware stack is static and deterministic.

### Database Access

- **`supabaseAdmin`** (service role) for system operations — cron jobs, webhook delivery, admin routes, internal sync.
- **`createUserClient(token)`** for user-context operations — portal CRUD where RLS policies enforce ownership.
- Never construct raw SQL. Every query goes through PostgREST. If PostgREST can't express the query, write an RPC function in a migration.
- Every RPC function: `SECURITY DEFINER`, `SET search_path = public, extensions`, and `REVOKE EXECUTE FROM PUBLIC, authenticated, anon` unless explicitly public.

### Row Level Security (RLS)

**Every table has RLS enabled.** The Supabase anon key is embedded in the portal SPA and can be extracted by anyone. Without RLS, the anon role can read/write tables directly via PostgREST, bypassing Express entirely.

| Table | RLS | Access Pattern |
|-------|-----|----------------|
| `events` | Policies: anon/authenticated read all; authenticated portal users write own | Portal uses `createUserClient(token)` — RLS enforces `creator_account_id` ownership |
| `portal_accounts` | Policies: authenticated read/update own (via `auth.uid()`) | Portal uses `createUserClient(token)`; admin uses `supabaseAdmin` |
| `event_series` | Enabled, no policies (service role only) | Only accessed via `supabaseAdmin` in cron/admin |
| `regions` | Policies: public read | Read-only for all roles; admin writes via `supabaseAdmin` |
| `api_keys` | Enabled, no policies (deny all non-service) | Only accessed via `supabaseAdmin` in Express |
| `audit_logs` | Enabled, no policies (deny all non-service) | Fire-and-forget insert via `supabaseAdmin` |
| `webhook_subscriptions` | Enabled, no policies (deny all non-service) | Only accessed via `supabaseAdmin` in webhook routes |
| `webhook_deliveries` | Enabled, no policies (deny all non-service) | Only accessed via `supabaseAdmin` in delivery engine |

Tables with "no policies" rely on RLS's default-deny behavior: with RLS enabled and zero policies granting access, `anon` and `authenticated` roles are blocked. The `service_role` bypasses RLS entirely, so `supabaseAdmin` continues working unchanged.

**Never disable RLS on any table.** If a table is server-only, enable RLS with no policies — that's the safest configuration.

### Route Files

Each route file is self-contained: schemas at the top, constants, helper functions, then route handlers, then the export. No cross-route imports. Shared logic lives in `lib/`.

Route handlers follow one pattern:

```typescript
router.post('/resource', authMiddleware, rateLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(schema, req.body);
    // ... business logic using supabaseAdmin or createUserClient
    res.status(201).json({ resource: result });
  } catch (err) {
    next(err);
  }
});
```

No variations. No inline validation. No `res.status(400).json()` scattered through the handler — use `throw createError(message, status, code)`.

### Error Responses

One shape. Always.

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Human-readable explanation" } }
```

Status codes mean what HTTP says they mean:
- `400` — your request is malformed
- `401` — you didn't authenticate
- `403` — you authenticated but can't do this
- `404` — that resource doesn't exist (or you can't see it — don't leak existence)
- `409` — conflicts with existing state
- `429` — slow down
- `500` — our fault (never expose internals)

### Adding Features

Before adding anything, answer:

1. **Does this serve the public data mission?** If it's about individual users, social features, or personalization — it doesn't belong here.
2. **What's the security surface?** Every endpoint is an attack surface. Every stored field is a data liability. Every external call is a failure mode.
3. **Can you delete it later?** If removing it would break consumers, think harder about whether to add it. Public APIs are forever.
4. **What's the simplest version?** Build that. Ship it. See if anyone needs more.

## Security Rules

### Non-Negotiable

- **All input validated with Zod before use.** No `req.body.whatever` without a schema. Use `validateRequest(schema, data)`.
- **All route params validated.** Use `validateUuidParam(value, name)` for UUIDs. Don't trust Express params.
- **All image uploads re-encoded through Sharp.** Magic byte check first, then Sharp re-encode. This strips metadata and kills polyglot payloads. No exceptions — not even for "trusted" admin uploads.
- **No secrets in logs.** Tokens truncated, emails masked (`abc***`), IPs hashed, user IDs hashed via `hashId()`. Grep the codebase for any `console.log` that includes `token`, `key`, `secret`, `password`, `email`, or `ip` — fix violations immediately.
- **No secrets in error responses.** The error handler strips stack traces and replaces 5xx messages with generic text. Don't circumvent this.
- **Webhook URLs validated for SSRF.** DNS resolution + RFC 1918 block + cloud metadata block. This runs on every webhook creation and update.
- **Timing-safe comparisons for secrets.** Use `crypto.timingSafeEqual` for service keys, cron secrets, HMAC verification. Never `===` for secret comparison.

### Authentication

Three auth models, clearly separated:

| Model | Middleware | Client | Use Case |
|-------|-----------|--------|----------|
| Portal | `requirePortalAuth` | `createUserClient(token)` | Business owners managing their own events |
| Admin | `requireCommonsAdmin` | `supabaseAdmin` | Platform operations, account management |
| Service | `requireServiceKey` | `supabaseAdmin` | Internal consumers, sync bridges |

Don't add a fourth auth model. If a new feature doesn't fit one of these three, reconsider the feature.

### Rate Limiting

Every route has an explicit rate limit. No route inherits only the global limit — that's a safety net, not a policy.

| Tier | Limit | Use |
|------|-------|-----|
| `browseLimiter` | 30/min | Public data reads |
| `writeLimiter` | 10/min | State-changing operations |
| `portalLimiter` | 30/min per user | Authenticated portal CRUD |
| `enumerationLimiter` | 5/min | Account lists, stats, anything that reveals cardinality |

When adding a new route, choose the appropriate limiter. If none fits, create a new named limiter with explicit justification.

### Privacy

- **No individual user tracking on public endpoints.** Browse counters use IP hashes with 24-hour TTL. After cleanup, there is zero record that any individual viewed any event.
- **Audit logs hash actor identities.** `hashId(userId)` produces a one-way hash. Given a user ID, you can find their audit trail. Given an audit trail, you cannot recover the user ID. This is deliberate.
- **Location data is transient.** Latitude/longitude in requests is used for distance calculation and discarded.

## Code Quality

### Naming

- Files: `kebab-case.ts`
- Functions: `camelCase` — verb-first (`validateRequest`, `dispatchWebhooks`, `hashId`)
- Constants: `UPPER_SNAKE_CASE` for true constants (`EVENT_CATEGORIES`, `PAGE_LIMIT`)
- Types: `PascalCase` (`PortalEventRow`, `EventCategory`)
- Route params: validated immediately, never passed through raw
- Log prefixes: `[UPPERCASE]` matching the domain (`[PORTAL]`, `[ADMIN]`, `[WEBHOOKS]`, `[CRON]`)

### Comments

Write comments for:
- **Why**, never **what**. If the code needs a "what" comment, the code is unclear — fix the code.
- **Security decisions.** Why this auth model, why this rate limit, why this validation.
- **Non-obvious constraints.** Database column limits, external API quirks, timezone edge cases.

Don't write comments for:
- Function signatures (TypeScript handles this)
- Import groups
- Anything a competent reader can infer in 3 seconds

### Dependencies

This repo has 8 runtime dependencies. That's deliberate. Before adding a ninth:

1. Can you do it with Node.js built-ins? (`crypto`, `http`, `url`, `fs`)
2. Can you do it in 50 lines of code in a lib file?
3. Is the dependency well-maintained, small, and auditable?

Don't add: ORMs, logging frameworks, DI containers, "utility" libraries, anything that adds abstractions we don't need.

## Testing

**Tests are not optional. They expand alongside every change.** Other apps depend on this data. A silent column mismatch or a broken transform means bad data flowing to every downstream consumer. Tests are the only thing standing between a code change and corrupted data in every app pulling from this API.

### Run Before Every Push

```
npm run test:run
```

All tests must pass. No exceptions, no skipping.

### Test Philosophy

Tests should find real bugs, not prove the developer was thorough. If a test can't fail in a way that matters, delete it.

The test suite is designed around the question: **what would silently break the experience of people discovering and attending neighborhood events?** Bad data in the API response. A broken transform that drops the venue address. A column rename that silently nulls out every event description. An auth change that locks business owners out of their own listings. These are the failures that matter, and these are what the tests catch.

### What We Test

| Test File | What It Catches |
|-----------|----------------|
| `schema-alignment.test.ts` | Column name mismatches between code and database. Supabase/PostgREST silently returns null for nonexistent columns — this test turns silent data loss into loud failures. Found 6 real bugs on its first run. **Update the `SCHEMA` constant when migrations change columns.** |
| `event-transform.test.ts` | Neighborhood API spec violations — wrong field names, wrong nesting, wrong types in the public API response. If these fail, every consumer of the API gets the wrong shape. |
| `api-integration.test.ts` | End-to-end Express app tests — HTTP requests through the real middleware stack. Verifies status codes, response shapes, error formats, auth rejection, CORS headers, and content negotiation. |
| `portal-crud.test.ts` | Portal auth enforcement, input validation (dates, times, categories, UUIDs, coordinates, recurrence patterns, field lengths), event CRUD lifecycle, registration, image upload rejection. |
| `url-validation.test.ts` | SSRF protection — protocol enforcement, blocked hostnames, RFC 1918 ranges, cloud metadata IPs (169.254.169.254), IPv6 private ranges, IPv4-mapped addresses, DNS failure behavior (fail closed). |
| `image-validation.test.ts` | Image upload security — magic byte validation (accept JPEG/PNG/WebP, reject GIF/BMP/SVG/PDF/EXE/HTML polyglots), Sharp re-encoding pipeline (dimension capping, metadata stripping, format normalization, truncated file rejection). |
| `webhook-signing.test.ts` | Webhook HMAC-SHA256 signing (consistency, tamper detection, consumer verification), AES-256-GCM secret encryption (round-trip, random IV, tamper rejection, truncation rejection). |
| `validation.test.ts` | Input validation failures — missing fields, wrong types, injection attempts getting past the front door. |
| `security.test.ts` | Security regressions — API key hashing, error response shape, URL resolution, geo parsing. |

### When Adding Code

- **New route or query?** The schema alignment test picks up new column references automatically. If you reference a column that doesn't exist, it fails.
- **New migration?** Update the `SCHEMA` constant in `schema-alignment.test.ts` first. Add the column there before writing the code that uses it.
- **New public endpoint?** Add integration tests in `api-integration.test.ts` that verify the response shape, status codes, and error handling.
- **New portal endpoint?** Add integration tests in `portal-crud.test.ts` — auth enforcement, input validation, and response shape.
- **Changed auth, RLS, rate limits, or access patterns?** Update this file (CLAUDE.md), `public/llms.txt`, and `docs/consumer-guide.md` in the same commit. The docs are the contract.
- **New transform or helper?** Add unit tests in the appropriate test file.
- **New table?** Add it to `SCHEMA`. The test will catch you if you forget.

### What Not To Test

Don't test Express routing mechanics, Supabase client internals, or Zod schema parsing. Don't write tests that just assert the code does what you can see it does. Tests should catch bugs that would otherwise reach production silently.

## Migrations

- One file per migration in `migrations/`
- Name format: `NNN_description.sql` (sequential, not timestamp-based — this is a small repo)
- Every migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`)
- Every SECURITY DEFINER function sets `search_path = public, extensions`
- Never modify an existing migration. Create a new one.
- Test migrations against a fresh Supabase instance before merging.

## Environment Setup

Required environment variables (see `src/config.ts` for Zod validation):

```bash
SUPABASE_URL=           # Your Supabase project URL
SUPABASE_ANON_KEY=      # Supabase anon/public key
SUPABASE_SERVICE_ROLE_KEY= # Supabase service role key (server-side only)
AUDIT_SALT=             # For audit log hashing (min 16 chars)
```

Optional:
```bash
COMMONS_ADMIN_USER_IDS= # Comma-separated Supabase auth UUIDs for admin access
GOOGLE_PLACES_API_KEY=  # Venue search in portal
TURNSTILE_SECRET_KEY=   # Cloudflare Turnstile (captcha)
CAPTCHA_ENABLED=false   # Set to true when Turnstile is configured
MAILGUN_API_KEY=        # Portal emails
MAILGUN_DOMAIN=         # Mailgun sending domain
COMMONS_R2_*=           # Cloudflare R2 credentials for image hosting
CRON_SECRET=            # For cron endpoint auth (min 16 chars)
COMMONS_SERVICE_KEY=    # For internal sync auth (min 32 chars)
DEFAULT_REGION_ID=      # UUID of default region for new portal events
WEBHOOK_ENCRYPTION_KEY= # AES-256-GCM key for webhook signing secrets at rest (64 hex chars / 32 bytes)
                        # Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
                        # Without this, webhook signing secrets are stored in plaintext
```

## What Not To Do

- **Don't add user accounts.** This is a public data service. If you need user-specific features, that belongs in the consuming application, not here.
- **Don't add social features.** No likes, no comments, no follows, no feeds. The social layer lives elsewhere.
- **Don't add caching layers.** HTTP cache headers are fine. Application-level caching adds complexity we don't need at this scale.
- **Don't add GraphQL.** The REST API is simple and sufficient. GraphQL adds parsing complexity, introspection surface, and query cost analysis that we'd need to secure.
- **Don't over-abstract.** Three similar database queries are better than a "query builder" helper. Four similar route handlers are better than a "route factory." Abstractions are justified when they prevent bugs, not when they prevent typing.
- **Don't "improve" working code.** If you're fixing a bug, fix the bug. Don't also rename variables, add types, refactor helpers, or clean up adjacent code. One concern per change.
