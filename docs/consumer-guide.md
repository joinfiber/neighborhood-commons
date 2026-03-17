# Consuming the Neighborhood Commons API

This guide is for developers (or Claude Code instances) building apps that pull event data from the Neighborhood Commons.

## Base URL

```
https://commons.joinfiber.app
```

## No Authentication Required

The API is fully public. No API key, no account, no token. Just make HTTP requests.

An optional `X-API-Key` header gives you a dedicated rate limit bucket (useful if you share an IP with other consumers). Without it, you get 1000 requests/hour per IP.

## Endpoints

### List Events

```
GET /api/v1/events
```

Returns upcoming published events in Neighborhood API v0.2 format.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `start_after` | `YYYY-MM-DD` | Events starting after this date |
| `start_before` | `YYYY-MM-DD` | Events starting before this date |
| `category` | string | Filter by category slug (e.g., `live-music`, `comedy`) |
| `tag` | string (repeatable) | Filter by experience tag. Multiple tags use AND semantics (`?tag=outdoor&tag=free`) |
| `q` | string | Text search across event name and description |
| `near` | `lat,lng` | Filter by location (e.g., `39.95,-75.17`) |
| `radius_km` | number | Radius for `near` filter (default: 10, max: 100) |
| `collapse_series` | `true`/`false` | Deduplicate recurring series — keep nearest upcoming instance per series (default: all instances) |
| `series_id` | UUID | Filter to events in a specific series |
| `recurring` | `true`/`false` | Filter by recurring/one-off |
| `limit` | number | Results per page (default: 50, max: 200) |
| `offset` | number | Pagination offset (default: 0) |

**Example Request:**

```bash
curl "https://commons.joinfiber.app/api/v1/events?limit=10&category=live-music"
```

**Example Response:**

```json
{
  "meta": {
    "total": 42,
    "limit": 10,
    "offset": 0,
    "spec": "neighborhood-api-v0.2",
    "license": "CC-BY-4.0"
  },
  "events": [
    {
      "id": "uuid-here",
      "name": "Jazz Night at South",
      "start": "2026-03-14T19:00:00-04:00",
      "end": "2026-03-14T22:00:00-04:00",
      "timezone": "America/New_York",
      "description": "Live jazz quartet every Friday.",
      "category": ["live-music"],
      "place_id": "ChIJ...",
      "location": {
        "name": "South Restaurant",
        "address": "600 N Broad St, Philadelphia, PA",
        "lat": 39.9654,
        "lng": -75.1527
      },
      "url": "https://example.com/jazz-night",
      "images": ["https://commons.joinfiber.app/api/portal/images/abc123.webp"],
      "organizer": {
        "name": "South Restaurant",
        "phone": null
      },
      "cost": "Free",
      "recurrence": { "rrule": "FREQ=WEEKLY" },
      "source": {
        "publisher": "South Restaurant",
        "collected_at": "2026-03-01T12:00:00Z",
        "method": "portal",
        "license": "CC BY 4.0"
      }
    }
  ]
}
```

### Single Event

```
GET /api/v1/events/:id
```

Returns one event by UUID.

```bash
curl "https://commons.joinfiber.app/api/v1/events/abc-123-uuid"
```

### Incremental Sync (Changes Feed)

For apps that cache events locally and need to stay in sync:

```
GET /api/events/changes?since=<ISO-8601-timestamp>&limit=50
```

**How to use:**

1. On first sync, use `since=2020-01-01T00:00:00Z` to get everything
2. Store the `sync_cursor` from the response
3. On subsequent syncs, pass `since=<sync_cursor>`
4. If `has_more` is `true`, keep paginating with the new cursor
5. `deleted_ids` tells you which events to remove from your cache

**Response:**

```json
{
  "events": [...],
  "deleted_ids": ["uuid-1", "uuid-2"],
  "sync_cursor": "2026-03-11T15:30:00Z",
  "has_more": false
}
```

Rate limit: 10 requests/minute (public sync endpoint).

### Feeds

| Format | URL | Use Case |
|--------|-----|----------|
| iCal | `/api/v1/events.ics` | Calendar apps (Google Calendar, Apple Calendar) |
| RSS | `/api/v1/events.rss` | Feed readers, content aggregators |

### Discovery

```
GET /.well-known/neighborhood
```

Auto-discover all available endpoints. Returns URLs for events, iCal, RSS, and terms.

### Metadata

```
GET /api/meta
GET /api/meta/regions
GET /api/meta/categories
```

Stewardship info, active regions, and available event categories.

### Terms

```
GET /api/v1/events/terms
```

Usage terms and license info. All data is CC BY 4.0.

## Rate Limits

- **1000 requests/hour per IP** (default)
- **10 requests/minute** for `/api/events/changes`
- Standard `RateLimit-*` headers included in responses
- If you hit limits, the response is `429` with a clear error message

## Caching Strategy for Mobile/Flutter Apps

Recommended approach for a mobile app:

1. **Initial load**: `GET /api/v1/events?limit=200` to populate local cache
2. **Background sync**: Every 5-15 minutes, call `/api/events/changes?since=<cursor>` to get incremental updates
3. **Store locally**: SQLite or Hive/Isar for Flutter. Cache the full event objects.
4. **Images**: Event image URLs are stable. Cache them with your HTTP client (Dio, etc.)
5. **Offline**: Serve from local cache. Sync when connectivity returns.

## Webhooks

Subscribe to real-time event notifications. Requires an API key (free, self-service — see `/api/v1/developers/register/send-otp`).

```bash
# Create a subscription
curl -X POST "https://commons.joinfiber.app/api/v1/webhooks" \
  -H "X-API-Key: nc_yourkey" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://yourapp.com/webhooks", "event_types": ["event.created", "event.updated"]}'
```

Event types: `event.created`, `event.updated`, `event.deleted`, `event.series_created`

`event.series_created` delivers one webhook per new recurring series (with all instance IDs, start times, and the RRULE) instead of N individual `event.created` webhooks. Subscribe to it if you want to avoid webhook storms when a venue creates a 12-week trivia night.

**Verifying signatures:** Every delivery includes an `X-NC-Signature` header (HMAC-SHA256). Verify it:

```javascript
const crypto = require('crypto');
function verify(rawBody, signatureHeader, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}
```

**Security:** Webhook URLs must be HTTPS and resolve to public IP addresses. SSRF protection blocks private ranges (RFC 1918), cloud metadata endpoints, and IPv6 private addresses. Signing secrets are encrypted at rest on the server.

**Reliability:** Failed deliveries retry 3 times (1 min, 5 min, 25 min backoff). After 10 consecutive failures, the subscription is auto-disabled. Re-enable with `PATCH /api/v1/webhooks/{id}` setting `status: "active"`.

Max 5 subscriptions per API key.

## Contribute API (Write API)

Push events into the commons programmatically. Requires an API key (free, self-service).

### Submit a Single Event

```bash
curl -X POST "https://commons.joinfiber.app/api/v1/contribute" \
  -H "X-API-Key: nc_yourkey" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Open Mic Night",
    "start": "2026-03-20T19:00:00-04:00",
    "timezone": "America/New_York",
    "category": "live_music",
    "location": { "name": "The Coffee Shop", "address": "123 Main St" }
  }'
```

Required fields: `name`, `start` (ISO 8601 with offset), `timezone` (IANA), `category`, `location.name`.

Optional: `end`, `description`, `cost`, `url`, `image_url`, `tags`, `wheelchair_accessible`, `custom_category`, `external_id`.

Response: `201` with `{ event: { id, status, source } }`. Status is `published` for verified/trusted keys, `pending_review` for new keys.

### Submit a Batch

```
POST /api/v1/contribute/batch
```

Body: `{ "events": [ ...up to 50 events... ] }`. Returns `201` (all succeeded), `207` (partial), or `400` (all failed) with per-event results and a summary.

### List Your Events

```
GET /api/v1/contribute/mine?status=published&limit=50
```

### Delete Your Event

```
DELETE /api/v1/contribute/:id
```

Only deletes events submitted by your API key.

### Contribute Rate Limits

Per-key tier limits (DB-enforced):

| Tier | Hourly | Daily |
|------|--------|-------|
| pending (new keys) | 20 | 100 |
| verified | 100 | 500 |
| trusted | 500 | 2000 |

Batch submissions count each event individually against the limit.

## Error Format

All errors follow the same shape:

```json
{
  "error": {
    "code": "RATE_LIMIT",
    "message": "Human-readable explanation"
  }
}
```

## Timestamps and Timezones

All event timestamps (`start`, `end`) are ISO 8601 with a UTC offset computed for the event's actual date and IANA timezone. The offset accounts for Daylight Saving Time — the same recurring event will show `-05:00` (EST) in January and `-04:00` (EDT) in March.

**Key rules for consumers:**

- **Parse the offset.** Don't assume a fixed offset for any region. The offset in the response is correct for that specific event date.
- **The `timezone` field** on each event contains the IANA timezone name (e.g., `America/New_York`). Use this if you need to do your own local-time calculations — it's authoritative for DST rules.
- **`start_after` / `start_before` query parameters** accept `YYYY-MM-DD` date strings. The API interprets these as calendar dates in the event's local timezone.
- **Recurring events** maintain consistent local times across DST transitions. A weekly 5pm event stays at 5pm whether the clock springs forward or falls back.
- **iCal feed** uses `DTSTART;TZID=America/New_York:20260314T190000` format with VTIMEZONE blocks. Your calendar app handles DST via its own IANA timezone database.
- **RSS feed** uses RFC 822 dates in UTC (`toUTCString()`), as required by the RSS 2.0 spec.

**Example — same venue, different seasons:**

```json
// March 14 (EDT, clocks have sprung forward)
{ "start": "2026-03-14T19:00:00-04:00", "timezone": "America/New_York" }

// January 15 (EST, standard time)
{ "start": "2026-01-15T19:00:00-05:00", "timezone": "America/New_York" }
```

Both represent 7pm local time in Philadelphia. The offset differs because of DST.

## Security

- All inputs validated with Zod schemas before processing
- Row Level Security (RLS) enabled on every database table
- Image uploads re-encoded through Sharp (strips EXIF metadata, blocks polyglot payloads)
- No individual user tracking on public endpoints
- API keys stored as SHA-256 hashes (plaintext returned once, never stored)
- Rate limits enforced per route, not just globally

## License

All event data is licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

Attribution: Credit "Neighborhood Commons" or link to the API.
