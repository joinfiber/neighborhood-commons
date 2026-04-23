# Neighborhood Commons SDK

Typed client for the [Neighborhood Commons API](https://api.neighborhood-commons.org), generated from the OpenAPI spec.

The SDK is a mirror of the spec. If the spec changes, this package changes. The spec is authoritative — if this SDK ever disagrees with `/openapi.json`, the spec wins.

## Read this first

Beyond a list view, you should read [the Commons Contract Guide](https://api.neighborhood-commons.org/llms.txt) before building anything substantial. The SDK gives you typed access to every endpoint, but the *meaning* of each shape — how films cluster by `tmdb_id`, how attribution works via `source.contributor`, what `open_window` implies for feeds, how series IDs map to recurring events — lives in the Guide. The SDK is the floor; the Guide is what makes you build something good.

## Stability promise

The Commons Spec is **additive-only by intent.** It grows over time as new shapes are needed, but existing shapes essentially never change. New fields are rare and considered. Breaking changes are vanishingly rare — measured in years, not months. Build against today's contract with confidence that it will still work in 18 months. See [`RELEASING.md`](./RELEASING.md) for the release discipline that backs this promise.

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

## Why this SDK stays thin

Deliberately. The whole runtime wrapper is `createCommonsClient()` — a few dozen lines you can read in two minutes. No retry logic, no caching, no convenience method wrappers, no "smart" defaults beyond what the spec requires.

This is by design. Every wrapper feature would widen the implicit contract beyond what the Spec actually says, making the SDK a second source of truth that drifts from `openapi.json`. Keep the SDK boring; build helpers in your own application layer if you need them. If a wrapper feature seems compelling enough to belong here, the right move is to propose it as a spec change first.

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

This SDK tracks the Commons Contract via semver:

- **Patch** — SDK bug fix, no spec change
- **Minor** — additive spec change (new optional field, new endpoint, new query parameter, new enum value). Rare — weeks to months between minors.
- **Major** — breaking spec change (field removal, rename, type change). Vanishingly rare — expect years between majors.

See [`RELEASING.md`](./RELEASING.md) for the additive-only discipline that drives version bumps. Watch the root [CHANGELOG.md](https://github.com/joinfiber/neighborhood-commons/blob/master/CHANGELOG.md) for what changed and when.

## License

MIT.
