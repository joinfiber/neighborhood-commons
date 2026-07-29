# Quickstart — Publishing into the Commons

**Audience:** developer with no key yet who wants to land their first successful event POST.

The conceptual model is in [`docs/four-roles.md`](four-roles.md) — read that first if anything below feels arbitrary. The path from "no key" to "first 201 Created" is below, in order.

## From zero to first POST

Five steps. The whole sequence takes ~10 minutes of typing plus however long activation takes (typically same-day).

### Step 1 — Get a service-tier key

Service keys are issued through the developer portal, not the API. In your browser, go to **<https://neighborhood-commons.org/developers/sign-up>** and fill out the guided form: your email, app name, app URL, what you're building, and how publishers in your flow have authority over what they publish.

You verify via a one-time code emailed to you, and the dashboard then lands you on your new service-tier key. **Copy it immediately — it's shown once and isn't recoverable.** Reads work right away; writes return `403 KEY_PENDING` until activation (Step 2).

```bash
export COMMONS_BASE=https://neighborhood-commons.org/api/v1
export COMMONS_API_KEY=nc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Verify the key works for reads
curl -s "$COMMONS_BASE/events?limit=1" -H "X-API-Key: $COMMONS_API_KEY" | jq .meta
```

> The legacy `POST /service/register/*` curl endpoints were retired — they now return `410 ENDPOINT_RETIRED` pointing at the portal. Only the registration path moved; existing keys keep working.

### Step 2 — Wait for activation

A short one-time review by the Commons operator. Usually same-day. Email `hi@neighborhood-commons.org` if it stalls past 48 hours. You'll get a confirmation when your key is active.

You can validate activation completed:

```bash
# This returns 403 KEY_PENDING before activation; 201 (or a different error) after.
curl -X POST "$COMMONS_BASE/service/organizations" \
  -H "X-API-Key: $COMMONS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "test-org-please-delete"}'
```

(If a real org gets created in this test, delete it before continuing.)

### Step 3 — Create the venue (Place)

If your event happens at a venue that's not yet in the Commons, create it. Skip this step and use an existing place if one's already there.

```bash
curl -X POST "$COMMONS_BASE/service/places" \
  -H "X-API-Key: $COMMONS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Johnny Brenda'\''s",
    "googlePlaceId": "ChIJ-johnnybrendas-real-id",
    "address": {
      "streetAddress": "1201 N Frankford Ave",
      "addressLocality": "Philadelphia",
      "addressRegion": "PA",
      "postalCode": "19125",
      "addressCountry": "US"
    },
    "geo": { "latitude": 39.9743, "longitude": -75.1340 }
  }'
```

`geo` (latitude/longitude) is **required**; `address` and `googlePlaceId` are optional but recommended — the Place is idempotent on `googlePlaceId`, so sending it lets you safely re-run this step.

Note the returned `id` — you'll reference it from your organization in Step 4.

### Step 4 — Create + link your organization

```bash
curl -X POST "$COMMONS_BASE/service/organizations" \
  -H "X-API-Key: $COMMONS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Philly Chess Club",
    "tags": ["community", "chess"],
    "commercial": false,
    "primaryPlaceId": "<the-place-id-from-step-3>"
  }'
```

`POST /service/organizations` auto-links your key to the new org via `api_key_organization_links`. Note the returned `id` — that's your `organizerOrganizationId` in Step 5.

If your org already exists (operator created it, or another consumer did), use `POST /service/organizations/link` with the existing UUID instead.

### Step 5 — Publish the event

```bash
curl -X POST "$COMMONS_BASE/service/events" \
  -H "X-API-Key: $COMMONS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "organizerOrganizationId": "<the-org-id-from-step-4>",
    "name": "Tuesday Chess",
    "start": "2026-06-02T19:00:00-04:00",
    "end": "2026-06-02T22:00:00-04:00",
    "timezone": "America/New_York",
    "category": "community",
    "location": {
      "name": "Johnny Brenda'\''s",
      "place_id": "<google-place-id>"
    },
    "description": "Casual chess, all levels welcome.",
    "tags": ["chess", "weekly"]
  }'
```

Expected: `201 Created` with the new event object. The response carries the four-role provenance — organizer (your org), location (Johnny Brenda's), source.contributor (auto-filled from your app identity), source.method (`self_asserted` by default).

That's it. You can now PATCH `/service/events/:id`, DELETE it, or publish more.

## Conventions used above

Category slugs use **underscores** (`live_music`, `community`, `happy_hour`) consistently. The public API accepts both underscores and kebab-case (`live-music`) on the read side as a convenience, but write payloads should use the canonical underscore form — that's what the spec enum admits.

`source_method` defaults to `self_asserted` if omitted — the common case. The two other values (`witnessed`, `proxied`) describe different authority chains; the next section walks through them.

---

## The three authority paths

The conceptual model is in [`docs/four-roles.md`](four-roles.md). The runbook above used Path 1. Here are all three with copy-paste examples.

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
| `403 IMAGE_NOT_PERMITTED` on event with image | Organizer has no claimed owner account | See "Photo eligibility" below |
| `403 KEY_PENDING` | Self-registered key not yet activated | Email operator with the key's contact info |
| `400 VALIDATION_ERROR` on `source_method` | Trying to send `"proxied"` or a legacy value | Use `self_asserted` (default) or `witnessed` |
| Response shows `contributor: null` | Your key has no `brand_config.app_name` | Add the field (or set `contributor` explicitly per request) |

## Photo eligibility

Posting an event with an `image_url` carries a contributor warranty — someone has to be on the hook for the rights claim that the photo is licensable under CC BY 4.0. The Commons enforces this with a photo-eligibility gate: every event with an image must have an organizer whose `owner_account_id` references a claimed `portal_account` (`claimed_at` set or `auth_user_id` set).

Two ways to satisfy the gate:

1. **Per-organization claim** — the org's owner manually completed an OTP claim against `portal_accounts`. Suitable when the consumer app has a 1:1 publisher-to-account model.

2. **Trusted-tenant pattern** (recommended for publishing apps with many community publishers, like a CMS-shaped consumer):
   - The consumer's operator provisions one shared `portal_account` (the "tenant") at integration time.
   - The operator binds the consumer's API key to that tenant via `api_keys.tenant_account_id`.
   - Every organization the key creates via `POST /v1/service/organizations` inherits `owner_account_id` from the bound tenant — server-side, with no per-org claim required.

The tenant binding is set by the Commons operator at activation time; the consumer doesn't see or send it. If you're hitting `IMAGE_NOT_PERMITTED` consistently across many orgs, this is the pattern you want — email the operator and ask for tenant provisioning. The substrate-side mechanics are documented in [`migrations/084_api_key_tenant_account.sql`](../migrations/084_api_key_tenant_account.sql) and the "Trusted-tenant pattern" subsection of [`CLAUDE.md`](../CLAUDE.md).

Witnessed events bypass the gate: the collective publishing identity (`Fiber Community`, etc.) is the warrantor, not a claimed account.

## Next steps

- [`docs/four-roles.md`](four-roles.md) — the conceptual model the substrate enforces.
- [`docs/provenance.md`](provenance.md) — the type-general `method` doctrine that spans Events, Organizations, Broadcasts, Lists.
- [`docs/stability-promise.md`](stability-promise.md) — what we promise (and don't) about the contract over time.
- [`public/openapi.json`](../public/openapi.json) — the spec itself; the SDK is generated from this.
- [`public/llms.txt`](../public/llms.txt) — the Commons Contract Guide, with the full narrative context.
