# The Four Roles of Provenance

**Status:** Doctrine. Every schema, response-shape, and rendering decision about events tests against this document.

## Why this doc exists

For a database whose whole job is organizing public facts about the world, "where did this information come from?" is the load-bearing question. A clean answer makes every downstream decision — schema, API response shape, consumer rendering, attribution UI, photo gates, verification scope — fall out cleanly. A muddled answer turns every decision into a tangle.

This is the clean answer. There are exactly four roles in the provenance of an event. No more, no fewer. Every event has all four populated (or null where structurally absent), and every interface surface — public API, SDK types, consumer rendering — operates against this four-role frame.

## The four roles

| Role | Answers the question | Substrate field | Type |
|------|----------------------|------------------|------|
| **Organizer** | Who runs this? | `events.organizer_org_id` → `organizations` | Organization |
| **Venue** | Where does it happen? | `events.place_id` → `places` | Place |
| **Contributor** | Which app routed this into the Commons? | `events.contributor_profile_id` → `contributor_profiles` | Contributor profile |
| **Source URL** | If this is proxied, what page was proxied? | `events.source_feed_url` (or `events.source_url`) | URL string, not an entity |

That's it. Every other field on the events table — `event_at`, `description`, `cost`, `category`, `event_image_url` — is *content*, not provenance. The four roles together answer "who, where, via whom, sourced from where" without ambiguity.

### Definitions

**Organizer.** The real-world entity that puts the event on. They are responsible for it happening. They are the durable, first-party publisher of the claim "this event is real, organized by us." For Alice's chess club event, the organizer is Philly Chess Club. For a Johnny Brenda's show, it's Johnny Brenda's. For a flyer-witnessed open mic, it's the collective the witnessing app maintains (e.g. "Fiber Community").

The organizer is always an Organization primitive. Every event has exactly one. The organizer carries durable identity, can be verified (Type A), and accrues an event history over time.

**Venue.** The Place where the event physically occurs. For Alice's chess club: Johnny Brenda's. For an online-only event: optionally null. The venue is independent of the organizer — Philly Chess Club at Johnny Brenda's is a different fact from Philly Chess Club at Cafe Walnut, and neither implies the venue endorses or operates the event.

**Contributor.** The Commons participant — an app, a pipeline, a tool — that routed this event's data into the Commons. For Alice's chess club event: Merrie (because Alice posted it in Merrie). For a Studio scrape of Johnny Brenda's website: the public-facts pipeline. For a Fiber-OCR'd flyer: Fiber.

The contributor is always a contributor profile (`contributor_profiles`), which carries a public-facing identity — a name, a logo, a description, a link — separate from the operational `api_keys` row. Profiles survive key rotation; keys point at profiles.

**Source URL.** If the contributor proxied this from a specific external page, the URL of that page. For Studio's Johnny Brenda's scrape: `https://johnnybrendas.com/calendar`. For Alice's chess club event (entered first-party in Merrie): null. For a witnessed flyer: typically null (the evidence is a photo, held operationally, not a public URL).

This is a URL, not an entity. The Commons does not model the external publisher as a primitive. The URL is for transparency — clicking "view source" should show where the data came from — not for identity.

## The three authority paths, worked through

The three authority paths from CLAUDE.md map cleanly onto the four roles:

### Path 1 — Entity-runs-it (`source.method = 'api'`)

Alice creates Philly Chess Club in Merrie. She posts "Tuesday Chess at Johnny Brenda's, 7pm."

| Role | Value |
|------|-------|
| Organizer | Philly Chess Club |
| Venue | Johnny Brenda's |
| Contributor | Merrie |
| Source URL | null |

The organizer is a third-party real-world entity (the chess club exists independently of Merrie). The contributor is the app that routed the data. They are different entities.

### Path 2 — Pipeline-proxies (`source.method = 'import'`)

Studio scrapes Johnny Brenda's calendar page.

| Role | Value |
|------|-------|
| Organizer | Johnny Brenda's |
| Venue | Johnny Brenda's |
| Contributor | public-facts (Studio's public-facing label) |
| Source URL | `https://johnnybrendas.com/calendar` |

The organizer is the real-world entity whose calendar was scraped. The contributor is the pipeline that did the scraping, surfaced under whatever public name the operator chooses. The source URL preserves the lineage for transparency.

### Path 3 — Witnessed-with-evidence (`source.method = 'witnessed'`)

A Fiber user OCRs a flyer for an open mic.

| Role | Value |
|------|-------|
| Organizer | Fiber Community (collective) |
| Venue | wherever the flyer says |
| Contributor | Fiber |
| Source URL | null |

The actual organizer of the real-world event is unknown (the flyer didn't say, or the witness couldn't verify). The Commons doesn't speculate. Instead, the event is attributed to a collective publishing identity that the contributor maintains — "Fiber Community" — which exists only because Fiber decided to name it. The organizer and contributor are structurally linked here: the collective is *of* the contributor.

This asymmetry matters for rendering — see below.

## What's deliberately not a fifth role

Several candidates were considered and rejected:

| Candidate | Why not |
|-----------|---------|
| **Sponsor / underwriter** | Editorial content. Lives in description or tags. "Sponsored by REI" is a fact about the event's funding, not its provenance. |
| **Co-organizer** | Multi-organizer events are possible; the substrate could later admit `organizer_org_ids[]`. But that's an extension of the existing role, not a new role. |
| **Photographer / translator** | Image-credit and content-localization metadata. Operational, not provenance. |
| **Curator** (e.g. someone whose Substack picks events) | Explicitly rejected per CLAUDE.md — curators contribute via feeds attributed to themselves as contributor. The role they play in the substrate is "contributor," not a separate "curator" role. |
| **Steward / verifier** | Anchors organizer identity (Type A authority). Not per-event provenance. |
| **The human** (Alice, the photographer of the flyer, the Studio operator) | "No users in the Commons." The Commons holds zero PII; humans live in the consumer app that knows them. |
| **Operator-of-the-contributor** (who runs Merrie?) | Reference data on the contributor profile, not a per-event role. |

## Rendering guidance for consumers

The substrate surfaces all four roles uniformly. Consumers decide how to render them — including when to suppress a role to avoid redundancy.

### Contributor names are editorial

`contributor_profiles.name` is whatever public-facing label the operator chooses when they create the profile in the developer dashboard. Internal app names, internal key labels, internal team names do not surface. The name field is a deliberate editorial choice — it's what readers see on the "via X" splash.

Examples:
- Merrie → `name = "Merrie"` (matches the app brand).
- Studio (Commons operator's internal pipeline tool) → `name = "public-facts"` (or "Commons data," or whatever fits — Studio is internal infrastructure; the public-facing label reflects that).
- Fiber → `name = "Fiber"`.

This means a reader will *never* see "Studio" in their UI. They'll see "public-facts" because that's what Studio's contributor profile is named for public consumption. Same key, same authority, different public label.

### `source.method` drives the "via" line

The three authority paths produce structurally different organizer ↔ contributor relationships. The `source.method` enum encodes that relationship, and consumers should use it to decide whether the "via" line is informative or redundant:

| method | Organizer ↔ Contributor | Recommended rendering |
|--------|--------------------------|------------------------|
| `api` | Organizer is a third-party real-world entity; contributor is the app that routed it. Distinct entities. | `"{organizer.name} — via {contributor.name}"` |
| `import` | Organizer is a real-world entity; contributor is the proxying pipeline. Distinct entities. | `"{organizer.name} — via {contributor.name}"` |
| `witnessed` | Organizer is a collective constituted by the contributor. Same entity in two roles. | `"{organizer.name}"` — suppress "via" |
| `portal` (legacy) | Organizer is the portal user's account; contributor is null (portal-submitted events predate the contributor concept). Legacy rows only — the portal write path is retired in 2.x. | `"{organizer.name}"` — no "via" (contributor is null on these rows) |

This is rendering guidance, not enforcement. The Commons surfaces all four roles unconditionally; consumers choose. But this is the rule we recommend, and it's the rule the operator's own consumer apps (Fiber, Merrie) follow.

### The three cases, rendered

| Path | Card reads | Tap on contributor |
|------|------------|---------------------|
| Entity-runs-it | "Tuesday Chess — Philly Chess Club — at Johnny Brenda's — via Merrie" | Splash explaining Merrie |
| Pipeline-proxies | "Friday Show — Johnny Brenda's — via public-facts" | Splash explaining the public-facts pipeline + link to source URL for transparency |
| Witnessed | "Open Mic — Fiber Community — at Cafe Walnut" | No "via" (collective is self-attributed); tapping the organizer shows the collective's profile |

All three feel natural. The substrate stays uniform. The rendering judgment lives in the consumer, where editorial judgment belongs.

## Implications for the substrate

This doctrine implies a small number of concrete things about how the Commons stores and surfaces provenance:

1. **`source.publisher` is deprecated in 2.x, retired in 3.0.0.** The field currently exists in the 2.x spec and is required. Under the four-role frame the role it tried to play — "who is this from" — is already filled by `organizer`, and the field's heterogeneous historical contents (sometimes app name, sometimes organizer name) make it structurally unreliable. The additive-only stability principle forbids removing it from the 2.x response; instead the spec gets a deprecation note pointing readers at `organizer.name`, the field continues to be populated for backwards compatibility, and removal is bundled into the next breaking-change release (3.0.0). New consumers should ignore it and read `organizer.name` directly.

2. **The public event response will carry `source.contributor` as a contributor-profile reference** — `slug`, `name`, optional `logo_url` and `description`, and the URL of the profile resource. The current 2.x response carries `{name, url}` as a thin string-pair; expanding it into a profile reference is an additive change (existing fields keep their meaning; new fields appear alongside). The contributor link itself is stored on `api_keys.contributor_profile_id` (planned, per the onboarding-redesign doc); event rows continue to carry a frozen snapshot in `source_contributor_name` / `source_contributor_url` so attribution survives key rotation.

3. **`source.method` stays as-is in the public response.** Consumers need it to render correctly. Current enum values: `'portal'` (legacy), `'api'`, `'import'`, `'witnessed'`. New methods can be added additively if new authority paths emerge.

4. **`source.url` is part of the public response when present**, for pipeline-proxy transparency. Null otherwise. (Adding it to the response shape, if not already present, is additive.)

5. **`source.collected_at` and `source.license`** remain part of the response — they describe provenance metadata, not a role.

6. **No defensive rendering logic** like `if (publisher == contributor) hide` should be needed in consumer apps going forward. The four-role frame plus the `method` enum produces unambiguous rendering rules. Where current consumers carry such logic (as Fiber does today), it can be retired once they migrate to reading `organizer.name` directly instead of `source.publisher`.

## What this doctrine forbids

- Adding a fifth provenance role without reopening this doc and arguing the new role is structurally distinct from the four (not just editorial flavor of an existing role).
- Stuffing two roles into one field (the legacy `source_publisher` mistake — sometimes the app name, sometimes the organizer name).
- Letting internal app names surface in consumer UIs. The contributor profile's `name` is the public-facing label; that's what consumers render.
- Modeling humans as a provenance role. The human stays in the consumer app that knows them.

## What this doctrine permits

- New `source.method` values, if a new authority path emerges (e.g. `'stewardship_attestation'` for community-vouched events). The four roles stay; the method enum grows.
- Multiple organizers per event (`organizer_org_ids[]`), if the need is real. Extends the existing role; not a new role.
- Rendering variations across consumers. Each consumer is free to surface the four roles however they want. This doctrine is about what the substrate *holds*, not what every UI must show.

## Tests against this doctrine

Before shipping any change to events provenance, ask:
1. Does this introduce a fifth role? If so, what does it answer that the existing four don't?
2. Does this make any field carry two roles' worth of meaning at once?
3. Does it require a consumer to write defensive rendering logic (e.g. "hide if X == Y")?
4. Does it surface an internal name where an editorial public-facing name belongs?

A "yes" to any of these is a sign the change is fighting the doctrine rather than living within it.
