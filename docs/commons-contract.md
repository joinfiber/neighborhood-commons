# Neighborhood Commons — Contract

> Events are public facts. The Neighborhood Commons is a central distribution point for those facts.

This document is the canonical reference for any application that reads from or writes to the Neighborhood Commons. If your code disagrees with this document, your code has a bug. If this document disagrees with the codebase, file an issue.

---

## What Is This?

A shared, open database of neighborhood events. Not an app — infrastructure.

An event is a public fact: something happens, somewhere, at some time. The Commons stores those facts and serves them. It doesn't editorialize, personalize, recommend, or curate. It doesn't know what app you're building. It doesn't care.

Any application can read event data. Verified publishers can write. The data is licensed CC BY 4.0. That's the deal.

### Design Principles

The Commons is **thin**. It stores events and serves them. Curation, social features, recommendations, user accounts, ingestion pipelines — all of that belongs in the apps that build on top. The Commons is plumbing.

The Commons is **durable**. The shapes in this document don't change with the winds. They change when the culture of events changes — a new category of gathering, a new dimension of accessibility. Those changes are rare and deliberate. If you build against this contract today, it should work next year.

The Commons is **authoritative**. Every event response is self-contained: name, place, time, description, cost, category, image, recurrence. No implicit knowledge, no extra joins, no undocumented carry-forward. A developer who's been shipping for 20 years and another sitting down for a weekend project should both arrive at the same understanding.

---

## The Event

An event has these fields. This is the complete set.

### Required

| Field | Type | Constraints | What It Is |
|-------|------|-------------|------------|
| `name` | string | 1–200 chars | What's happening |
| `start` | ISO 8601 with offset | e.g. `2026-04-15T19:00:00-04:00` | When it starts |
| `timezone` | IANA timezone | e.g. `America/New_York` | Authoritative for DST rules |
| `category` | slug | One of the 20 category slugs | What kind of event |
| `location.name` | string | 1–200 chars | Where it happens |

### Optional

| Field | Type | Constraints | What It Is |
|-------|------|-------------|------------|
| `end` | ISO 8601 with offset | | When it ends |
| `description` | string | max 2000 chars | Factual description |
| `cost` | string | max 100 chars | Price: "Free", "$10", "$5–15" |
| `url` | URL | max 2000 chars | Event page or ticket link |
| `image_url` | URL | | Cover image (downloaded, re-encoded, stored by Commons) |
| `location.address` | string | max 500 chars | Street address (enables geocoding) |
| `location.lat` | number | -90 to 90 | Latitude (enables region resolution) |
| `location.lng` | number | -180 to 180 | Longitude |
| `location.place_id` | string | max 500 chars | External place identifier |
| `tags` | string[] | max 15 tags | Experience/access descriptors from the taxonomy |
| `wheelchair_accessible` | boolean | | Accessibility flag |
| `external_id` | string | max 500 chars | Your system's ID (used for dedup) |

### What You Get Back

When you read an event from the Commons, this is the shape. Every field is present. Absent values are `null` or `[]`, never omitted.

```json
{
  "id": "uuid",
  "name": "Punk Rock Karaoke",
  "start": "2026-03-30T20:00:00-04:00",
  "end": "2026-03-30T22:00:00-04:00",
  "timezone": "America/New_York",
  "description": "Weekly karaoke with a punk twist.",
  "category": ["karaoke"],
  "place_id": null,
  "location": {
    "name": "Tattooed Moms",
    "address": "530 South Street, Philadelphia PA 19147",
    "lat": 39.9428,
    "lng": -75.1534
  },
  "url": "https://example.com/event",
  "images": ["https://r2.commons.joinfiber.app/..."],
  "organizer": {
    "name": "Tattooed Moms",
    "phone": null
  },
  "cost": "Free",
  "series_id": null,
  "series_instance_number": null,
  "series_instance_count": null,
  "start_time_required": true,
  "tags": ["all-ages", "free", "themed"],
  "wheelchair_accessible": null,
  "runtime_minutes": null,
  "content_rating": null,
  "showtimes": null,
  "recurrence": null,
  "source": {
    "publisher": "Tattooed Moms",
    "collected_at": "2026-03-30T17:00:00Z",
    "method": "portal",
    "license": "CC BY 4.0"
  }
}
```

**Notes on specific fields:**

- **`category`** is always a one-element array. Internal storage uses underscore keys (`live_music`); API responses use kebab-case slugs (`live-music`). Both are accepted on input.
- **`images`** is always an array. Currently holds zero or one URL. All images are re-encoded through Sharp (metadata stripped, resized to 1200px max, JPEG output) and stored on Cloudflare R2.
- **`organizer.phone`** is always `null`. Reserved for future use.
- **`source.method`** is one of `portal`, `import`, or `api`.
- **`source.license`** is always `CC BY 4.0`.
- **`recurrence`** is `null` for one-off events, or `{ "rrule": "FREQ=WEEKLY" }` (iCal RRULE format) for recurring events. Bounded rules include `;COUNT=N`.
- **`series_id`** links instances of the same recurring event. Each instance is a self-contained event row — consumers never need to expand a series.
- **`start_time_required`** controls browse visibility. When `true` (default), the event disappears from feeds at start time. When `false`, the event remains visible until `end` (or start + 3 hours if no end time). Use `false` for all-day events, markets, exhibits.
- **`runtime_minutes`**, **`content_rating`**, **`showtimes`** are film-specific fields. `null` for all other categories.

---

## Reading Events

**Base URL:** `https://commons.joinfiber.app/api/v1`
**Authentication:** None required. Optional API key (`X-API-Key` header) for a dedicated rate limit bucket.
**Rate limit:** 1000 requests/hour per IP (or per API key if provided).

### `GET /events`

List published, upcoming events. Paginated.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `start_after` | `YYYY-MM-DD` | | Events starting after this date (UTC boundary) |
| `start_before` | `YYYY-MM-DD` | | Events starting before this date (UTC boundary) |
| `category` | slug | | Filter by category (e.g. `live-music`) |
| `tag` | string or string[] | | Filter by tags (AND logic — event must have all) |
| `q` | string (max 200) | | Text search on name + description |
| `near` | `lat,lng` | | Geographic center point |
| `radius_km` | 0.1–100 | 10 | Search radius in km (requires `near`) |
| `collapse_series` | `true`/`false` | `false` | Show only the nearest instance per recurring series |
| `series_id` | UUID | | Events from a specific series |
| `group_id` | UUID | | Events from a specific group |
| `recurring` | `true`/`false` | | Filter recurring vs one-off events |
| `limit` | 1–200 | 50 | Page size |
| `offset` | 0+ | 0 | Pagination offset |

**Response envelope:**

```json
{
  "meta": {
    "total": 142,
    "limit": 50,
    "offset": 0,
    "spec": "neighborhood-api-v0.2",
    "license": "CC-BY-4.0"
  },
  "events": [ ... ]
}
```

### `GET /events/:id`

Single event by UUID. Returns `{ "event": { ... } }`.

For series events, includes `series_instance_count` (total instances in the series).

### `GET /events.ics`

iCalendar feed (RFC 5545). Up to 200 upcoming events. DST-aware VTIMEZONE blocks. Series deduplicated to one instance with RRULE.

### `GET /events.rss`

RSS 2.0 feed. Up to 50 upcoming events. Series deduplicated.

### `GET /accounts`

Search venue/business accounts.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `q` | | Text search on business name, venue name, address |
| `limit` | 20 (max 100) | Page size |
| `offset` | 0 | Pagination offset |

### `GET /accounts/:idOrSlug`

Single account by UUID or slug. Returns the account with `logo_url`, `cover_image_url`, `regular_programming` (recurring series, deduplicated) and `upcoming_events` (one-off future events).

**Venue images:** Accounts have two image fields. `logo_url` is the venue's branding mark. `cover_image_url` is a photo of the venue — its facade, interior, stage. Both are self-representation by the venue, not editorial. Both are available to every consumer.

**Slug algorithm** (deterministic, derived from `business_name`, never stored):
```
lowercase → remove apostrophes (smart and straight) → non-alphanumeric → hyphens → trim hyphens
```
`"Johnny Brenda's"` → `johnny-brendas`

### `GET /meta`

Feed identity, stewards, data sources, license. Spec version: `neighborhood-api-v0.2`.

### `GET /meta/regions`

Active geographic regions with timezone and center coordinates.

### `GET /meta/categories`

Categories with current event counts. Sorted by count descending.

---

## Contributing Events

**Base URL:** `https://commons.joinfiber.app/api/v1/contribute`
**Authentication:** `X-API-Key` header (required).

The Contribute API is how external applications push events into the Commons. You get an API key, you submit events, they go through validation and (depending on your tier) either publish immediately or enter a review queue.

### Tiers

| Tier | Auto-publish | Hourly limit | Daily limit |
|------|-------------|-------------|-------------|
| `pending` | No (enters review queue) | 20 | 100 |
| `verified` | Yes | 100 | 500 |
| `trusted` | Yes | 500 | 2000 |

New keys start at `pending`. Tier upgrades are manual.

### Venues

Venues are shared resources in the Commons. Any contributor can create a venue; no one owns it. The venue exists so that events can be attached to a business identity. If the real operator wants control later, they claim the venue (future feature).

#### `POST /contribute/venues`

Create a venue. If a venue with the same derived slug already exists, the existing venue is returned.

**Request body:**
```json
{
  "name": "Tattooed Moms",
  "address": "530 South Street, Philadelphia PA 19147",
  "lat": 39.9428,
  "lng": -75.1534,
  "phone": "215-238-9880",
  "website": "https://tattooedmomphilly.com"
}
```

`name` and `address` are required. Everything else is optional. Address is geocoded via Nominatim if no coordinates provided.

**Response:** `201` (created) or `200` (existing venue returned).
```json
{
  "venue": { "id": "uuid", "name": "Tattooed Moms", "slug": "tattooed-moms", "address": "530 South Street..." },
  "created": true
}
```

#### `GET /contribute/venues`

Search venues. Query params: `q` (text search), `limit` (max 100, default 20), `offset`.

### Events

#### `POST /contribute`

Submit a single event. `name`, `start`, `timezone`, `category`, and `location.name` are required.

```json
{
  "name": "Karaoke Night",
  "start": "2026-04-01T20:00:00-04:00",
  "timezone": "America/New_York",
  "category": "karaoke",
  "location": {
    "name": "Tattooed Moms",
    "address": "530 South Street, Philadelphia PA 19147"
  },
  "end": "2026-04-01T23:00:00-04:00",
  "description": "Weekly karaoke night",
  "cost": "Free",
  "url": "https://example.com/event",
  "tags": ["all-ages", "free"],
  "recurrence": "FREQ=WEEKLY",
  "instance_count": 12,
  "venue_id": "uuid",
  "external_id": "my-system-12345"
}
```

**Additional fields (beyond the core event fields):**

| Field | Type | Description |
|-------|------|-------------|
| `recurrence` | RRULE string | Recurrence pattern (see Recurrence section) |
| `instance_count` | 0–52 | Override instance count. Takes precedence over `COUNT` in the RRULE. |
| `venue_id` | UUID | Attach event to a venue created via `POST /contribute/venues` |

**Response (201) — single event:**
```json
{
  "event": {
    "id": "uuid",
    "status": "published",
    "source": { "publisher": "Your Key Name", "method": "api" }
  }
}
```

**Response (201) — recurring event:**
```json
{
  "event": {
    "series_id": "uuid",
    "instance_count": 12,
    "instance_ids": ["uuid", "uuid", "..."],
    "status": "published",
    "source": { "publisher": "Your Key Name", "method": "api" }
  }
}
```

**Behaviors:**
- Address geocoded via Nominatim if no lat/lng provided.
- Region resolved from coordinates. If outside all regions, assigned to the default region.
- `image_url` downloaded, re-encoded through Sharp, uploaded to R2 (async — does not block response).
- Tags validated against the category's allowed set. Invalid tags silently removed.
- `external_id` enforces uniqueness per API key. Duplicate → `409 DUPLICATE`.
- `url` validated against an approved domain list (ticketing platforms, social media, venue sites, etc.). Unapproved domains → `400`. Tracking parameters (`utm_*`, `fbclid`, etc.) are stripped automatically.
- Recurring events are expanded at creation time into individual event rows sharing a `series_id`. Each instance counts against rate limits.

#### `POST /contribute/batch`

Submit up to 50 events in one request. Body: `{ "events": [ ... ] }`. Each event in the array supports the same fields as single submission, including `recurrence`.

Batch size counts against your hourly/daily limits.

**Response codes:**
- `201` — all succeeded
- `207` — partial success (per-item results with `index`, `id` or `error`)
- `400` — all failed

#### `PATCH /contribute/:id`

Edit an event you submitted. Ownership enforced — you can only edit your own events. All fields are optional.

```json
{
  "name": "Updated Karaoke Night",
  "cost": "$5",
  "tags": ["21-plus", "late-night"]
}
```

Cannot change recurrence pattern. To change recurrence, delete and recreate.

Returns `{ "updated": true, "id": "uuid" }`.

#### `GET /contribute/mine`

List events you submitted. Filter by `status` (`published`, `pending_review`, `unpublished`). Paginated with `limit` (max 200) and `offset`.

Returns a simplified shape: `id`, `name`, `start`, `end`, `timezone`, `venue`, `category`, `status`, `external_id`, `created_at`.

#### `DELETE /contribute/:id`

Delete an event you submitted. Ownership enforced — you can only delete your own.

---

## Service API

**Base URL:** `https://commons.joinfiber.app/api/v1/service`
**Authentication:** `X-API-Key` header (service tier only).

The Service API is for trusted tools — admin dashboards, import pipelines, partner applications. A service key grants platform-operator-level access. Keys are issued manually.

### Accounts

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/accounts` | List all accounts with event counts |
| `GET` | `/accounts/:id` | Single account with events |
| `POST` | `/accounts` | Create account |
| `PATCH` | `/accounts/:id` | Update account fields |
| `POST` | `/accounts/:id/cover-image` | Upload cover image (base64 or URL) |

### Events

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/events` | List events (filter by status, source_method) |
| `GET` | `/events/:id` | Single event with account |
| `POST` | `/events` | Create event (one-off or recurring) |
| `PATCH` | `/events/:id` | Update event |
| `DELETE` | `/events/:id` | Delete event |
| `PATCH` | `/events/batch` | Bulk update up to 200 events |
| `POST` | `/events/:id/image` | Upload cover image (base64, max 14MB) |

**Service API event creation uses separate date/time fields:**

```json
{
  "account_id": "uuid",
  "title": "...",
  "venue_name": "...",
  "address": "...",
  "event_date": "YYYY-MM-DD",
  "start_time": "HH:MM",
  "end_time": "HH:MM",
  "category": "live_music",
  "event_timezone": "America/New_York",
  "recurrence": "weekly",
  "instance_count": 12,
  "description": "...",
  "price": "...",
  "tags": ["outdoor", "free"],
  "ticket_url": "https://..."
}
```

This is different from the Contribute API, which uses a single ISO 8601 `start` field. The Service API combines `event_date` + `start_time` + `event_timezone` internally.

### Stats

`GET /stats` — platform-wide metrics: account counts, event counts, category distribution.

### API Keys

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api-keys` | List all keys with usage stats |
| `PATCH` | `/api-keys/:id` | Update tier, name, status, contact email |

---

## Recurrence

Recurring events are expanded at creation time into N individual event rows sharing a `series_id`. Each instance is self-contained — consumers never expand a series.

### RRULE (Contribute API input)

The Contribute API accepts standard iCal RRULE strings (RFC 5545) for recurrence. The Commons supports this subset:

| RRULE | What it means |
|-------|--------------|
| `FREQ=DAILY` | Every day |
| `FREQ=WEEKLY` | Same day each week |
| `FREQ=WEEKLY;INTERVAL=2` | Every two weeks |
| `FREQ=MONTHLY` | Same date each month |
| `FREQ=MONTHLY;BYDAY=2FR` | 2nd Friday of each month |
| `FREQ=WEEKLY;BYDAY=MO,WE,FR` | Every Monday, Wednesday, and Friday |

Append `;COUNT=N` to any pattern to set the instance count (e.g. `FREQ=WEEKLY;COUNT=12` for 12 weeks).

Anything outside this subset returns `400`. The error message lists the supported patterns.

### Internal format (Service API)

The Service API uses a simpler internal format for recurrence:

| Internal | RRULE equivalent |
|----------|-----------------|
| `none` | One-off event |
| `daily` | `FREQ=DAILY` |
| `weekly` | `FREQ=WEEKLY` |
| `biweekly` | `FREQ=WEEKLY;INTERVAL=2` |
| `monthly` | `FREQ=MONTHLY` |
| `ordinal_weekday:N:day` | `FREQ=MONTHLY;BYDAY=NXX` |
| `weekly_days:day,day` | `FREQ=WEEKLY;BYDAY=XX,XX` |

Both formats map to the same set of patterns. API responses always use RRULE format in the `recurrence.rrule` field.

### Instance Count

`instance_count` controls how many future instances are generated (0–52). When omitted, defaults vary by pattern (e.g. daily→180, weekly→26, monthly→6). When set to 0, uses "ongoing" defaults.

If both `instance_count` in the request body and `COUNT` in the RRULE are present, the body field takes precedence.

Bounded rules include `;COUNT=N` in the RRULE output.

---

## Categories

20 categories. Organized by activity posture.

| Slug | Label | Group |
|------|-------|-------|
| `live-music` | Live Music | Performance |
| `dj-dance` | DJ & Dance | Performance |
| `comedy` | Comedy | Performance |
| `theatre` | Theatre | Performance |
| `open-mic` | Open Mic | Performance |
| `karaoke` | Karaoke | Performance |
| `art-exhibit` | Art & Exhibits | Arts & Culture |
| `film` | Film | Arts & Culture |
| `literary` | Literary | Arts & Culture |
| `tour` | Tour | Arts & Culture |
| `happy-hour` | Happy Hour | Food & Drink |
| `market` | Market & Pop-up | Food & Drink |
| `fitness` | Fitness | Active |
| `sports` | Sports & Rec | Active |
| `outdoors` | Outdoors & Nature | Active |
| `class` | Class & Workshop | Learning & Social |
| `trivia-games` | Trivia & Games | Learning & Social |
| `kids-family` | Kids & Family | Learning & Social |
| `community` | Community | Civic |
| `spectator` | Spectator | Civic |

API responses use kebab-case (`live-music`). Internal storage uses underscore keys (`live_music`). Both accepted on input.

---

## Tags

30 experience/access tags across 6 dimensions. Tags describe the experience of attending — "Can I go? What's the space like? What's the energy?" — not the content.

### Access — "Can I go?"

`all-ages`, `18-plus`, `21-plus`, `family-friendly`, `free`, `cover-charge`, `donation-based`, `na-friendly`, `byob`, `dog-friendly`, `cash-only`

### Logistics — "How do I attend?"

`registration-required`, `drop-in`, `limited-spots`, `solo-friendly`, `bring-gear`

### Setting — "What's the space like?"

`outdoor`, `rooftop`, `seated`

### Vibe — "What's the energy?"

`chill`, `high-energy`, `late-night`, `beginner-friendly`, `themed`, `competitive`

### Format — "What happens there?"

`hands-on`, `tasting`, `acoustic`, `participatory`, `volunteer`

### Rules

- Each category has an approved subset of tags. Invalid tags for a category are silently removed on write. The full mapping is in `src/lib/tags.ts`.
- Age tags (`all-ages`, `18-plus`, `21-plus`) are mutually exclusive. If multiple are submitted, only the first is kept.
- Max 15 tags per event.

---

## Webhooks

**Base URL:** `https://commons.joinfiber.app/api/v1/webhooks`
**Authentication:** `X-API-Key` header (required).

Subscribe to event changes. The Commons sends HTTPS POST requests to your endpoint.

### Event Types

`event.created`, `event.updated`, `event.deleted`, `event.series_created`

### Signing

Every delivery is signed with HMAC-SHA256. The signing secret is returned **once** when you create the subscription — store it.

**Header:** `X-NC-Signature: sha256=<hex>`

Verify by computing `HMAC-SHA256(secret, request_body)` and comparing to the header value.

### Retry

Failed deliveries are retried up to 3 times: after 1 minute, 5 minutes, 25 minutes.

10 consecutive failures → subscription paused. Re-activate via `PATCH /webhooks/:id` with `status: "active"`.

### Limits

5 subscriptions per API key. Webhook URLs must be HTTPS and are validated for SSRF (private IPs, cloud metadata endpoints blocked).

---

## Regions

Every event belongs to a geographic region. Regions are PostGIS polygons (cities, neighborhoods).

When an event is created:
1. If coordinates are provided → `find_user_region(lng, lat)` resolves the containing region
2. If only an address is provided → geocoded via Nominatim (OpenStreetMap), then region resolved
3. Fallback → default region

**Region must never be null.** An event without a region won't appear in location-filtered feeds.

---

## Errors

One shape. Always.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable explanation"
  }
}
```

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `VALIDATION_ERROR` | 400 | Input failed validation |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` | 403 | Authenticated but not allowed |
| `NOT_FOUND` | 404 | Resource doesn't exist (or suspended — don't leak) |
| `DUPLICATE` | 409 | Duplicate external_id |
| `RATE_LIMIT` | 429 | Too many requests |
| `SERVER_ERROR` | 500 | Our fault (no internals exposed) |

---

## Visibility Rules

Published events appear in feeds according to these rules:

1. **Status is `published`** — draft, pending_review, unpublished events are excluded
2. **Account is not suspended** — events from suspended accounts return 404, not 403
3. **Time gate:**
   - `start_time_required = true` (default): visible until start time, hidden after
   - `start_time_required = false`: visible until end time, or start + 3 hours if no end time
4. **Region filter:** when a consumer provides coordinates, events are filtered to the matching region

---

## License

All data is published under **CC BY 4.0**. Consumers must attribute the source. The `source` object in every event response provides provenance.

---

## For Builders

Practical guidance for anyone writing code against the Commons.

1. **Start with the Read API.** No auth needed. `GET /events` and go.
2. **To write, use the Contribute API.** Create venues, post events (including recurring), edit your submissions. The Service API is for platform operators only.
3. **Always provide a timezone.** `America/New_York` is the default but must be explicit on write.
4. **Always provide a location name.** Address enables geocoding. Coordinates enable region resolution. Without a region, your events won't appear in location-filtered feeds (which is most feeds).
5. **Create venues before events.** `POST /contribute/venues` with name + address. Use the returned `venue_id` when creating events to link them to a business identity.
6. **Use `external_id` for dedup.** If your system has its own event IDs, pass them. The Commons will 409 on duplicates per API key.
7. **Recurrence uses RRULE on the Contribute API.** `"recurrence": "FREQ=WEEKLY;COUNT=12"`. The Service API uses an internal format. Both produce the same result.
8. **Recurrence creates instances at write time.** You submit the pattern and count; the Commons generates N individual rows. You never expand a series.
9. **Images are re-encoded.** Pass a URL; the Commons downloads, strips metadata, re-encodes to JPEG via Sharp, uploads to R2. The response contains the final URL.
10. **Tags are validated per category.** Invalid tags for the category are silently removed. Check the mapping if you're getting fewer tags back than you sent.
11. **The venue slug is derived, not stored.** Compute it from `business_name` using the algorithm above if you need it.
12. **URLs are sanitized.** Tracking parameters are stripped. The Contribute API enforces a domain allowlist on `url` fields.
13. **Webhooks use `X-NC-Signature`, not `X-Webhook-Signature`.** The signing secret is shown once on creation.
14. **The Service API uses different input fields than the Contribute API.** Service: `event_date` + `start_time` (separate). Contribute: `start` (combined ISO 8601). Don't mix them up.
