# Future Considerations

Decisions deliberately deferred. Each item here was considered during v2 design and explicitly scoped out — either because we lacked the data to design it well, because demand hasn't materialized, or because building it would have inflated scope without proportionate benefit. They are parked here so they aren't forgotten and so the reasoning for deferral is preserved.

When demand or evidence appears for any item below, the decision is to revisit, not to default-build.

---

## Identity declarations / claims layer

**What it is:** A structured opinion-space where organizations can self-declare specific identity claims for the purpose of being discoverable by people who care about those claims. Things like:
- `woman-owned`
- `worker-cooperative`
- `nonprofit-status`
- `union-shop`
- `BIPOC-owned`
- `queer-owned` / `queer-affirming`
- `family-owned`
- `veteran-owned`
- `accessibility-forward`
- `sustainability-focused`

These would sit alongside the descriptive `tags` field but with curated vocabulary and stronger signal-weight. Different from `tags` (which describe what something is like) and different from `kind` (which we deliberately don't have) — these are declarative identity claims a publisher opts into.

**Why deferred:** We don't have evidence of publisher demand yet. The right vocabulary emerges from observed practice, not from guessing what claims matter. Adding this upfront risks codifying a vocabulary that doesn't match what publishers actually want to claim.

**When to revisit:** When a publisher writes in asking "how do I declare we're worker-owned?" or when consumer apps express demand for filtering on identity attributes. At that point, design the layer with concrete use cases in hand.

**Shape it would probably take:**
- `claims text[]` column on organizations
- Curated vocabulary published at `/v1/meta/claims` with definitions for each recognized claim
- Optional verification attestation table if any claim needs evidence (B Corp status, etc.)
- Filter parameter on `/v1/organizations` and derived endpoints

---

## Match-key clustering algorithm

**What it is:** The internal mechanism for detecting when two event rows describe the same real-world occurrence. The `events.match_key` column exists in v2; the actual algorithm for computing it (and the clustering logic that consumes it) is sketched but not designed.

**Why deferred:** Under the constrained publishing model, most events come from one authoritative publisher. The dual-authority case (Studio scrape later superseded by venue verification; Fiber Community witnessing later superseded by venue posting) is real but rare. We can ship without a sophisticated clustering algorithm because most cases don't hit it.

**When to revisit:** When the dual-authority case starts producing visible duplicate rows in consumer apps, or when the volume of witnessed-evidence events grows enough that dedup becomes operationally meaningful.

**Open design questions:**
- What inputs compose the match key? (place_id + start time bucket + normalized title hash, probably)
- What time bucket fuzziness? (15 min? 30 min? 1 hour?)
- How is title normalization done? (lowercase, strip punctuation, strip common words like "the"?)
- When clustering finds a match, what happens to the duplicate row? (Soft delete? Reference? Stay separate with cluster_id?)
- Does the canonical view of a cluster shift over time as authority signals change?

These are worth designing carefully when the case matters. Premature design risks getting the algorithm wrong in ways that are expensive to change.

---

## OSM contribute-back tool in Studio

**What it is:** A workflow in Studio that pushes data back to OpenStreetMap when Studio has higher-quality data than OSM has. Either from admin review (Zac classifying a place that OSM doesn't have categorized) or from publisher self-declaration (a verified business confirming their hours, with consent to share with OSM).

**Why deferred:** Studio rebuild is a separate work track. The contribute-back is a nice-to-have that doesn't block the Commons v2 launch; it's a Phase 3 item that adds value once Studio has been rebuilt and verified data is flowing.

**When to revisit:** After Studio's rebuild and after enough verified data exists in the Commons to make contribution worthwhile. Likely 6-12 months post-v2.

**Discipline:** Only push data whose source license permits OSM redistribution under ODbL. That means publisher-declared (with consent) or admin-observed data — never data sourced from Google or other proprietary APIs.

**Workflow shape:**
1. Studio surfaces "OSM has gaps for this place" indicators during admin review
2. After classifying a place in Studio, admin gets a "push to OSM" option
3. After a publisher verifies and refines their place data, they're offered an opt-in to share with OSM
4. Pushes go through the OSM API with appropriate attribution to "Neighborhood Commons" as the changeset source

---

## Stewardship attestation verification method

**What it is:** A third verification method (alongside `domain_email_loop` and `manual_review`) where a designated community stewardship organization vouches for entities within its scope. Example: a neighborhood council verifies entities within its neighborhood. The stewardship body has authority granted by the Commons operator; their attestations are recognized.

**Why deferred:** No current stewardship body exists in this role. Building the mechanism before there's an actual partner to use it produces speculation rather than design.

**When to revisit:** When a neighborhood council, BID, civic federation, or similar body expresses interest in onboarding multiple entities at once with their attestation as the trust anchor.

**Shape it would probably take:**
- Extension of the `organization_verifications.method` enum to include `stewardship_attestation`
- A registry of recognized stewardship bodies (an `organizations` row with a `stewardship_authority` flag, similar to `witness_authority` on api_keys)
- Documentation about which bodies are recognized, for which scopes, with what review process
- Standard onboarding flow for stewardship bodies (similar to service key activation)

---

## Federation across cities

**What it is:** Running multiple Commons instances (Philadelphia, Pittsburgh, others) that federate data, share schemas, and allow consumer apps to query across regions.

**Why deferred:** We're not at the point of needing this. Philadelphia is the focus. Multi-city expansion is itself a separate strategic question that depends on factors beyond the schema (who runs the other instance, who funds it, governance).

**When to revisit:** When a city outside Philadelphia has a concrete partner ready to run a Commons instance and consumer apps express demand for cross-city data.

**Shape it would probably take:**
- Each city runs its own Commons instance with shared schema and SDK
- A federation layer that allows queries to span instances (or a meta-Commons that proxies)
- Per-instance governance with shared standards
- Possibly: shared `places` table or place-deduplication across instances

This is more an organizational/governance question than a technical one. The technical pieces are tractable; the institutional shape is the harder problem.

---

## Additional public-fact types

**What it is:** Schema.org-aligned types beyond the current five primitives. Candidates:
- **Civic notices** — zoning hearings, public meetings, RFPs, public-health alerts
- **Jobs** — job postings from organizations (overlaps with classifieds but possibly distinct)
- **Real estate listings** — for-sale and for-rent properties (overlaps with classifieds)
- **Service offerings** — structured directory of services offered by organizations
- **Public-health alerts** — issuing-agency-published alerts
- **Government meetings** — city council, school board, public hearings (could be `events` with a specific tag, or a distinct type)

**Why deferred:** Each addition is its own design question. Adding all of them upfront would inflate v2 scope. The right time to add each is when there's a concrete partner, ingestion pipeline, or consumer use case.

**When to revisit:** As each use case materializes. Each addition is an additive schema/spec change, not a breaking one — so they can come anytime in v2.x.

**Discipline for additions:**
- Must map to a Schema.org type (or have clear analog)
- Must serve the public-facts mission (descriptive, not editorial)
- Must have a concrete consumer use case before building
- Must follow the constrained publishing principle (publishers with authority)
- Must respect the additive-only stability discipline

---

## Performer linking improvements

**What it is:** Richer modeling of event lineups — currently the `event_performers` table supports either an `organization_id` reference or a free-form `performer_name` string. Future improvements might include:
- Distinguishing headliner from opener from host
- Set times within a multi-act event
- Tour tracking (a performer's events across venues)
- Performer-to-performer relationships (frequent collaborators)

**Why deferred:** Current model is sufficient for most cases. Richer modeling requires consumer-app demand that hasn't materialized.

**When to revisit:** When a consumer app needs structured lineup data and the free-form `performer_name` plus single `organization_id` per performer position isn't enough.

---

## Spec contribution upstream

**What it is:** Contributing the patterns we've developed in NC back to the upstream [Neighborhood API spec](https://github.com/The-Relational-Technology-Project/neighborhood-api). Specifically:
- The Type A / Type B framing
- The constrained publishing model
- The narrow verification scope
- The witnessed-evidence authority path
- The classifieds primitive (when implemented)
- The "no users in the Commons" principle as a spec recommendation

**Why deferred:** We're still refining these patterns in our implementation. Upstream contribution is more valuable once we have lived experience with them — a year or so of production use that can inform what to standardize.

**When to revisit:** When patterns have settled and we have evidence about what works. Probably 12-18 months post-v2.

---

## Webhook payload extension

**What it is:** Richer webhook payloads — currently webhooks deliver the event/organization/etc. in spec shape. Possible extensions:
- Diff payloads (what changed in an update)
- Cluster context (when an event is part of a match-key cluster)
- Authority transitions (when first_party flips on an event)

**Why deferred:** Current payloads are sufficient for consumers' actual use cases. Extensions add complexity for marginal benefit until consumers explicitly need them.

**When to revisit:** When a consumer asks for richer payload shapes for a specific use case.

---

## Multi-language support

**What it is:** Support for content in languages other than English. Event names, descriptions, organization profiles in Spanish, Mandarin, Vietnamese, etc.

**Why deferred:** Single-language is sufficient for the initial Philadelphia focus. Adding multi-language is a meaningful design question (translation overhead, fallback rules, attribution) that should follow demand rather than precede it.

**When to revisit:** When a meaningful portion of publishers want to publish in a non-English language, or when consumer apps serving non-English audiences need this.

**Shape it might take:**
- Per-field language tags (`name_en`, `name_es`, etc.) or
- A separate `translations` table that joins to entities or
- A single canonical-language field plus translations as overlays

Each shape has trade-offs. Design when the case is concrete.

---

## Observability/telemetry surface for consumers

**What it is:** A way for consumer apps to see their own usage patterns, the freshness of data they're consuming, and the health of their integration. Like a dashboard but exposed as data.

**Why deferred:** Currently the operator (Zac) handles consumer health through direct relationship. Once there are external consumers, self-service observability becomes more valuable. With one consumer (ourselves), it's overhead.

**When to revisit:** When external consumers join the ecosystem and direct relationship doesn't scale.

---

## How to use this document

When making decisions during v2 work or post-v2 maintenance:

1. **If you're tempted to build something, check here first.** Many things are deferred for good reasons. The reasoning matters.
2. **If demand arrives for a deferred item, revisit the decision.** Don't just build because someone asked once. Look at whether the patterns we deferred against are still valid.
3. **If you add an item to this list, include the why and the revisit trigger.** The list is only useful if it explains its own reasoning.
4. **Don't promise these to anyone.** This is internal planning. Items here may never be built. Items here may be built in different shapes than sketched.

The discipline is: thin Commons, additive evolution, demand-driven feature work. This document is the parking lot that supports that discipline.
