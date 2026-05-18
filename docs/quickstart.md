# Quickstart — Publishing into the Commons

**Audience:** developer who has a service-tier API key and an organization linked to it. Wants to publish events.

If you don't have a key yet, see [`docs/onboarding-redesign.md`](onboarding-redesign.md) for the planned self-service flow, or email `hi@neighborhood-commons.org` for the current operator-mediated path.

This doc walks through the three event-creation authority paths, with copy-paste examples for each. The conceptual model is in [`docs/four-roles.md`](four-roles.md) — read that first if anything below feels arbitrary.

## Setup

```bash
export COMMONS_API_KEY=nc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export COMMONS_BASE=https://neighborhood-commons.org/api/v1
```

Confirm the key works:

```bash
curl -s "$COMMONS_BASE/events?limit=1" -H "X-API-Key: $COMMONS_API_KEY" | jq .
```

You should see a `{ events: [...], meta: {...} }` response. If you get `401 INVALID_API_KEY` or `403 KEY_PENDING`, fix that before continuing.

## Path 1 — Self-asserted (the common case)

Use when: an organization you represent is publishing an event they're running.

Prereq: your key is linked to the organizer organization via `api_key_organization_links`. The org creation endpoint auto-links; for existing orgs, call `POST /v1/service/organizations/link` once.

```bash
curl -X POST "$COMMONS_BASE/service/events" \
  -H "X-API-Key: $COMMONS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "organizerOrganizationId": "00000000-0000-0000-0000-000000000001",
    "name": "Tuesday Chess",
    "start": "2026-06-02T19:00:00-04:00",
    "end": "2026-06-02T22:00:00-04:00",
    "timezone": "America/New_York",
    "category": "community",
    "location": {
      "name": "Johnny Brenda's",
      "address": "1201 N Frankford Ave, Philadelphia, PA",
      "place_id": "ChIJ-johnnybrendas-here"
    },
    "description": "Casual chess, all levels welcome.",
    "tags": ["chess", "weekly"]
  }'
```

What happens server-side:

- `source_method` defaults to `self_asserted` (you didn't set it).
- `source.contributor.name` auto-fills from your key's brand identity, so the response shows `"contributor": { "name": "<your app>", "url": null }` without you having to send the field.
- `organizer.name` reads from the joined organization row (here: "Philly Chess Club").
- `source.url` is null (this is a first-party assertion, not a proxied page).

A successful response is `201 Created`:

```json
{
  "event": {
    "id": "...",
    "name": "Tuesday Chess",
    "start": "2026-06-02T19:00:00-04:00",
    "...": "...",
    "organizer": {
      "id": "00000000-0000-0000-0000-000000000001",
      "slug": "philly-chess-club",
      "name": "Philly Chess Club",
      "verified": true,
      "phone": null
    },
    "location": { "name": "Johnny Brenda's", "address": "...", "lat": 39.97, "lng": -75.13 },
    "source": {
      "method": "self_asserted",
      "url": null,
      "contributor": { "name": "Your App", "url": null },
      "collected_at": "2026-05-15T12:34:56.000Z",
      "license": "CC BY 4.0"
    }
  }
}
```

A consumer rendering this event from a feed sees: *"Tuesday Chess — Philly Chess Club — at Johnny Brenda's — via Your App."*

## Path 2 — Witnessed (collective-evidence path)

Use when: you observed an event in the world (a flyer, a sign, a window poster) and you're reporting it under a collective identity that your app maintains. There's no first-party authority — there's evidence.

Prereq: your key has `witness_authority = true` (granted at activation; rare). The organizer must be your app's collective organization (e.g. "Fiber Community").

```bash
curl -X POST "$COMMONS_BASE/service/events" \
  -H "X-API-Key: $COMMONS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "organizerOrganizationId": "00000000-0000-0000-0000-fibercommunity",
    "source_method": "witnessed",
    "name": "Open Mic at Cafe Walnut",
    "start": "2026-06-05T19:00:00-04:00",
    "timezone": "America/New_York",
    "category": "live_music",
    "location": {
      "name": "Cafe Walnut",
      "address": "703 Walnut St, Philadelphia, PA"
    },
    "description": "Sign-up at the bar, $5 cover."
  }'
```

Key differences from path 1:

- `source_method` is explicit (`"witnessed"`). Without it, the default `self_asserted` would fail the witness-authority gate.
- `organizerOrganizationId` points at your collective, not the venue. The event is attributed to "Fiber Community" (or whatever your collective is named), not Cafe Walnut.
- Evidence is held operationally (typically an image of the flyer, stored separately); the Commons does not require the URL to be public.

In the response, `source.method = "witnessed"`. Consumers reading the four-role frame typically suppress the "via X" line for witnessed events — the organizer (collective) is structurally the same entity as the contributor, so *"Fiber Community via Fiber"* would be redundant.

## Path 3 — Proxied (reserved for internal pipelines)

Use when: a pipeline tool faithfully extracts an event from a public URL (a venue's calendar page, an RSS feed, a CSV from a city registry).

**You probably won't write code against this path.** `source_method = "proxied"` is not accepted by the public service API today — it's reserved for internal operator pipelines. The enum value exists in the spec because legacy ingestion rows have it; if you're not a Commons operator running a scraper, ignore the value.

What you'll see on the read side:

```json
{
  "source": {
    "method": "proxied",
    "url": "https://example.com/calendar",
    "contributor": { "name": "public-facts", "url": null },
    "collected_at": "...",
    "license": "CC BY 4.0"
  }
}
```

The `url` carries the original page for transparency. Consumers can render *"Friday Show — Johnny Brenda's — via public-facts"* (the contributor's editorial public name) and deep-link the contributor splash to the source URL.

## Reading: filter by authority path

All three methods appear in the public events feed by default. To filter:

```bash
# Only first-party-asserted events
curl "$COMMONS_BASE/events?source_method=self_asserted" -H "X-API-Key: $COMMONS_API_KEY"

# Only witnessed events
curl "$COMMONS_BASE/events?source_method=witnessed" -H "X-API-Key: $COMMONS_API_KEY"

# Only proxied (legacy / pipeline-ingested) events
curl "$COMMONS_BASE/events?source_method=proxied" -H "X-API-Key: $COMMONS_API_KEY"
```

Consumers building public-facing UI typically choose which methods to surface based on the trust their audience expects. A high-rigor app might show only `self_asserted`; a discovery feed might show all three with appropriate labeling.

## SDK equivalents

If you're using the [`neighborhood-commons`](https://www.npmjs.com/package/neighborhood-commons) SDK, the same three paths look like:

```ts
import { createCommonsClient } from "neighborhood-commons";

const commons = createCommonsClient({ apiKey: process.env.COMMONS_API_KEY });

// Path 1 — self-asserted (default)
await commons.POST("/service/events", {
  body: {
    organizerOrganizationId: "00000000-0000-0000-0000-000000000001",
    name: "Tuesday Chess",
    start: "2026-06-02T19:00:00-04:00",
    timezone: "America/New_York",
    category: "community",
    location: { name: "Johnny Brenda's" },
  },
});

// Path 2 — witnessed
await commons.POST("/service/events", {
  body: {
    organizerOrganizationId: "00000000-0000-0000-0000-fibercommunity",
    source_method: "witnessed",
    name: "Open Mic at Cafe Walnut",
    start: "2026-06-05T19:00:00-04:00",
    timezone: "America/New_York",
    category: "live_music",
    location: { name: "Cafe Walnut" },
  },
});
```

The SDK types enforce the `source_method` enum and required fields at compile time. The shape is symmetric with the read shape: same field names, same structure.

## Common gotchas

| Symptom | Likely cause | Fix |
|---|---|---|
| `403 NOT_LINKED` on POST | Your key isn't linked to the organizer org | `POST /v1/service/organizations/link` with the organizer's UUID |
| `403 INSUFFICIENT_TIER` on witnessed | Your key doesn't have `witness_authority` | Email operator to request it (rare grant) |
| `403 IMAGE_NOT_PERMITTED` on event with image | Organizer has no claimed owner account | Trusted-tenant binding required — see [`CLAUDE.md`](../CLAUDE.md#trusted-tenant-pattern) |
| `403 KEY_PENDING` | Self-registered key not yet activated | Email operator with the key's contact info |
| `400 VALIDATION_ERROR` on `source_method` | Trying to send `"proxied"` or a legacy value | Use `self_asserted` (default) or `witnessed` |
| Response shows `contributor: null` | Your key has no `brand_config.app_name` | Add the field (or set `contributor` explicitly per request) |

## Next steps

- [`docs/four-roles.md`](four-roles.md) — the conceptual model the substrate enforces.
- [`docs/provenance.md`](provenance.md) — the type-general `method` doctrine that spans Events, Organizations, Broadcasts, Lists.
- [`docs/stability-promise.md`](stability-promise.md) — what we promise (and don't) about the contract over time.
- [`public/openapi.json`](../public/openapi.json) — the spec itself; the SDK is generated from this.
- [`public/llms.txt`](../public/llms.txt) — the Commons Contract Guide, with the full narrative context.
