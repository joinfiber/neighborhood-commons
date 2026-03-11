# Fiber Commons

Public events data infrastructure. Open, minimal, correct.

## Current Status (March 2026)

### What's Live
- **API**: Deployed to Railway at `commons.joinfiber.app` — 89 events serving via `/api/events` and `/api/v1/events`
- **Portal**: React SPA served from same Express server (same-origin, no CORS) — business login, event CRUD, admin dashboard
- **Database**: Dedicated Supabase project (`fiber-commons`) with events, portal_accounts, regions, event_series, event_analytics, etc.
- **Images**: Served from Cloudflare R2 via portal image proxy route

### Pending Setup (Supabase Dashboard)
1. **Auth → URL Configuration**: Set Site URL to `https://commons.joinfiber.app`, add to Redirect URLs
2. **Auth → SMTP Settings**: Configure Mailgun SMTP (smtp.mailgun.org:587) for branded email delivery
3. **Auth → Email Templates**: Paste branded templates from `docs/supabase-email-templates.md` (Confirm Signup + Magic Link use `{{ .Token }}` for 8-digit OTP, not magic links)

### Architecture
- Single Railway service: Express API + static portal SPA in one Docker container
- Portal built via multi-stage Dockerfile (`portal-builder` stage), output copied to `./portal` in runner
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_TURNSTILE_SITE_KEY` baked into SPA at build time via Docker ARGs
- `VITE_API_URL` intentionally empty — same-origin requests
- Google Places API proxied through `/api/places/search` (server-side key, not exposed to client)

### What's Next (from design doc)
- Phase 2: Cut over public traffic (portal domain, v1 API consumers, dual-write bridge)
- Phase 3: Social app migration (plans table, commons_cache, sync process)
- See `docs/design/TABLE_SPLIT_AND_EVENTS_SERVER.md` for full plan

## What This Is

A standalone API serving structured public event data — concerts, comedy, markets, community gatherings. Businesses submit events through a portal; admins curate; the API serves them to anyone. No accounts required to read. No tracking of individuals. The data is the product.

This is infrastructure, not an application. Treat it accordingly: correctness over features, stability over velocity, simplicity over cleverness.

## Neighborhood API Alignment

This project implements and extends the [Neighborhood API](https://github.com/The-Relational-Technology-Project/neighborhood-api) — an open spec (v0.2) for sharing local events, assets, dreams, plans, and notices across neighborhood tools and communities. The spec is connective tissue, not a platform. We are one implementation of it.

### Relationship to the Spec

**Faithfully implement the spec.** Where the spec defines a behavior, follow it exactly. Where the spec is silent, we may extend — but extensions must not contradict or conflict with spec-defined behavior.

The spec currently defines full schemas only for Events. Assets, dreams, plans, notices, and groups are named but not yet specified. When those schemas are published, we adopt them. Until then, we don't invent our own — we wait, or we contribute upstream.

### Event Schema Alignment

The v1 public API (`/api/v1/events`) **must** return events conforming to the Neighborhood API event schema. Internal database columns may use different names, but the API response layer transforms to spec format:

| Spec Field | Type | Our DB Column | Notes |
|------------|------|---------------|-------|
| `id` | string | `id` (UUID) | Spec uses slugs (`evt_...`); we use UUIDs. Both are valid identifiers. |
| `name` | string | `content` | Spec calls it `name`, not `title`. Transform on output. |
| `start` | ISO 8601 w/ tz | `event_at` | |
| `end` | ISO 8601 w/ tz | `end_time` | |
| `description` | string | `description` | Direct match. |
| `category` | string[] | `category` | Spec uses array; we store single string. Wrap in array on output. |
| `place_id` | string | `place_id` | Direct match. |
| `location` | object | flat columns | Spec nests `{ name, address, lat, lng }`. We store `place_name`, `venue_address`, `latitude`, `longitude` as flat columns. Nest on output. |
| `url` | string | `link_url` | |
| `images` | string[] | `event_image_url` | We store one image; spec allows array. Wrap in array on output. |
| `organizer` | object | portal account | Nest `{ name }` from portal account data. |
| `cost` | string | `price` | Free-text in both. |
| `source` | object | constructed | Build from `source` column + portal account. Always include `publisher`, `collected_at`, `license`. |

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

The spec defines these collection endpoints. Our implementation status:

| Endpoint | Status | Route File |
|----------|--------|------------|
| `GET /meta` | **Required** | `routes/meta.ts` |
| `GET /events` | Implemented | `routes/v1.ts` |
| `GET /events/{id}` | Implemented | `routes/v1.ts` |
| `GET /events.ics` | Implemented | `routes/v1.ts` |
| `GET /events.rss` | Implemented | `routes/v1.ts` |
| `GET /assets` | Not yet (spec pending) | — |
| `GET /dreams` | Not yet (spec pending) | — |
| `GET /plans` | Not yet (spec pending) | — |
| `GET /notices` | Not yet (spec pending) | — |
| `GET /groups` | Not yet (spec pending) | — |

### The `/meta` Endpoint

Every Neighborhood API instance must expose `/meta` with stewardship information:
- **Stewards** — who maintains this feed
- **Data sources** — what upstream sources feed into it
- **Publisher allowlist** — which sources are trusted

This is transparency infrastructure. It answers "who runs this and where does the data come from?"

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

Implement these where supported. Don't invent non-spec query parameters for the v1 public API without strong justification.

### Extending the Spec

Fiber Commons extends the Neighborhood API with capabilities the spec doesn't cover:

- **Portal CRUD** — businesses submit and manage events (the spec is read-only)
- **Admin curation** — platform operators approve/reject/edit events
- **Webhooks** — real-time notifications for downstream consumers
- **Analytics** — anonymous engagement counters (trending, calendar adds, interested)
- **Internal sync** — service-to-service sync for consuming applications
- **Image hosting** — upload, re-encode, and serve event images

These extensions live under their own route prefixes (`/api/portal/*`, `/api/admin/*`, `/api/internal/*`). The spec-aligned public API (`/api/v1/*`) remains clean and spec-compliant.

### What We Don't Do

- **Don't fork the spec.** If the spec says `name`, we use `name` in API responses — not `title`. If the spec says `category` is an array, we return an array.
- **Don't anticipate unspecified schemas.** Assets, dreams, plans, notices, and groups don't have schemas yet. Don't build endpoints for them based on guesses.
- **Don't lock in.** The spec is MIT-licensed and designed for interoperability. Our extensions should be documented well enough that other implementations could adopt them if useful.

## Philosophy

**Every line of code in this repo should be defensible.** Not "it works" defensible — "here's why this is the right approach and here's what we considered and rejected" defensible. This codebase will be read by skeptics. It should convert them.

- **Fewer things, done completely.** One auth model, fully implemented. One validation approach, used everywhere. One error shape, no exceptions. Don't add a feature unless you're willing to own its security surface, its edge cases, and its maintenance burden forever.
- **Public data, private infrastructure.** Events are public. Everything else — IP addresses, user identities, access patterns, business email addresses — is private by default and must be justified to store, log, or transmit.
- **No magic, no tricks.** Every behavior should be traceable from the route handler to the database query to the response. No ORMs, no middleware that silently transforms data, no "smart" defaults that surprise readers.

## Architecture Rules

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
- **Location data is transient.** Latitude/longitude in requests is used for distance calculation and discarded. The `find_user_region` RPC accepts coordinates and returns a region name — coordinates are never stored in the query.

## Code Quality

### Naming

- Files: `kebab-case.ts`
- Functions: `camelCase` — verb-first (`validateRequest`, `dispatchWebhooks`, `hashId`)
- Constants: `UPPER_SNAKE_CASE` for true constants (`EVENT_CATEGORIES`, `PAGE_LIMIT`)
- Types: `PascalCase` (`PortalEventRow`, `EventCategory`, `VibeSummary`)
- Route params: validated immediately, never passed through raw
- Log prefixes: `[UPPERCASE]` matching the domain (`[PORTAL]`, `[ADMIN]`, `[WEBHOOKS]`, `[CRON]`)

### Comments

Write comments for:
- **Why**, never **what**. If the code needs a "what" comment, the code is unclear — fix the code.
- **Security decisions.** Why this auth model, why this rate limit, why this validation.
- **Non-obvious constraints.** Database column limits, external API quirks, timezone edge cases.
- **Algorithm explanation.** Trending score formula, geographic distance approximation, retry backoff calculation.

Don't write comments for:
- Function signatures (TypeScript handles this)
- Import groups
- "End of section" markers
- Anything a competent reader can infer in 3 seconds

### File Size

Route files may be long (portal.ts is 1,400 lines). That's fine — a route file is a complete unit. Don't split a route file into multiple files to hit an arbitrary line limit. Split only when you have genuinely distinct domains.

Lib files should be focused. One concern per file. If a lib file exceeds 300 lines, it's probably doing two things.

### Dependencies

This repo has 8 runtime dependencies. That's already a lot. Before adding a ninth:

1. Can you do it with Node.js built-ins? (`crypto`, `http`, `url`, `fs`)
2. Can you do it in 50 lines of code in a lib file?
3. Is the dependency well-maintained, small, and auditable?

Don't add: ORMs, logging frameworks, DI containers, "utility" libraries, anything that adds abstractions we don't need.

## Testing (When Added)

Tests should prove the system works correctly, not prove the developer was thorough. Focus on:

1. **Auth boundaries.** Can an unauthenticated user access portal routes? Can a portal user access admin routes? Can a service key access portal routes?
2. **Validation boundaries.** What happens with missing fields, extra fields, wrong types, boundary values?
3. **Business logic correctness.** Event lifecycle (create → approve → publish → webhook). Counter dedup (same IP twice → counted once). Account state transitions.
4. **Security properties.** No secrets in error responses. No stack traces in production. Rate limits enforced. SSRF protection blocks private IPs.

Don't test: Express routing mechanics, Supabase client internals, Zod schema parsing (Zod has its own tests).

## Migrations

- One file per migration in `migrations/`
- Name format: `NNN_description.sql` (sequential, not timestamp-based — this is a small repo)
- Every migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`)
- Every SECURITY DEFINER function sets `search_path = public, extensions`
- Never modify an existing migration. Create a new one.
- Test migrations against a fresh Supabase instance before merging.

## What Not To Do

- **Don't add user accounts.** This is a public data service. If you need user-specific features, that belongs in the consuming application, not here.
- **Don't add social features.** No likes, no comments, no follows, no feeds. The social layer lives elsewhere.
- **Don't add caching layers.** HTTP cache headers are fine. Application-level caching (Redis, in-memory) adds complexity we don't need at this scale. If we need it, we'll know — and we'll add it deliberately.
- **Don't add GraphQL.** The REST API is simple and sufficient. GraphQL adds parsing complexity, introspection surface, and query cost analysis that we'd need to secure.
- **Don't over-abstract.** Three similar database queries are better than a "query builder" helper. Four similar route handlers are better than a "route factory." Abstractions are justified when they prevent bugs, not when they prevent typing.
- **Don't "improve" working code.** If you're fixing a bug, fix the bug. Don't also rename variables, add types, refactor helpers, or clean up adjacent code. One concern per change.
