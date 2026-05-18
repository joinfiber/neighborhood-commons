# Four Roles — Event Provenance

**Status:** Doctrine. Specifies the event-specific application of [provenance.md](provenance.md). Every schema, response, SDK type, and rendering decision about events tests against this document.

## Why this doc exists

[provenance.md](provenance.md) names a type-general mechanic: every public-fact primitive carries a `method` field that answers *how is this known?* Events use that mechanic, but events also have richer structure than other primitives — they happen at a place, are run by someone, and reach the Commons through a particular ecosystem participant. Four roles, not one. This doc names them and pins their meaning.

The discipline matters because every confused provenance field in the early substrate produced downstream confusion: the legacy `source_publisher` slot conflated organizer with contributor and caused real events to disappear from consumer apps that couldn't render the ambiguity. The four-role frame makes the confusion impossible to construct.

## The four roles

Every event row carries the following provenance facets. Each answers a different question; no two roles overlap.

| Role | Answers | Substrate field | Type |
|------|---------|------------------|------|
| **Venue** | Where does it happen? | `events.place_id` → `places` | Place reference (nullable for online events) |
| **Organizer** | Who runs it? | `events.organizer_org_id` → `organizations` | Organization reference (required) |
| **Contributor** | Which ecosystem participant routed it into the Commons? | derived from the calling API key's `contributor_profile_id`; snapshotted on the event row in `source_contributor_name` / `source_contributor_url` so attribution survives key rotation | Contributor profile reference |
| **Method + source URL** | How did the contributor come by this data? Where was it proxied from, if applicable? | `events.source_method` (standard provenance enum) and `events.source_feed_url` (URL or `null`) | Enum + nullable URL |

Five facets in total — venue, organizer, contributor, method, source URL — but four conceptual roles, since method and URL together answer one question: the contributor's authority path.

### Definitions

**Venue.** The place where the event physically occurs. Independent of the organizer — Philly Chess Club at Johnny Brenda's is a different fact from Philly Chess Club at Cafe Walnut, and neither implies the venue endorses or operates the event. Online events leave venue null.

**Organizer.** The real-world entity that puts the event on. They are responsible for it happening; they are the durable, first-party publisher of the claim *"this event is real, organized by us."* For Alice's chess club event, the organizer is Philly Chess Club. For a JB show, JB itself. For a flyer-witnessed open mic, the collective that the witnessing app maintains ("Fiber Community," etc.).

The organizer is always an Organization primitive. Every event has exactly one. The organizer carries durable identity, can be verified (Type A authority), and accrues an event history over time.

**Contributor.** The ecosystem participant — an app, a pipeline, a tool — that routed this event's data into the Commons. Carries a public-facing identity (name, description, logo, link, slug) through the `contributor_profiles` primitive. Profiles survive API key rotation; the link is on `api_keys.contributor_profile_id` and the contributor identity on each event row is a snapshot of the contributor at write time.

The contributor name is editorial: when a developer registers their app and creates the contributor profile, they choose the public-facing label. Internal tool names stay internal. An operator's own pipeline tool might publish as "public-facts" or similar — whatever the operator decides represents that participation to readers.

**Method + source URL.** The authority shape, as defined in [provenance.md](provenance.md). Three values are valid for events:
- `self_asserted` — the organizer asserted this via the contributor.
- `proxied` — the contributor extracted this from a public URL (stored in `source_feed_url`).
- `witnessed` — the contributor observed this with documentary evidence; the organizer is a collective constituted by the contributor.

(`seeded` is not a valid event method. Events are always asserted, proxied, or witnessed at the moment of write — there is no "bulk-imported event awaiting first-party claim." If an event needs to be in the Commons but the organizer isn't yet ready to assert, it's a witnessed event under a collective identity, not a seeded one.)

## The three authority paths, worked through

The three valid event methods map to the three authority paths from CLAUDE.md.

### Path 1 — Entity-runs-it (`self_asserted`)

Alice creates Philly Chess Club in Merrie. She posts "Tuesday Chess at Johnny Brenda's, 7pm."

| Role | Value |
|------|-------|
| Venue | Johnny Brenda's |
| Organizer | Philly Chess Club |
| Contributor | Merrie |
| Method | `self_asserted` |
| Source URL | null |

The organizer is a third-party real-world entity. The contributor is the app that routed the data. They are different entities; the contributor is the courier and the organizer is the claimant.

### Path 2 — Pipeline-proxies (`proxied`)

A pipeline tool scrapes Johnny Brenda's public calendar page.

| Role | Value |
|------|-------|
| Venue | Johnny Brenda's |
| Organizer | Johnny Brenda's |
| Contributor | (whatever the operator's pipeline tool publishes as — e.g. "public-facts") |
| Method | `proxied` |
| Source URL | `https://johnnybrendas.com/calendar` |

The organizer is the real-world entity whose calendar was scraped. The contributor is the pipeline that did the scraping, surfaced under whatever public name the operator chose for that participation. The source URL preserves the lineage for transparency.

### Path 3 — Witnessed-with-evidence (`witnessed`)

A community OCR's a flyer for an open mic.

| Role | Value |
|------|-------|
| Venue | wherever the flyer says |
| Organizer | Fiber Community (collective) |
| Contributor | Fiber |
| Method | `witnessed` |
| Source URL | null (evidence is a photo, held operationally) |

The actual organizer of the real-world event is unknown to the contributor; the Commons doesn't speculate. Instead, the event is attributed to a collective publishing identity that the contributor maintains. The organizer and contributor are structurally linked here — the collective is *of* the contributor, constituted by it.

This asymmetry matters for rendering — see below.

## What's deliberately not a role

Several candidates were considered and rejected. Each one tried to add a fifth slot; each one collapsed under inspection.

| Candidate | Why not |
|-----------|---------|
| **Publisher** (legacy `source.publisher`) | Conflated organizer with contributor. "Who is this from?" is already answered by organizer.name. The legacy field's heterogeneous historical contents (sometimes app name, sometimes organizer name) produced real downstream bugs. |
| **Sponsor / underwriter** | Editorial content. Lives in description or tags. "Sponsored by REI" is a fact about funding, not provenance. |
| **Co-organizer** | If multi-organizer events become a real shape, the existing role extends to `organizer_org_ids[]`. Not a new role. |
| **Photographer / translator** | Image-credit and content-localization metadata. Operational, not provenance. |
| **Curator** (someone whose Substack picks events) | Per CLAUDE.md — curators contribute via feeds attributed to themselves as contributor. The role they play is "contributor," not a separate "curator" role. |
| **Steward / verifier** | Anchors organizer identity (Type A authority). Not per-event provenance. |
| **The human** (Alice, the photographer of the flyer, the operator behind the pipeline) | "No users in the Commons." The Commons holds zero PII; humans live in the consumer app that knows them. |

## Rendering guidance for consumers

The substrate surfaces all four roles uniformly. Consumers decide how to render them — including when to suppress a role to avoid redundancy.

### Contributor names are editorial

`contributor_profiles.name` is whatever public-facing label the operator chooses when they create the profile in the developer dashboard. Internal app names, internal key labels, internal team names do not surface. The name field is a deliberate editorial choice — it's what readers see on the "via X" splash.

Examples:
- A user-facing app publishes under its own brand name.
- A pipeline tool publishes under whatever public label fits the operator's framing (e.g. "public-facts," "Commons data," etc.).
- A witnessing app publishes under its brand, though the rendering rules below may suppress the "via" line entirely.

### `source.method` drives the "via" line

The three event methods produce structurally different organizer ↔ contributor relationships. The `method` enum encodes that relationship, and consumers should use it to decide whether the "via" line is informative or redundant.

| method | Organizer ↔ Contributor relationship | Recommended rendering |
|--------|----------------------------------------|------------------------|
| `self_asserted` | Organizer is a third-party real-world entity; contributor is the app that routed it. Distinct entities. | `"{organizer.name} — via {contributor.name}"` |
| `proxied` | Organizer is a real-world entity; contributor is the proxying pipeline. Distinct entities; source URL exposes the lineage. | `"{organizer.name} — via {contributor.name}"`. Optionally: link the contributor splash to the source URL for transparency. |
| `witnessed` | Organizer is a collective constituted by the contributor. Same entity in two roles. | `"{organizer.name}"` — suppress "via," it's redundant. |

This is rendering guidance, not enforcement. The Commons surfaces all roles unconditionally; consumers choose. But this is the rule we recommend, and the rule the operator's own consumer apps follow.

### The three cases, rendered

| Path | Card reads | Tap on contributor |
|------|------------|---------------------|
| Self-asserted | "Tuesday Chess — Philly Chess Club — at Johnny Brenda's — via Merrie" | Splash explaining Merrie |
| Proxied | "Friday Show — Johnny Brenda's — via public-facts" | Splash explaining the pipeline, optionally with a link to `johnnybrendas.com/calendar` |
| Witnessed | "Open Mic — Fiber Community — at Cafe Walnut" | (No "via.") Tapping the organizer shows the collective's profile. |

All three feel natural. The substrate stays uniform across them. Rendering judgment lives in the consumer, where editorial judgment belongs.

## Implications for the substrate

This doctrine implies a small number of concrete things about how the Commons stores and surfaces event provenance:

1. **No `source.publisher` field in the public event response.** The role "who is this from?" is already answered by `organizer.name`. The legacy slot is retired.
2. **`source.contributor`** is a contributor-profile reference (slug, name, logo, description, profile URL). Not a thin string-pair; an entity reference. The substrate where reputation accrues.
3. **`source.method`** is the standard provenance enum: `self_asserted`, `proxied`, `witnessed`. The vocabulary matches [provenance.md](provenance.md).
4. **`source.url`** appears when method is `proxied`; null otherwise.
5. **`source.collected_at` and `source.license`** remain on the response — they're provenance metadata, not roles.
6. **No defensive rendering logic** like `if (publisher == contributor) hide` is needed in consumer apps. The four-role frame plus the `method` enum produces unambiguous rendering rules.

## Tests against this doctrine

Before shipping any change to event provenance, ask:

1. Does this introduce a fifth role? If so, what does it answer that the existing four don't?
2. Does it make any field carry two roles' worth of meaning at once?
3. Does it require a consumer to write defensive rendering logic?
4. Does it surface an internal contributor name where an editorial public-facing label belongs?
5. Does it use a method value outside `self_asserted` / `proxied` / `witnessed` without an explicit case for adding to the provenance vocabulary?

A "yes" to any of these is a sign the change is fighting the doctrine rather than living within it.
