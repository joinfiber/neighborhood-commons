# Neighborhood Commons

Open neighborhood event data infrastructure. Fork it, stand it up, fill it with your neighborhood's data.

Neighborhood Commons is a thin data service: a database, an API, and a lightweight self-service portal. Venues and organizers post events — concerts, comedy, markets, community gatherings — and every app in the city can show them. It implements the [Neighborhood API](https://github.com/The-Relational-Technology-Project/neighborhood-api) spec, an open format for sharing local events across community tools.

This is infrastructure designed to be cloned and run by any city. The data is the product.

**Live instance: [commons.joinfiber.app](https://commons.joinfiber.app)**

## What's here

- **Public API** — Neighborhood API spec compliant. No auth required to read. `GET /api/v1/events`
- **Portal** — React SPA where venue operators sign up, post events, done. Self-service, no admin needed.
- **Service API** — Full CRUD for trusted external tools (admin dashboards, import scripts, partner apps). Authenticated via service-tier API keys.
- **Feeds** — iCal (`.ics`) and RSS (`.rss`) for calendar apps and feed readers.
- **Webhooks** — Real-time push notifications for downstream consumers.
- **Self-service API keys** — Developers register via email OTP, get a key, start building.

Admin tooling, data ingestion, and curation happen in external tools that connect via the Service API. The commons stays thin.

## Quick start

```bash
# Clone and install
git clone https://github.com/joinfiber/neighborhood-commons.git
cd neighborhood-commons
npm install
cd portal && npm install && cd ..

# Set up environment (see Environment section below)
cp .env.example .env  # Then fill in your Supabase credentials

# Run locally
npm run dev            # API server on :3001
cd portal && npm run dev  # Portal on :3002 (proxies API)

# Run tests
npm run test:run       # <1 second, all must pass
```

## Consume the API

No API key required for public reads:

```bash
# List upcoming events
curl https://commons.joinfiber.app/api/v1/events

# Filter by category
curl https://commons.joinfiber.app/api/v1/events?category=live-music

# Search by text
curl https://commons.joinfiber.app/api/v1/events?q=happy+hour

# Nearby events
curl https://commons.joinfiber.app/api/v1/events?near=39.97,-75.14&radius_km=2

# Single event
curl https://commons.joinfiber.app/api/v1/events/{id}

# Calendar feed
curl https://commons.joinfiber.app/api/v1/events.ics

# RSS feed
curl https://commons.joinfiber.app/api/v1/events.rss

# API discovery
curl https://commons.joinfiber.app/.well-known/neighborhood
```

Every event response includes provenance (`source.publisher`, `source.license`) and conforms to the Neighborhood API event schema. Data is licensed CC BY 4.0.

See [docs/consumer-guide.md](docs/consumer-guide.md) for the full integration guide.

## Running your own instance

Neighborhood Commons is designed to be stood up by anyone. Here's how to run your own.

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com) and create a new project. You'll need:
- Project URL (`SUPABASE_URL`)
- Anon/public key (`SUPABASE_ANON_KEY`)
- Service role key (`SUPABASE_SERVICE_ROLE_KEY`)

### 2. Run migrations

Migrations are in `migrations/`, numbered sequentially. Run them in order against your Supabase project using the SQL editor or the Supabase CLI:

```bash
# Using supabase CLI
supabase db push

# Or run each file manually in the Supabase SQL editor, in order:
# 001_initial_schema.sql, 002_add_regions_updated_at.sql, ...
```

### 3. Set environment variables

Required:
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
AUDIT_SALT=your-random-string-min-16-chars
```

See [CLAUDE.md](CLAUDE.md) for the full list of optional variables (image hosting, email, captcha, etc.).

### 4. Deploy

**Railway** (recommended): The repo includes a multi-stage Dockerfile. Connect your GitHub repo to Railway and it handles the rest.

**Local development**:
```bash
npm run dev
```

### 5. Create your first admin

Add your Supabase auth user ID to the `COMMONS_ADMIN_USER_IDS` environment variable. This grants access to the admin endpoints for account management (approve/suspend accounts).

### 6. Issue a service API key

Service keys let external tools (your admin dashboard, import scripts, etc.) perform full CRUD operations. Generate one:

```sql
-- Run in Supabase SQL editor
INSERT INTO api_keys (email, key_hash, contributor_tier, status)
VALUES (
  'your-admin-tool@example.com',
  encode(sha256(convert_to('your-secret-key-here', 'UTF8')), 'hex'),
  'service',
  'active'
);
```

Store the raw key securely. It's hashed on insert and cannot be recovered. Your external tool sends it via `X-API-Key` header.

### 7. Start adding data

Use the Service API to create accounts and events programmatically, or sign up through the portal as a venue operator.

## Project structure

```
src/
  routes/        # API endpoints (v1, portal, admin, service, webhooks, meta)
  lib/           # Shared logic (transforms, validation, helpers)
  middleware/    # Auth, rate limiting, error handling
  config.ts      # Environment validation (Zod)
  app.ts         # Express app factory
portal/          # React SPA (self-service portal for venue operators)
tests/           # Vitest test suite
migrations/      # Sequential SQL migrations (001–038)
docs/            # Consumer guide, email templates
public/          # llms.txt (AI-readable API docs)
CLAUDE.md        # Development guide and architecture decisions
```

## Architecture

Single Express server serving both the API and the portal SPA. Minimal runtime dependencies. Deployed to Railway via multi-stage Dockerfile.

- **Database**: Supabase (PostgreSQL + PostgREST + Row Level Security on every table)
- **Images**: Cloudflare R2, re-encoded through Sharp on upload
- **Auth**: Supabase email OTP for portal; API keys for developers; service-tier keys for trusted tools
- **Validation**: Zod on every input, no exceptions
- **Rate limiting**: Per-route, explicit — browse (30/min), write (10/min), API key (1000/hr)

The commons is deliberately thin. It stores events, serves them via a spec-compliant API, and provides a self-service portal for venue operators. Everything else — admin dashboards, import pipelines, curation tools, analytics — lives in external tools that connect via the Service API.

## Testing

```bash
npm run test:run
```

The test suite catches real bugs, not hypothetical ones:

- **Schema alignment** — Statically scans every Supabase query and verifies column names exist in the database. Supabase/PostgREST silently returns null for nonexistent columns; this test turns silent data loss into loud failures.
- **Spec compliance** — Verifies the public API response shape matches the Neighborhood API event schema.
- **API integration** — Tests the Express app end-to-end: request → middleware → handler → response, verifying status codes, response shapes, error formats, auth rejection, and rate limiting.
- **Input validation** — Confirms Zod schemas reject malformed input before it reaches business logic.
- **Security invariants** — API key hashing, error response shape (no leaked internals), URL resolution, SSRF protection.

## Contributing

Read [CLAUDE.md](CLAUDE.md) first. It's the development guide — architecture decisions, security rules, naming conventions, and the philosophy behind the choices made here.

The short version:
- Every input validated with Zod
- Every route has an explicit rate limit
- Every image re-encoded through Sharp
- No secrets in logs or error responses
- Tests must pass before push

## Built with AI

This project was built using [Claude Code](https://claude.com/claude-code) as a pair programmer. The commit history reflects this — every commit is co-authored. CLAUDE.md serves as both the development guide for human contributors and the shared context for AI-assisted development.

This project went through several iterations — from a full admin portal with ingestion pipelines and curation tools, to the thin infrastructure you see today. The current architecture reflects a clear lesson: infrastructure should be infrastructure. Admin tooling, data collection, and editorial curation belong in purpose-built tools that connect via clean APIs, not baked into the data layer.

This is a positive vision of what AI-assisted development looks like: a non-engineer with a clear idea and strong opinions about correctness, working with an AI that brings software engineering discipline. The result is, hopefully, useful infrastructure that sits at an underexplored intersection of commercial and public interest. The guiding principle is simple: all flourishing is mutual.

Please judge the output.

## License

Event data: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

Code: MIT

## Links

- [Neighborhood API spec](https://github.com/The-Relational-Technology-Project/neighborhood-api)
- [The Relational Technology Project](https://relationaltechproject.org)
- [API consumer guide](docs/consumer-guide.md)
- [AI-readable docs](https://commons.joinfiber.app/llms.txt)
