# Neighborhood Commons

Open neighborhood event data. One post, every audience.

Neighborhood Commons is a public data service where businesses post events — concerts, comedy, markets, community gatherings — and every app in the city can show them. It implements the [Neighborhood API](https://github.com/The-Relational-Technology-Project/neighborhood-api) spec, an open format for sharing local events, assets, dreams, plans, and notices across community tools.

This is infrastructure, not an application. The data is the product.

**Live at [commons.joinfiber.app](https://commons.joinfiber.app)**

## What's here

- **Public API** — Neighborhood API v0.2 compliant. No auth required to read. `GET /api/v1/events`
- **Portal** — React SPA where business owners sign up, post events, done. Same-origin, no CORS complexity.
- **Admin dashboard** — Curation tools for platform operators.
- **Feeds** — iCal (`.ics`) and RSS (`.rss`) for calendar apps and feed readers.
- **Webhooks** — Real-time push notifications for downstream consumers.
- **Self-service API keys** — Developers register via email OTP, get a key, start building.

## Quick start

```bash
# Clone and install
git clone https://github.com/joinfiber/neighborhood-commons.git
cd neighborhood-commons
npm install
cd portal && npm install && cd ..

# Set up environment (see .env.example or CLAUDE.md for full list)
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

## Project structure

```
src/
  routes/        # API endpoints (v1, portal, admin, webhooks, meta, etc.)
  lib/           # Shared logic (transforms, validation, helpers)
  middleware/    # Auth, rate limiting, error handling
  config.ts      # Environment validation (Zod)
  app.ts         # Express app factory
portal/          # React SPA (business portal)
tests/           # Vitest test suite
migrations/      # Sequential SQL migrations (Supabase)
docs/            # Consumer guide, email templates
public/          # llms.txt (AI-readable API docs)
CLAUDE.md        # Development guide and architecture decisions
```

## Architecture

Single Express server serving both the API and the portal SPA. 8 runtime dependencies. Deployed to Railway via multi-stage Dockerfile.

- **Database**: Supabase (PostgreSQL + PostgREST + Row Level Security)
- **Images**: Cloudflare R2, re-encoded through Sharp on upload
- **Auth**: Supabase email OTP for portal; API keys for developers; service keys for internal sync
- **Validation**: Zod on every input, no exceptions
- **Rate limiting**: Per-route, explicit — browse (30/min), write (10/min), API key (1000/hr)

## Testing

```bash
npm run test:run
```

The test suite catches real bugs, not hypothetical ones:

- **Schema alignment** — Statically scans every Supabase query and verifies column names exist in the database. Supabase/PostgREST silently returns null for nonexistent columns; this test turns silent data loss into loud failures. Found 6 real bugs on its first run.
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

This is a positive vision of what AI-assisted development looks like: a non-engineer with a clear idea and strong opinions about correctness, working with an AI that brings software engineering discipline. The result here is, hopefully, useful infrastructure that sits at an underexplored intersection of commercial and public interest. The guiding principle is simple: all flourishing is mutual.

Please judge the output.

## License

Event data: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

Code: MIT

## Links

- [Neighborhood API spec](https://github.com/The-Relational-Technology-Project/neighborhood-api)
- [The Relational Technology Project](https://relationaltechproject.org)
- [API consumer guide](docs/consumer-guide.md)
- [AI-readable docs](https://commons.joinfiber.app/llms.txt)
