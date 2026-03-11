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
| `q` | string | Text search across event name and description |
| `near` | `lat,lng` | Filter by location (e.g., `39.95,-75.17`) |
| `radius_km` | number | Radius for `near` filter (default: 10, max: 100) |
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
      "start": "2026-03-14T19:00:00-05:00",
      "end": "2026-03-14T22:00:00-05:00",
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

## License

All event data is licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

Attribution: Credit "Neighborhood Commons" or link to the API.
