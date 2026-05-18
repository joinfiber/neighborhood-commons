# Neighborhood Commons

Open, typed substrate for neighborhood public facts. Read free, write through verified organizations, designed to compose into anything a neighborhood needs to know about itself.

Five Schema.org-aligned primitives — **Place**, **Organization**, **Event**, **Broadcast**, **List** — that any app can read, mix, and remix. Implements the [Neighborhood API](https://github.com/The-Relational-Technology-Project/neighborhood-api) spec with a constrained-publishing model: writes must come from organizations with structural authority over what they publish, via three authority paths (entity-runs-it, pipeline-proxies, witnessed-with-evidence). Verification anchors first-party identity. No user accounts. No PII. CC BY 4.0.

This is infrastructure designed to be cloned and run by any city. **The data is the product.**

**Live instance: [neighborhood-commons.org](https://neighborhood-commons.org)**

## What's here

- **Public API** — Schema.org-aligned reads, no key required. `GET /api/v1/events`, `/api/v1/organizations`, `/api/v1/publishers`, `/api/v1/places`, `/api/v1/broadcasts`, `/api/v1/lists`, plus `/api/v1/events/{id}` and `/api/v1/events.ics` · `/api/v1/events.rss` feeds.
- **Service API** — Full CRUD for trusted external tools (consumer apps, ingestion pipelines, admin dashboards). Authenticated via service-tier API keys, scoped to the organizations a key is linked to via `api_key_organization_links`.
- **Spec + SDK** — `public/openapi.json` is the contract. The [`neighborhood-commons`](https://www.npmjs.com/package/neighborhood-commons) npm package is generated from it; bumps lockstep on tagged releases.
- **Webhooks** — Real-time push notifications for downstream consumers.
- **Self-service registration** — Developers issue their own service-tier key via the OTP flow at `/v1/service/register/*`. Keys land in `pending` status (reads work; writes return `KEY_PENDING` until an operator activates with one short review).

What's deliberately *not* here: user accounts, ingestion pipelines, admin CMS surfaces, editorial curation. The Commons stays infrastructure. Everything else lives in purpose-built tools (consumer apps, operator pipelines, admin tools) that connect via the Service API.

## The Commons Contract

Three documents together form the contract between this service and every app that consumes it:

- **The Spec** — [`public/openapi.json`](public/openapi.json) — machine-readable, authoritative. Wins every conflict.
- **The Guide** — [`public/llms.txt`](public/llms.txt) — narrative companion. Explains *why* and *how*.
- **The Log** — [`CHANGELOG.md`](CHANGELOG.md) — dated record of every contract-affecting change.

The current major is **3.0**. From here, the substrate is additive-only — new fields, endpoints, and primitives appear without breaking existing consumers. Breaking changes require a major bump and are measured in years. The explicit taxonomy of breaking vs. additive lives in [`docs/stability-promise.md`](docs/stability-promise.md).

Core doctrine docs (read before building anything substantial):
- [`docs/four-roles.md`](docs/four-roles.md) — event provenance: organizer, venue, contributor, method+url. No fifth role; no `source.publisher` field.
- [`docs/provenance.md`](docs/provenance.md) — type-general `method` doctrine across primitives.
- [`docs/quickstart.md`](docs/quickstart.md) — copy-paste worked examples for the three authority paths.

## Consume the API

No API key required for public reads:

```bash
curl https://neighborhood-commons.org/api/v1/events
curl 'https://neighborhood-commons.org/api/v1/events?category=live_music'
curl 'https://neighborhood-commons.org/api/v1/events?q=happy+hour'
curl 'https://neighborhood-commons.org/api/v1/events?near=39.97,-75.14&radius_km=2'
curl https://neighborhood-commons.org/api/v1/events/{id}
curl https://neighborhood-commons.org/api/v1/events.ics
curl https://neighborhood-commons.org/api/v1/events.rss
curl https://neighborhood-commons.org/.well-known/neighborhood
```

Every event response carries four-role provenance: `organizer` (who runs it), `location` (where), `source.contributor` (which app routed it in), and `source.method` (`self_asserted` / `proxied` / `witnessed`), plus `source.collected_at` and `source.license`.

For typed access in TypeScript, install the SDK:

```bash
npm install neighborhood-commons
```

```ts
import { createCommonsClient } from 'neighborhood-commons';

const commons = createCommonsClient(); // no key needed for reads
const { data } = await commons.GET('/events', {
  params: { query: { start_after: '2026-01-01', limit: 20 } },
});
```

See [`docs/quickstart.md`](docs/quickstart.md) for the full integration walkthrough including writes.

## Publish to the Commons

1. **Self-issue a service-tier key.** `POST /v1/service/register/send-otp` (your email), `POST /v1/service/register/verify-otp` (the code + your app metadata). You get a key in `pending` status. Reads work immediately; writes return `KEY_PENDING` until activation.
2. **Wait for operator activation.** A short one-time review by the Commons operator. Typically same-day. Email `hi@neighborhood-commons.org` if it stalls.
3. **Link your key to an organization.** Either `POST /v1/service/organizations` (creates a new org and auto-links your key) or `POST /v1/service/organizations/link` (links to an existing org you have authority over).
4. **Publish events** via `POST /v1/service/events`. Provenance defaults to `source_method = self_asserted`; the contributor field auto-fills from your registered app identity.

The three authority paths (entity-runs-it / pipeline-proxies / witnessed-with-evidence) are documented in [`docs/four-roles.md`](docs/four-roles.md) with worked examples in [`docs/quickstart.md`](docs/quickstart.md).

## Run your own instance

Neighborhood Commons is designed to be stood up by anyone. The fastest path uses the [Supabase CLI](https://supabase.com/docs/guides/cli) (Postgres + PostgREST + Auth in Docker).

**Prerequisites:** Node.js 20+, Docker, Supabase CLI

```bash
# 1. Clone and install
git clone https://github.com/joinfiber/neighborhood-commons.git
cd neighborhood-commons
npm install

# 2. Start local Supabase
supabase init           # First time only
supabase start          # Prints connection details

# 3. Apply migrations in order
#    Paste each migrations/*.sql into the SQL editor at http://localhost:54323
#    in numeric order, ending with the most recent (085 at time of writing).
#    Or: supabase db push.

# 4. Configure environment
cp .env.example .env
# Fill SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, AUDIT_SALT
# from the output of `supabase status`.

# 5. Start the API server
npm run dev             # http://localhost:3001

# 6. Verify
curl http://localhost:3001/api/v1/events
curl http://localhost:3001/openapi.json
```

The `.env.example` documents every environment variable. Four are required:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
AUDIT_SALT=your-random-string-min-16-chars
```

See [`CLAUDE.md`](CLAUDE.md) for the full list of optional variables (image hosting, email, CORS, rate-limit overrides, etc.).

### Deploy

The repo includes a multi-stage Dockerfile suitable for Railway, Fly, or any container host. Connect your GitHub repo, set the four required env vars, and ship.

### Issue your first service key

Use the same self-issue flow consumers use:

```bash
curl -X POST https://your-instance/api/v1/service/register/send-otp \
  -H "Content-Type: application/json" \
  -d '{"email": "your-admin-tool@example.com"}'

# (check email, then)
curl -X POST https://your-instance/api/v1/service/register/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"email": "...", "code": "...", "app_name": "...", "app_url": "...", "what_youre_building": "..."}'
```

The key returns in `pending` status. To activate it (admin-only), run the activation endpoint from another admin-tier key, or for your bootstrap key flip `activated_at` in the SQL editor:

```sql
UPDATE api_keys SET activated_at = now() WHERE id = 'your-key-id';
-- Optionally grant admin: UPDATE api_keys SET is_admin = true WHERE id = '...';
```

After bootstrap, prefer the activation endpoint over raw SQL.

## Project structure

```
src/
  routes/        # API endpoints (v1 reads, service writes, webhooks, meta, pages)
  lib/           # Shared logic (transforms, validation, helpers, image processing)
  middleware/    # Auth, rate limiting, error handling
  config.ts      # Environment validation (Zod)
  app.ts         # Express app factory
sdk/             # TypeScript SDK source — generated from public/openapi.json
tests/           # Vitest test suite
migrations/      # Sequential SQL migrations (000–085)
public/
  openapi.json   # The Spec — authoritative contract
  llms.txt       # The Guide — narrative companion
  index.html     # Homepage
docs/            # Doctrine docs (four-roles, provenance, stability-promise, quickstart)
docs/archive/    # Historical docs (v2 transition briefs, old migration plans)
prompts/         # Operational broadcast prompts (one-shot consumer-app updates)
CLAUDE.md        # Development guide and architecture decisions
```

## Architecture

Single Express server serving both the API and the homepage. Minimal runtime dependencies.

- **Database** — Supabase (PostgreSQL + PostgREST + Row Level Security on every table)
- **Images** — Cloudflare R2, re-encoded through Sharp on upload
- **Auth** — Two tiers only: developer-tier API keys (read scope with rate-limit benefits) and service-tier API keys (full CRUD, scoped to linked organizations)
- **Validation** — Zod on every input, no exceptions
- **Rate limiting** — Per-route, explicit. Public browse (30/min), public write (10/min), service-tier (300/min per key), enumeration-sensitive endpoints (5/min)

The Commons is deliberately thin: it stores public facts and serves them via a spec-compliant API. Everything else — consumer apps, admin tools, ingestion pipelines, editorial curation — lives in external tools that connect via the Service API.

## Testing

```bash
npm run test:run
```

The suite catches real bugs:

- **Schema alignment** — statically scans every Supabase query and verifies column names exist in the live schema. PostgREST silently returns null for missing columns; this test turns silent data loss into loud failures.
- **Response-shape conformance** — validates live transform output against the schemas in `public/openapi.json`. Catches drift between code and spec.
- **Contract drift** — confirms the SDK schema matches `public/openapi.json` byte-for-byte.
- **Migration acceptance** — asserts the recent provenance-cleanup migration (085) does exactly what its doctrine promises.
- **API integration** — end-to-end Express tests through the real middleware stack.
- **Input validation, URL sanitization, image security, webhook signing** — security regressions caught at the right boundary.

All tests run in ~5 seconds. They must pass before push.

## Contributing

Read [`CLAUDE.md`](CLAUDE.md) first. It's the development guide — architecture decisions, security rules, naming conventions, and the philosophy behind the choices made here.

The short version:
- Every input validated with Zod
- Every route has an explicit rate limit
- Every image re-encoded through Sharp
- No secrets in logs or error responses
- Tests must pass before push
- Spec, code, SDK, and docs stay in lockstep (the contract-drift and response-shape-conformance tests enforce this mechanically)

## Built with AI

This project was built using [Claude Code](https://claude.com/claude-code) as a pair programmer. The commit history reflects this — every commit is co-authored. `CLAUDE.md` serves as both the development guide for human contributors and the shared context for AI-assisted development.

This is a positive vision of what AI-assisted development can look like: a non-engineer with a clear idea and strong opinions about correctness, working with an AI that brings software engineering discipline. The result is, hopefully, useful infrastructure that sits at an underexplored intersection of commercial and public interest. The guiding principle is simple: all flourishing is mutual.

Please judge the output.

## License

Event data: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — attribution required.

Code: MIT.

## Links

- [Neighborhood API spec](https://github.com/The-Relational-Technology-Project/neighborhood-api) — upstream open spec this project implements
- [The Relational Technology Project](https://relationaltechproject.org) — stewards of the upstream spec
- [OpenAPI spec](https://neighborhood-commons.org/openapi.json) — authoritative, machine-readable (the Spec)
- [The Guide](https://neighborhood-commons.org/llms.txt) — narrative companion
- [CHANGELOG](CHANGELOG.md) — the Log, dated record of every contract-affecting change
- [Quickstart](docs/quickstart.md) — copy-paste worked examples for publishing events
- [Stability promise](docs/stability-promise.md) — what counts as breaking vs. additive
- [Launch runbook](docs/launch-runbook.md) — operator sequence for moving production between major versions
