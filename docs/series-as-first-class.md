# Series as First-Class Primitive — Commons Response to Merrie

**For:** The Merrie team (and a Claude Code session opened in the Merrie repository).
**Purpose:** Commons-side response to Merrie's proposal to make series a subscribable entity. Captures what we're committing to build, what we're trimming, and the rationale — so we can sequence the work in parallel.
**Date:** 2026-05-19

## What this is

Merrie sent a proposal to elevate `event_series` from a recurrence-grouping mechanism to a first-class primitive with its own identity, so that a series created on Merrie is also a series on Fiber (and any future consumer). This document is the Commons-side answer: the scope we accept, the part we decline, the design questions resolved, and what Merrie should plan to do on its side.

Read Merrie's proposal first for context.

## Position summary

We're building **two** of the three things Merrie proposed, plus one cleanup that was missing from the original proposal:

| | Status |
|---|---|
| `organizer_org_id` on `event_series` (cleanup) | Building |
| Series identity fields + public read endpoint | Building |
| `attendance_model` enum on series | **Declining** |

Frame the additions as **completing** the existing `event_series` primitive — which today has expansion machinery but no identity — not as introducing a new primitive. That framing matters for the additive-only stability commitment.

## What we're building

### 1. `organizer_org_id` on `event_series`

Cleanup. Today the ownership check in [src/routes/service/series.ts:44](../src/routes/service/series.ts:44) spelunks through a sample event to figure out who owns the series. Putting `organizer_org_id` on the series row directly makes authority explicit and stops relying on instance-level inference.

- New column: `organizer_org_id uuid REFERENCES organizations(id) NOT NULL` (after backfill)
- Enforced at series creation via the same `api_key_organization_links` check that events use today
- Backfilled from the organizer of any existing instance

### 2. Identity fields on `event_series`

```
name             text not null
slug             text not null  -- globally unique
description      text
cover_image_url  text           -- via existing Sharp + R2 pipeline
```

`name` and `slug` non-null after backfill. Globally unique slug (matching every other slug in the schema — orgs, events, groups).

**Semantic note that needs to be explicit in the OpenAPI doc:** `event_series.name` is the *current* identity of the series for forward-looking discovery and aggregation. Past instances' `events.content` retains whatever it was when materialized — Commons does not retroactively rewrite history when a series is renamed.

### 3. Read endpoints

```
GET /api/v1/series/{idOrSlug}
→ { id, slug, name, description, cover_image_url,
    organizer: { ... org reference ... },
    recurrence: { rrule: "..." },
    next_instance: Event | null,
    timezone, ... }

GET /api/v1/series?organizer_org_id={uuid}
→ [ Series, ... ]
```

Flat list endpoint (`?organizer_org_id=X`) rather than nested `/accounts/{id}/series`, matching how every other list endpoint works in the spec.

**Not embedding `upcoming_instances`.** Consumers fetch instances via the existing `/events?series_id=X&from=now&limit=N`, which already supports pagination, filtering, and `collapse_series`. Avoiding two ways to ask the same question keeps the series payload focused.

### 4. Write endpoint

```
PATCH /service/series/{id}
→ { name?, slug?, description?, cover_image_url? }
```

**Separate from `PATCH /service/events/series/{seriesId}` (existing).** The two endpoints have different semantics:

- `PATCH /service/series/{id}` — series identity edits. Never propagate to past instances.
- `PATCH /service/events/series/{seriesId}` — template edits. Propagate to future instances and to `base_event_data` so the auto-extend cron inherits them.

Mixing them would invite the wrong default (a rename leaking into past instance titles).

### 5. Webhook surface

- **Enrich `event.series_created`** to include the new identity fields. Subscribers can hydrate their cache without an extra fetch.
- **Add `series.updated`** — fires when identity fields change. Consumers (Merrie, Fiber) use this to invalidate cached series pages.
- **Add `series.deleted`** — fires once at series-level rather than only N per-instance `event.deleted` events.

### 6. Cover image pipeline

Reuse the existing magic-byte check + Sharp re-encode + R2 storage pipeline. No new infrastructure. Path will mirror whatever the org-logo upload endpoint does.

## What we're declining and why

### `attendance_model` enum on series

Merrie proposed a `'drop_in' | 'per_instance_rsvp'` enum to communicate "what CTA should consumers show?" Skipping this one. The principle:

> **Commons holds publisher declarations. Apps decide reader-side taxonomies.**

A publisher declaring "this event requires RSVP" is a fact about the event as the publisher constituted it — that travels with the event (and the existing `events.rsvp` field already captures it). A pre-baked taxonomy of "drop-in vs RSVP" that classifies events into UX buckets is the reader's job. Apps that support ticketing classify differently from apps that support subscribe; apps that broker private spaces classify differently again. That's the application-layer marketplace at work, and the Commons shouldn't pre-empt it.

The drop-in property is reader-derivable from existing publisher declarations: absence of an RSVP requirement, absence of a ticket URL, absence of capacity limits. If those signals turn out to be lossy across multiple consumers in 6+ months, we revisit.

This principle is worth recording as ongoing guard against drift: **publisher declaration vs reader-side taxonomy.** Publisher → in. Classification → out.

## Answers to Merrie's original six questions

**1. Slug scope.** Globally unique. Every other slug in the schema is global ([000_full_schema.sql:43](../migrations/000_full_schema.sql:43) orgs, :134 events, :270 groups). Account-scoping series alone would create an inconsistency for the URL ergonomics of one consumer. `merrie.co/q/[host]/[series]` is a Merrie URL choice; the Commons API resolves slugs directly.

**2. `attendance_model` shape.** Declined — see above.

**3. Migration approach for existing series.** Backfill `name` from `base_event_data->>'content'`. Generate `slug` via the standard slugify with `-2`/`-3` collision suffixes. Make non-null after backfill. Pre-launch, so the existing series set is small and the blast radius is bounded.

**4. Cover image pipeline.** Yes, reuse exactly. No new pipeline.

**5. Editability surface.** Separate endpoint. Identity edits and template edits have different propagation semantics; mixing them would corrupt the historical record when a series is renamed.

**6. Webhook payload.** Enrich `event.series_created` with identity fields. Add `series.updated` and `series.deleted` for completeness.

## What Merrie should plan for

These are the integration points on Merrie's side once the Commons additions ship.

### Subscribers stay in Merrie

You already have this correct in the proposal — keeping it visible because it's load-bearing. Subscriber data (email + name) never enters the Commons. Merrie builds its own subscriber storage and binds each subscriber to a series via `series_id` returned from Commons. Same for unsubscribe tokens, send history, audit logs.

### Wiring drop-in vs RSVP UX without `attendance_model`

Since Commons isn't shipping `attendance_model`, Merrie derives the CTA from existing publisher declarations on instances:

- `events.rsvp = 'required'` → "RSVP required" CTA
- `events.rsvp = 'recommended'` → "RSVP suggested" CTA
- `events.rsvp = null` and no `link_url` pointing at a ticket page → drop-in
- (Future: if ticketed events become a thing, that's a separate signal)

Series-level Merrie UX ("Subscribe to series") binds by `series_id` and is independent of the per-instance CTA.

### Cache invalidation on identity changes

Wire Merrie to the new `series.updated` and `series.deleted` webhooks. When fired, invalidate any cached series page and re-fetch the series record. Same pattern Merrie should already follow for `organization.updated` if it caches org pages.

### Series creation flow

When a Merrie publisher creates a recurring event, the Service API call now needs to provide `name`, `slug`, and optionally `description` + `cover_image_url` at the series level — separate from the per-instance template fields. The shape will be in the OpenAPI doc once we ship; Merrie can scaffold against generated types from `neighborhood-commons` once the SDK regenerates.

### Past-instance behavior

Be prepared to explain to Merrie publishers that renaming a series does **not** rename historical instances. Either reflect this in the UX (e.g., "Future events will be titled 'Fishtown Quizzo'; past events retain their original titles") or design the flow so this expectation is implicit.

## Timeline and decoupling

Commons builds this independent of Merrie's Spring/Summer 2026 ship.

Important to be honest about: **Merrie's deadline does not constrain Commons additions.** Merrie can ship subscribable series this quarter without Commons changes — using `series_id` as the binding key and storing identity in Merrie's own DB. The decision to promote series identity to Commons is a substrate question ("do we want this fact neutral across apps?"), not a Merrie-roadmap question. Decoupling those clocks is healthy for the additive-only stability commitment.

Practical sequence:

1. Commons ships migrations + endpoints + SDK regen + spec updates (one PR, contract triad updated together).
2. Merrie picks up new SDK types, refactors series creation to provide identity fields, wires `series.updated`/`series.deleted` webhooks.
3. Fiber integrates from the new series endpoint when it builds series rendering.

No coordination cliff. Each side moves when it's ready.

## Open items for Merrie to confirm

- **Field set sufficient?** Is `name + slug + description + cover_image_url` the complete identity set for v1, or is there a field Merrie expects to need that we haven't surfaced? (Resist adding speculative ones; ask only if there's a concrete consumer need.)
- **Past-instance naming behavior** — Merrie's UX agrees that renames are forward-only, with old instances retaining their original titles?
- **`attendance_model` decline** — Confirm Merrie can derive CTA behavior from existing per-instance signals, or surface a concrete case where derivation is lossy before we lock the decision.

Reply with confirmation on these three and we proceed with the Commons-side build.
