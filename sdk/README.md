# Neighborhood Commons SDK

Typed client for the [Neighborhood Commons API](https://api.neighborhood-commons.org), generated from the OpenAPI spec.

The SDK is a mirror of the spec. If the spec changes, this package changes. The spec is authoritative — if this SDK ever disagrees with `/openapi.json`, the spec wins.

## Install

```bash
npm install neighborhood-commons
```

## Quick start

```ts
import { createCommonsClient } from "neighborhood-commons";

const commons = createCommonsClient();

const { data, error } = await commons.GET("/events", {
  params: { query: { start_after: "2026-01-01", limit: 20 } },
});

if (error) {
  console.error(error.error.code, error.error.message);
} else {
  for (const event of data.events) {
    console.log(event.name, event.start);
  }
}
```

## With an API key

```ts
const commons = createCommonsClient({
  apiKey: process.env.COMMONS_API_KEY,
});
```

Both developer-tier and service-tier keys use the `X-API-Key` header — pass whichever tier you hold as `apiKey`.

## Custom base URL

```ts
const commons = createCommonsClient({
  baseUrl: "https://staging.neighborhood-commons.org/api/v1",
});
```

## What you get

- **Typed request/response for every endpoint.** IDE autocomplete; compile-time errors on drift.
- **Thin wrapper over [openapi-fetch](https://openapi-ts.dev/openapi-fetch/).** No magic, no hidden behavior. The whole source is short enough to read in a sitting.
- **Generated from [`openapi.json`](https://api.neighborhood-commons.org/openapi.json).** Spec changes propagate here on the next release.

## Type exports

Convenience type aliases for the common shapes:

```ts
import type {
  Event,
  Account,
  Group,
  Meta,
  Webhook,
  Source,
  ApiError,
  ErrorCode,
} from "neighborhood-commons";
```

For anything else, reach into the generated namespace:

```ts
import type { components, paths } from "neighborhood-commons";

type ServiceEventInput = components["schemas"]["ServiceEventInput"];
type ListEventsQuery = paths["/events"]["get"]["parameters"]["query"];
```

## Caveats

- The `/events/changes` endpoint lives outside the `/v1` prefix. If you need it, create a second client with `baseUrl` pointed at `.../api` instead of `.../api/v1`, or call it directly with `fetch`.

## Versioning

Tracks the Commons Contract. Breaking changes in the spec → major version bump here. See the root [CHANGELOG.md](https://github.com/joinfiber/neighborhood-commons/blob/master/CHANGELOG.md).

## License

MIT.
