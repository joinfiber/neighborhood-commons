# Provenance Doctrine

**Status:** Foundational doctrine. Every public-fact primitive in the substrate tests against this document.

## Why this doc exists

The Neighborhood Commons exists to organize public facts about neighborhoods. For a database whose whole job is public-fact infrastructure, *"how is this known?"* is the load-bearing question. Every row of every public-fact table answers it implicitly; this doctrine makes it explicit, gives it a standard place to live in the schema, and gives it a standard vocabulary.

The mechanic is type-general. Events, Organizations, Places, Broadcasts, Lists, future Classifieds, future Contributor Profiles — every public-fact primitive carries a `method` field that names the authority shape by which the row came to be part of the Commons.

## The core mechanic

Every public-fact primitive has a `method` field (column name may vary by type for historical reasons, but the role is uniform) that records *how the data came to be in the Commons*. The valid value set varies per type — some primitives admit only one shape today — but the field's existence is universal.

This is not metadata about how the bytes arrived (transport). It is structural data about the authority chain: who is on the record for the claim, where the claim originated, how a downstream consumer can verify it, who corrects it when it's wrong.

## Standard value vocabulary

Four values cover the cases we know about. Each names a complete authority chain; each describes the *kind of claim* the row represents.

### `self_asserted`

First-party authority. The entity that the data is about asserts it, via a contributor that acts as courier. The authority chain is *entity → contributor → Commons*.

- An organization asserting its own profile (Type A authority).
- An organizer asserting an event they run.
- A publisher posting a broadcast about their place.
- A curator asserting an editorial list.

The contributor is a faithful conduit. The claim belongs to the entity. Errors are corrected by the entity.

### `proxied`

Third-party authority, relayed by the contributor from a public source. The contributor faithfully extracts structured data from a public URL and stores it in the Commons under attribution to that source. The authority chain is *URL → contributor → Commons*.

- A pipeline scrapes Johnny Brenda's calendar page.
- An ingestion tool reads a public RSS feed.
- A CSV import of a city's business registry.

The claim still belongs to the original source (the URL's authors). The contributor is responsible for the faithfulness of the extraction. The source URL is part of the row — see per-primitive rules below.

### `witnessed`

Observer authority, with documentary evidence. The contributor observed something in the world and is reporting it with backing material. No first-party assertion is available; the contributor stands behind the observation under a collective publishing identity. The authority chain is *evidence → contributor (under a collective identity) → Commons*.

- A community OCR's a flyer for an open mic.
- A user photographs a sign with hours and submits it.

The claim is the contributor's, made through a named collective that exists for this purpose ("Fiber Community," etc.). Errors are the contributor's responsibility; the evidence is the record.

### `seeded`

Bulk-imported, not yet first-party-claimed. Pending uptake. The row exists in the Commons because operations seeded it from a bulk source, but no entity has stepped forward to assert it. The data is provisional.

Primarily a state for organizations imported from business registries or scrapes that haven't yet been claimed by their real-world counterparts. Consumers can use this to filter ("show me only first-party-asserted orgs"), and verification tooling can target seeded rows for first-party uptake.

`seeded` is distinct from `proxied` in that proxied data has a current authoritative URL behind it; seeded data is data the Commons holds without a continuing authority chain — it's waiting to be promoted to `self_asserted` (through verification or claim) or retired.

## Per-primitive application

Different primitives admit different subsets of the standard vocabulary. The field exists on each one even when only one value is valid today; symmetry now is cheaper than retrofit later.

| Primitive | Column | Valid values today | Default for new rows | Notes |
|-----------|--------|--------------------|-----------------------|-------|
| **Event** | `events.source_method` | `self_asserted`, `proxied`, `witnessed` | `self_asserted` (writes via Service API) | The richest case; all three values appear in real data. |
| **Organization** | `organizations.method` | `self_asserted`, `proxied`, `witnessed`, `seeded` | `seeded` (bulk imports) or `self_asserted` (verified orgs claimed via the dashboard) | The biggest immediate win — today there's no way to flag seeded vs. claimed orgs structurally. |
| **Place** | `places.category_source` (existing) | `osm`, `admin_review`, `publisher_declaration` | `osm` | Place *existence* is monotonic (Google's `place_id` says it's real). Categorization is the contested facet; `category_source` already records it. No generic `places.method` needed. |
| **Broadcast** | `broadcasts.method` | `self_asserted` (only valid value today) | `self_asserted` | Broadcasts are always first-party from the organization. Field exists for symmetry; new methods can be added if other paths emerge. |
| **List** | `lists.method` | `self_asserted` (only valid value today) | `self_asserted` | Lists are editorial assertions by the curator. Field exists for symmetry. |
| Future **Classified** | `classifieds.method` | `self_asserted` (constrained-publishing principle) | `self_asserted` | Classifieds are first-party by design — the advertising org asserts. |
| Future **ContributorProfile** | `contributor_profiles.method` | `self_asserted` (developer claims who their app is) | `self_asserted` | Profiles are first-party assertions by the developer. |

Events carry additional provenance facets beyond method — organizer, venue, contributor — because events have richer structure than the other primitives. The event-specific application of this doctrine is documented in [four-roles.md](four-roles.md).

## What having a method field gets us

Six load-bearing jobs, the same across primitives:

1. **Authority chain.** Who is on record for the claim. Who corrects errors. Where a downstream consumer goes to verify.
2. **Trust calibration.** Readers and consumer apps can rank, filter, or label data by authority shape. A self-asserted event from a verified organization carries different weight than a witnessed flyer.
3. **Liability and rights posture.** Different methods imply different legal positions. Self-asserted: the entity has full rights. Proxied: relies on the URL being a public statement, the contributor doing faithful extraction. Witnessed: relies on the photographed material being non-restrictive.
4. **Verification scope.** `seeded` is the explicit signal "needs first-party uptake." Verification tooling targets seeded rows to flip them to `self_asserted`.
5. **Editorial / admin review.** Operators prioritize seeded and witnessed rows for review; self-asserted rows from verified orgs are higher-confidence by default.
6. **Operational observability.** Ecosystem health is legible by method, per primitive. How many events are self-asserted vs. proxied vs. witnessed? How many orgs are still seeded? These are the right questions; the substrate makes them askable.

## Authorized vs. used

A separate but adjacent design point: what a contributor is *authorized to do* is distinct from what method any given row uses. Merrie is authorized for `self_asserted`. A pipeline tool is authorized for `proxied`. Fiber is authorized for `witnessed`. That's a per-contributor capability set, modeled today partly via `api_keys.witness_authority` (a generalization is reasonable later). The per-row `method` is the specific choice made at write time, validated against the contributor's authorized set.

## What this doctrine forbids

- **Adding a new primitive without a `method` field** (even if only one value is valid today). Symmetry matters; the field is the convention.
- **Inventing per-primitive vocabulary** when the standard values fit. New values should be admitted to the standard vocabulary only when an existing one genuinely doesn't describe the authority chain.
- **Conflating transport with authority.** `'api'`, `'portal'`, `'csv'` are transports — they describe how the bytes arrived. Transports are operational, not provenance. They don't belong in the method field.
- **Per-event/per-row liability disclaimers** that try to do the work of `method`. The field is the single structured answer.

## What this doctrine permits

- **New method values** for primitives that admit them, when a new authority shape emerges (e.g. `stewardship_attestation` for community-vouched data — a future addition once the pattern crystallizes).
- **Per-primitive rules** about which values are valid (a `lists.method` of `witnessed` is meaningless, so the check constraint rejects it). The vocabulary is standard; the per-primitive validity is the rule.
- **Rendering variations across consumers.** This doctrine governs what the substrate *holds*. Consumer UIs are free to surface, suppress, or restyle method-derived information however they want.

## Tests against this doctrine

Before shipping any change to a public-fact primitive, ask:

1. Does this primitive have a `method` field? If no, why not?
2. Does the field's vocabulary draw from the standard set, or is it inventing per-primitive names?
3. If a new method value is being added, does it describe an authority chain that isn't covered by an existing value?
4. Is anything in the row playing a method-shaped role (a "type" field, a "source kind" field, a "provenance type" field) that should be unified with `method`?

A "no" or "yes, but" to these is a signal the change is fighting the doctrine rather than living within it.
