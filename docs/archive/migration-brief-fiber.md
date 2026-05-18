# Migration Brief: Fiber

**For:** A Claude Code session opened in the Fiber repository.
**Purpose:** Audit Fiber for impact from the Neighborhood Commons v2 release, and produce a structured assessment so we can sequence the migration work.

## What this is

The Neighborhood Commons is moving to v2 — a coherent set of breaking changes that simplifies the substrate around a tighter conceptual model. This brief tells you (the Claude Code session reading it) what's changing, what to look for in Fiber's code, and how to report back.

Before reading further, **load the supporting context** from the Neighborhood Commons repo at `C:\dev2\neighborhood-commons\`:

- `CLAUDE.md` — the v2 model articulated in full (mission, Type A/B framing, no-users principle, constrained publishing, three authority paths)
- `docs/v2-migration-plan.md` — the migration sequence and what each phase does
- `docs/future-considerations.md` — items deliberately deferred
- `docs/classifieds.md` — the sustainability story (won't affect Fiber directly but provides full context)

Read those first. The rest of this brief assumes that context.

## The v2 changes relevant to Fiber

Fiber is primarily a reader app, with one contribution path (the OCR/Fiber Community flyer scanning). The v2 changes that affect Fiber:

### Endpoint removals

These endpoints return 410 Gone in v2:

- `GET /v1/accounts` and `GET /v1/accounts/:idOrSlug` → replaced by `GET /v1/publishers` / `GET /v1/publishers/:idOrSlug`. Same data shape, sourced from organizations instead of from portal_accounts.
- `GET /v1/persons` and `GET /v1/persons/:idOrSlug` → removed entirely. Solo performers/DJs are now organizations (kind absent; tags + commercial describe them).
- `GET /v1/verifiers` and `GET /v1/verifiers/:appName/recent_approvals` → removed. The cross-app reputation graph is retired.

### Response shape changes

- **Event `organizer`** is always an organization reference. Previously could be polymorphic (organization or person). Now there is no person variant.
- **List `curator`** is always an organization reference. Same simplification.
- **Verification responses** drop the `targetType` field (only organizations verify).
- **Organization responses** drop the `kind` field. Replaced by `commercial` (boolean, nullable) and `tags` (text[], free-form descriptive).
- **Place responses** gain `place_categories` (text[], OSM-sourced) and `category_source` (text).

### Authority model changes

- **The cross-app verification reputation graph is retired.** "Verified by N apps" is no longer a meaningful signal. Verification anchors Type A profile authority for organizations only, and that's its entire job.
- **The tier rendering rule simplifies dramatically.** What Fiber was previously sketched to do as a three-tier rule (verified-publisher / niche-app / public-listings) collapses to a single signal: `event.first_party === true` means the verified organizer published it themselves; otherwise it's an aggregated/contributed event. Niche-app rendering remains a Fiber editorial choice (the `APP_IS_PROVENANCE` pattern Fiber already has), but it isn't a Commons-side data field.

### Witnessed-with-evidence (Fiber Community OCR)

The OCR contribution path is preserved and given proper schema support:

- Events created via Fiber Community OCR use `source_method = 'witnessed'` and attribute to a `Fiber Community` organization (slug `fiber-community`, kind absent, tags include `app-collective` or similar).
- Fiber's service key needs `witness_authority = true` to use the witnessed path. This is granted at activation; no API change for Fiber, just a key-config change to verify.
- The poster image attaches to the event as the documentary record. Discipline: only upload images Fiber's user actually photographed (no scraped images).

### Webhook payload changes

- The `organizer` block in event webhook payloads always references an organization. If Fiber's webhook handler currently has any code paths for person organizers, those paths are dead under v2.
- The `verified_by[]` field that the earlier provenance brief proposed is **not** added. Verification status is exposed as a single boolean on the organizer (`verified`) plus the event's `first_party` flag. That's the entire authority surface.

## What to audit in Fiber

Walk Fiber's code and answer these questions. Be specific — file paths, function names, line numbers where relevant.

### Endpoint call audit

Find every place Fiber calls a Commons endpoint. Note especially:

1. Any call to `/v1/accounts` or `/v1/accounts/:id`. These need to migrate to `/v1/publishers`.
2. Any call to `/v1/persons` or `/v1/persons/:id`. These need to be removed; the underlying data is now on organizations.
3. Any call to `/v1/verifiers` or `/v1/verifiers/:appName/recent_approvals`. These need to be removed; the reputation graph is gone.
4. Any code that reads `targetType` on verification responses. This field is removed.
5. Any code that reads `kind` on organization responses. This field is removed; use `commercial` or `tags` if needed.

### Provenance / tier rendering audit

The provenance alignment brief from earlier (commit 8f92a88b and related work) sketched a complex tier model. Check what Fiber actually shipped:

1. Locate the tier-determination logic. Where does Fiber decide "this event is verified publisher vs. niche app vs. public listings"?
2. Locate the byline / "via X" rendering code.
3. Locate the "How this works" explainer logic and its three branches.

For each, determine what changes when:
- The tier rule simplifies to just `event.first_party === true`
- The `verified_by[]` field doesn't materialize
- The `organizer.claimed_at` field doesn't materialize (no such concept; orgs are claimed by `owner_account_id` which isn't publicly exposed)

The likely outcome: Fiber's tier logic gets simpler, not more complex. The provenance brief's elaborate three-tier structure collapses to a clean two-tier rendering: verified-organization-published vs. everything-else, with `APP_IS_PROVENANCE` still applying as an internal-to-Fiber rendering choice for niche-app feeds.

### OCR contribution audit

Find Fiber's OCR/poster contribution code path. Check:

1. The service key Fiber uses for contribution writes — does it currently have `witness_authority`? (If not, it needs to be granted at v2 cutover.)
2. The event creation request body — does it set `source_method = 'witnessed'`?
3. The organizer attribution — does it point at a `Fiber Community` organization in NC, or at the individual user?
4. The image upload path — is it only uploading images the user photographed (vs. scraped from elsewhere)?

### Webhook handler audit

Find Fiber's webhook receiving code. Check:

1. Any code that handles person-shaped organizer in event payloads. This path is dead in v2.
2. Any code that handles the `verified_by[]` field. Field doesn't exist in v2.
3. Any code that depends on the `targetType` field on verification webhook payloads (if Fiber subscribes to any verification events). Field doesn't exist.

### Place categorization audit

Fiber may render place type information ("Music Venue", "Coffee Shop") for context. Check:

1. Where does Fiber currently get place type signals? If it was deriving from Google Places API independently, that's fine and continues. If it was reading anything from the Commons that comes from Google's response data, that's not stored under v2.
2. Under v2, places have `place_categories` (OSM-sourced) and `category_source`. If Fiber wants to display structured place type info, this is the new field to read.

## The structured report

Produce a report in this exact shape so it can be compared with the other apps' reports:

```markdown
# Fiber v2 Migration Assessment

## Showstoppers
[List any v2 change that would prevent Fiber from operating or that requires a design decision before migration can proceed. Should ideally be empty.]

## Required changes
[Bulleted list of specific code changes needed. Include file paths and brief description of what needs to change. Group by surface (API calls, webhook handlers, tier rendering, OCR path, etc.).]

## Estimated effort
[Rough estimate per change category. Use day/week granularity.]

## Open questions
[Things that need user input or design decisions. Be specific about what you couldn't resolve from the brief and NC docs alone.]

## User-visible behavior changes
[What real Fiber users will notice when v2 ships. Be specific about UI/UX impacts.]

## Things that get simpler
[Net positives — code that gets to delete, complexity that goes away. Worth naming.]
```

## What to do with the report

Save the report somewhere Fiber-side (probably `docs/commons-v2-migration.md` in the Fiber repo). The operator will collect this report alongside Merrie's, Holler's, and Studio's, and use them together to refine the v2 plan before NC migration code lands.

If your audit surfaces a showstopper or major surprise, flag it loudly. Better to find it now than after schema migrations land.

## A note on what isn't changing

Several things Fiber depends on stay the same:

- The public read endpoints' rate limiting and authentication model
- The event response shape's core fields (id, name, start, end, location, etc.)
- The webhook signing mechanism (HMAC-SHA256, signing_secret)
- The CC BY 4.0 license
- The /v1/events filters (start_after, near, radius_km, category, etc.) — these are unaffected
- The image hosting (R2) and URL stability
- The ICS / RSS feeds

The migration affects specific surfaces (account/publisher endpoints, verification, organizer shape, kind field) without disturbing the broader reading patterns that Fiber relies on.

## A note on rolling

Fiber and NC are operated by the same person. There's no external coordination overhead — no deprecation grace period, no compatibility shim, no need to maintain v1 endpoints alongside v2. The cut is clean: NC ships v2, Fiber updates to match. The audit's job is to surface what that "updates to match" actually entails.

The discipline is: get the audit right so the update is bounded, predictable, and shippable in a defined window.
