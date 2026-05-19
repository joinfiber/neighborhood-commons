# Consuming the Neighborhood Commons API

This document used to be a standalone consumer guide. As of the v2 release it's a pointer — the canonical Guide lives in `/llms.txt` (also surfaced as the homepage at `/`), and the machine-readable contract lives in `/openapi.json`.

## Where to read

- **The Spec** — [`/openapi.json`](https://neighborhood-commons.org/openapi.json) — machine-readable, authoritative. Generate your client from it.
- **The Guide** — [`/llms.txt`](https://neighborhood-commons.org/llms.txt) — narrative companion, explains *why* and *how*. Same content as the homepage at `/`, in document order.
- **The Log** — [`CHANGELOG.md`](https://github.com/joinfiber/neighborhood-commons/blob/master/CHANGELOG.md) — dated record of every contract-affecting change.

**Spec wins. Guide explains. Log dates.**

## Per-app integration briefs

For integrating into a specific app, this repo carries dedicated briefs that a Claude Code session in the respective app can pick up and audit against:

- [`docs/migration-brief-fiber.md`](migration-brief-fiber.md) — reader app, OCR/witnessed contribution path
- [`docs/migration-brief-merrie.md`](migration-brief-merrie.md) — publisher app for hosts/groups/venues
- [`docs/migration-brief-holler.md`](migration-brief-holler.md) — business interface
- [`docs/migration-brief-studio.md`](migration-brief-studio.md) — operator tool (ingestion, admin)

Each brief is self-contained: it points back at the canonical docs in this repo (CLAUDE.md, v2-migration-plan.md, future-considerations.md, classifieds.md) and tells a Claude Code session what to audit in the target app.

## Project context

For the project's mission, architecture, and operational rules, see [`CLAUDE.md`](../CLAUDE.md). For the v2 migration plan, see [`docs/v2-migration-plan.md`](v2-migration-plan.md). For the sustainability story, see [`docs/classifieds.md`](classifieds.md). For deferred decisions and their reasoning, see [`docs/future-considerations.md`](future-considerations.md).

## Quick orientation

If you've never touched the Commons before, the shortest path is:

1. Read the homepage at `/` — five typed atoms (places, organizations, events, broadcasts, lists), how they compose, what the substrate does and doesn't do.
2. Try a read: `curl "https://neighborhood-commons.org/api/v1/events?near=39.97,-75.14&radius_km=2"` — no key required.
3. If you want to write, sign up at the developer portal: [https://neighborhood-commons.org/developers/sign-up](https://neighborhood-commons.org/developers/sign-up) — see [§4 of the Guide](https://neighborhood-commons.org/llms.txt#4-writing-data).

That's the orientation. Everything else is in the Guide and the Spec.
