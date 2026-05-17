# Migration Brief: Merrie

**For:** A Claude Code session opened in the Merrie repository.
**Purpose:** Audit Merrie for impact from the Neighborhood Commons v2 release, and produce a structured assessment so we can sequence the migration work.

## What this is

The Neighborhood Commons is moving to v2 — a coherent set of breaking changes that simplifies the substrate around a tighter conceptual model. Merrie is one of the apps that publishes into the Commons (as a tenant via the Service API), so several v2 changes affect Merrie's write paths and some affect Merrie's user-facing UX.

Before reading further, **load the supporting context** from the Neighborhood Commons repo at `C:\dev2\neighborhood-commons\`:

- `CLAUDE.md` — the v2 model articulated in full (mission, Type A/B framing, no-users principle, constrained publishing, three authority paths)
- `docs/v2-migration-plan.md` — the migration sequence and what each phase does
- `docs/future-considerations.md` — items deliberately deferred
- `docs/classifieds.md` — the sustainability story (not directly relevant to Merrie but provides full context)

Read those first. The rest of this brief assumes that context.

## The v2 changes relevant to Merrie

Merrie is a publisher app — it lets hosts, groups, venues, and (historically) curators publish events into the Commons. The v2 changes that affect Merrie are more substantive than for a reader app, because the constrained publishing model changes who's allowed to publish what.

### The big product change: curator role goes away

The constrained publishing model has three valid authority paths: **entity-runs-it**, **pipeline-proxies-an-authoritative-source**, and **witnessed-with-evidence**. There's no fourth path for "curator publishes events they didn't run or witness."

This means Merrie should no longer offer a curator / list-maker role for publishing events. Curators who want their picks in the Commons can:

- Run their curation in their own surface (Substack, Notion, Google Sheets, personal blog)
- Expose a structured feed (RSS, JSON, etc.)
- Have Studio's ingestion pipeline pull from the feed and attribute the events to the curator's identity via `source.contributor`

Merrie's job becomes purely: hosts, performers, groups, venues — entities publishing events they have authority over. Not third-party curation.

If Merrie has existing curator users, they need a transition plan (see "Open questions" later in your report).

### Persons primitive goes away

Solo performers, DJs, individual hosts — all become organizations under v2. There is no separate `Person` primitive in NC after v2.

This affects Merrie's signup flow if it currently asks "are you a person or a group?" That distinction collapses: everyone is an organization. A touring DJ becomes an organization-of-one (kind absent; `commercial: true` if they charge, `tags: ['dj', 'solo-act']` or whatever description fits).

### Kind discriminator goes away

Organizations no longer have a `kind` field (the enum that was `local_business`, `business`, `community_group`, `nonprofit`, `curator`, `collective`). Replaced by:

- `commercial` (boolean, nullable) — for-profit or non-profit/community-oriented; null means unspecified
- `tags` (text[], nullable) — free-form descriptive labels

Merrie's signup flow probably has a "what kind of organization are you?" question that needs to go away or transform. Consumer apps deriving classification do it from structural signals (events posted, place categories, tags, text). The Commons doesn't ask the publisher to bucket themselves.

### Event writes require organizer_org_id

The Service API now enforces this. Every event POST/PATCH must include `organizer_org_id` (or whatever the Service API surface names the field — currently `account_id` for backward compatibility). The calling service key must be linked to that organization via `api_key_organization_links`.

If Merrie's event write path doesn't currently set this reliably, it needs to. If Merrie creates organizations in the Commons on-demand when an event is posted for a new entity, that flow needs to set up the api_key_organization_links record so the subsequent event write is authorized.

### Service API list endpoints constrain

Lists in v2 are editorial overlays — sequences of references to existing primitives. Service API list endpoints will reject patterns that try to create events as part of list creation. If Merrie has list-creation flows that do this, they need to split into: create-event-first, then add-to-list.

(Whether Merrie even uses lists is worth checking; if the curator role is gone, lists may also be gone from Merrie's UX.)

### Endpoint changes

- `/v1/accounts` → `/v1/publishers`. If Merrie reads from `/v1/accounts` anywhere (e.g., to display publisher profiles), update to `/v1/publishers`.
- `/v1/persons` removed. If Merrie reads from this anywhere, remove.
- `/v1/verifiers` removed. If Merrie reads from this anywhere, remove.

### Verification flow simplifies

The verification flow for businesses still exists in v2 (email loop to the entity's public contact, attestation recorded). What goes away:

- The cross-app reputation graph framing ("verified by N apps")
- Portable verification credentials across apps
- The polymorphic target_type (only organizations verify)

If Merrie's verification UX positions verification as a "verified-once-portable-everywhere" feature, that messaging needs to change. The honest framing: verification confirms the entity is who they say they are; the verified status is recorded in the Commons; other apps that read Commons see the verified flag. That's the whole portability mechanism — no separate machinery.

### New: OSM opt-in toggle (new affordance for Merrie to add)

When a publisher verifies and refines their place data (hours, address, etc.), Merrie should offer an opt-in toggle: "Share basic information about your venue with OpenStreetMap, the open mapping data commons."

This is a new affordance, not a removal. The actual OSM contribution will be built later (in Studio, post-v2), but Merrie collecting the consent now means the data's ready to push when the contribute-back tool lands.

Default for the toggle: opt-out (default to yes), with a clear opt-out option.

## What to audit in Merrie

Walk Merrie's code and answer these questions. Be specific — file paths, route names, component names where relevant.

### Signup flow audit

Find Merrie's organization/account creation flow. Note:

1. Does it ask "what kind are you?" with kind-style options? (Drop or transform.)
2. Does it distinguish "person" from "organization" / "group"? (Drop the distinction; everyone is an organization.)
3. Does it ask anything else that v2 removes (curator role selection, etc.)?
4. What does the simplified flow look like? (Name, place, description — that's mostly it. Tags optional, commercial optional.)

### Event creation audit

Find Merrie's event-creation code paths. Note:

1. Does every event write set `organizer_org_id` (or `account_id` as the Service API names it)?
2. Are there event-creation paths that don't have a clear organizer? (These are the wild-west paths that need to go away or get an organizer attached.)
3. Does Merrie currently handle "person-organized" events differently from "org-organized" events? (Collapse: everyone is an org.)

### Curator/list-maker UX audit

Find every place Merrie has curator / list-maker concepts in its UI or write paths. Note:

1. What does the curator UX currently look like? Who uses it?
2. What's the data model in Merrie's own DB for curators?
3. How many active curator users does Merrie have?
4. What's the transition plan? Options include:
   - Convert curator accounts to organization accounts with `tags: ['curator']` (still in NC) but their existing "events I curated" UX goes away in Merrie
   - Help them export their curation to a Substack or similar and set up Studio to ingest from there
   - Just remove the feature and notify affected users

### List creation audit

If Merrie has list-creation flows, check:

1. Do any lists get created with new events in one shot? (Split into create-event-first.)
2. Are lists curated by organizations only, or are persons curating? (Collapse to org-curator.)
3. Does Merrie even need lists in its UX post-v2? (If curator role is gone, maybe lists are gone too.)

### Person/performer handling audit

Find every place Merrie distinguishes persons from organizations. Note:

1. Performer linking (who's playing the show)? — Persons collapse to organizations; or use the free-form `performer_name` on event_performers when the performer doesn't merit their own org row.
2. Solo host / DJ accounts? — Become organizations.
3. Any place in the UX that says "are you a person?" — drop.

### Endpoint usage audit

Find every Commons endpoint Merrie calls. Note:

1. `/v1/accounts` calls — migrate to `/v1/publishers`.
2. `/v1/persons` calls — remove.
3. `/v1/verifiers` calls — remove.
4. Service API calls — confirm organizer_org_id is set on event writes.

### Verification flow audit

Find Merrie's verification flow code (if Merrie surfaces it directly, vs. delegating to Holler). Note:

1. What does the UX currently promise about verification? (Cross-app reputation? Portable identity?)
2. What needs to change in the messaging to align with the narrower v2 verification scope?
3. Are there any UI elements that display "verified by N apps" or similar? (These come down.)

### OSM opt-in audit (new affordance)

This is new for Merrie to build. Note:

1. Where in the verification or profile-refinement flow would the OSM opt-in toggle naturally sit?
2. What's the consent UX? ("Share basic information about your venue with OpenStreetMap, the open mapping data commons. This helps neighbors discover your venue across many apps and tools.")
3. What data fields would be shared if opted-in? (Name, address, hours, basic categorization — not detailed event listings.)
4. Where would the consent get recorded? (Probably a column on Merrie's tenant-side org record, plus a flag passed in the Service API call so NC knows the org consented.)

## The structured report

Produce a report in this exact shape so it can be compared with the other apps' reports:

```markdown
# Merrie v2 Migration Assessment

## Showstoppers
[List any v2 change that would prevent Merrie from operating or that requires a design decision before migration can proceed. Should ideally be empty.]

## Required changes
[Bulleted list of specific code changes needed. Include file paths and brief description. Group by surface (signup flow, event creation, curator UX, endpoint calls, verification, OSM opt-in, etc.).]

## Estimated effort
[Rough estimate per change category. Use day/week granularity.]

## Open questions
[Things that need user input or design decisions. Be specific. Especially: the curator-user transition plan.]

## User-visible behavior changes
[What real Merrie users will notice when v2 ships. Especially: curator users losing their publishing path, signup flow simplification, verification messaging changes.]

## Things that get simpler
[Net positives — code that gets to delete, UX decisions that disappear.]

## New affordances to build
[The OSM opt-in toggle, plus any other new functionality v2 requires.]
```

## What to do with the report

Save the report somewhere Merrie-side (probably `docs/commons-v2-migration.md` in the Merrie repo). The operator will collect this report alongside Fiber's, Holler's, and Studio's, and use them together to refine the v2 plan before NC migration code lands.

If your audit surfaces a showstopper or major surprise, flag it loudly. The curator-user transition plan is the most likely source of substantive open questions — give that its full attention.

## A note on what isn't changing

Several things Merrie depends on stay the same:

- The Service API authentication model (X-API-Key header, tenant-umbrella pattern)
- The image upload pipeline (magic-byte check + Sharp re-encoding)
- The webhook subscription model
- The CC BY 4.0 license on published data
- The core event fields (name, start, end, location, etc.)

The migration affects specific surfaces (curator role, person primitive, kind discriminator, organizer enforcement) without disturbing the broader publishing patterns that Merrie depends on.

## A note on rolling

Merrie and NC are operated by the same person. There's no external coordination overhead — no deprecation grace period, no compatibility shim, no need to maintain v1 endpoints alongside v2. The cut is clean: NC ships v2, Merrie updates to match. The audit's job is to surface what that "updates to match" actually entails, especially the user-facing UX changes that real Merrie users will notice.

The discipline is: surface the curator-transition problem early, design the user-facing UX changes thoughtfully, and ship the migration in a defined window.
