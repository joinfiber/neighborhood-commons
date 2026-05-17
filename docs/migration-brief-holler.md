# Migration Brief: Holler

**For:** A Claude Code session opened in the Holler repository.
**Purpose:** Audit Holler for impact from the Neighborhood Commons v2 release, and produce a structured assessment so we can sequence the migration work.

## What this is

The Neighborhood Commons is moving to v2 — a coherent set of breaking changes that simplifies the substrate around a tighter conceptual model. Holler is a business-facing publisher app (brick-and-mortar businesses managing their profiles, broadcasts, and verification). The v2 changes that affect Holler are mostly simplifications — fewer concepts to model, narrower verification scope, simpler messaging.

Before reading further, **load the supporting context** from the Neighborhood Commons repo at `C:\dev2\neighborhood-commons\`:

- `CLAUDE.md` — the v2 model articulated in full (mission, Type A/B framing, no-users principle, constrained publishing, three authority paths)
- `docs/v2-migration-plan.md` — the migration sequence and what each phase does
- `docs/future-considerations.md` — items deliberately deferred
- `docs/classifieds.md` — the sustainability story (Holler is a likely partner for classifieds eventually, so this is relevant)

Read those first. The rest of this brief assumes that context.

## The v2 changes relevant to Holler

Holler is the brick-and-mortar business interface. Its primary surfaces are:

- Business signup and verification
- Business profile management (Type A profile data)
- Broadcasts (the ephemeral "kitchen open late" signals)
- Possibly: business-published events
- Possibly: profile display for reading

The v2 changes that affect each:

### Verification simplifies (the biggest change)

The verification system's job in v2 is narrow: anchor Type A authority for organizations. Email loop to the business's public contact, attestation recorded, done.

What goes away from the previous framing:

- **Cross-app reputation graph.** "Verified by N apps" is no longer a meaningful signal. The `/v1/verifiers` endpoint is removed.
- **Portable verification credentials.** The Commons doesn't maintain portable identifier credentials across apps. When a business verifies via Holler, that verification is recorded in the Commons — but it isn't a credential the business carries to other apps. If they later sign up for another app, that other app does its own verification.
- **Polymorphic target_type.** Only organizations verify (no persons). The `targetType` field is removed from verification request/response shapes.

What stays:

- Email loop verification via the `domain_email_loop` method
- Manual review path for entities without clean email-loop access
- The attestation record (org, method, time, attesting service key)
- The `verified` boolean on organization responses

What this means for Holler's messaging:

The verification flow shouldn't promise things like "verified once, recognized everywhere." The honest framing: verification confirms the business is who they say they are, and that fact is recorded publicly. Other apps that read the Commons see the verified flag. That's the entirety of the cross-app portability — a single boolean that other apps can choose to honor.

### Persons primitive goes away

Solo operators (a sole-proprietor business with a public name) are organizations in v2. There's no Person primitive. If Holler has any UI distinguishing "person-owned business" from "company," collapse — everyone is an organization.

### Kind discriminator goes away

Organizations no longer have a `kind` field (the enum that was `local_business`, `business`, etc.). Replaced by:

- `commercial` (boolean, nullable) — for-profit or non-profit
- `tags` (text[], nullable) — free-form descriptive labels

If Holler's signup asks "are you a local business or a different kind of business?", that question doesn't need to be in the signup flow anymore. Holler's audience is brick-and-mortar businesses, so `commercial: true` is the default; the structural fact (has a primary_place_id) makes it a place-bound business.

### Endpoint changes

- `/v1/accounts` → `/v1/publishers`. If Holler reads account data anywhere, migrate.
- `/v1/persons` removed.
- `/v1/verifiers` removed (the reputation graph).

### Place categorization comes from OSM

Under v2, places have `place_categories` (text[], sourced from OpenStreetMap, stored under ODbL licensing) and `category_source`. If Holler displays place categorization ("Coffee Shop", "Bar", "Salon"), this is the new field to read. Google Places API can still be consulted at runtime for reference but its response data is not stored long-term in NC.

### Service API event writes (if Holler publishes events)

If Holler lets businesses publish events (vs. just managing profile + broadcasts), every event write must include `organizer_org_id`. The calling service key must be linked to that org via `api_key_organization_links`.

Likely Holler already does this correctly since it operates on the per-business model. Worth confirming.

### Broadcasts (probably no change)

The broadcasts primitive is unchanged in v2. If Holler's broadcasts publishing works today, it should keep working — same shape, same Service API endpoints, same 24-hour expiry.

Worth checking: does Holler require the organization to be verified before allowing a broadcast? In v2, broadcasts don't require verification (apps decide whether to surface unverified broadcasts in their feeds). If Holler currently gates broadcast creation on verification, that's an app-level decision and is fine to keep — just note it.

### Possibly: OSM opt-in toggle (new affordance, optional)

Similar to Merrie, Holler could offer verified businesses an opt-in to share their basic profile data with OpenStreetMap. This is new functionality, not a removal. Whether Holler implements it is a Holler-side product decision. The mechanism would be the same as Merrie's (consent recorded, data eligible for OSM push by Studio's future contribute-back tool).

## What to audit in Holler

Walk Holler's code and answer these questions. Be specific — file paths, route names, component names where relevant.

### Verification flow audit

Find Holler's verification flow code and UX. Note:

1. What does the UX promise about verification? (If it implies cross-app portability or reputation-graph benefits, those promises need to come down.)
2. Where in the code does Holler initiate verification (call `/v1/service/verifications/path`, `/v1/service/verifications/challenges`, `/v1/service/verifications/manual`)?
3. Where does Holler render verification status? (Anywhere displaying "verified by other apps" needs to come down.)
4. Does Holler depend on the `targetType` field anywhere? (Remove.)
5. Does Holler's flow handle both `domain_email_loop` and `manual_review` methods? (Both stay in v2; just simpler underlying machinery.)

### Endpoint usage audit

Find every Commons endpoint Holler calls. Note:

1. `/v1/accounts` calls — migrate to `/v1/publishers`.
2. `/v1/persons` calls — remove.
3. `/v1/verifiers` calls — remove.
4. Service API calls — confirm organizer_org_id is set on event writes (if Holler publishes events).

### Signup flow audit

Find Holler's business signup flow. Note:

1. Does it ask about "kind" of business in a way that maps to NC's kind enum? (Drop the kind question; Holler's audience is by definition local businesses.)
2. Does it ask about person-vs-org structure? (Collapse.)
3. What's the simplified flow look like? (Business name, place, description, contact — that's mostly it. Tags optional, commercial defaults to true.)

### Profile management audit

Find Holler's profile-editing UX. Note:

1. Does it write to NC's organization endpoints (PATCH `/v1/service/organizations/:id`)?
2. Does it reference the `kind` field anywhere? (Remove.)
3. Does it reference the new `commercial` or `tags` fields? (Add if useful for Holler's UX.)
4. Does it support the new OSM opt-in toggle? (New affordance, optional.)

### Broadcasts audit

If Holler publishes broadcasts, check:

1. The publishing flow — does it work cleanly with v2's broadcast endpoints? (Should be unchanged.)
2. Verification gating — is Holler requiring verification before allowing broadcasts? (App-level decision; either way is fine.)

### Place categorization audit

If Holler displays place categories:

1. Where does the data come from currently? (If from Google's API directly: continues to work at runtime; can't be stored long-term. If from NC: needs to use the new `place_categories` field.)
2. Does Holler want to display the `category_source` to users? ("Categorized via OpenStreetMap" attribution is good practice.)

## The structured report

Produce a report in this exact shape so it can be compared with the other apps' reports:

```markdown
# Holler v2 Migration Assessment

## Showstoppers
[List any v2 change that would prevent Holler from operating or that requires a design decision before migration can proceed. Should ideally be empty.]

## Required changes
[Bulleted list of specific code changes needed. Include file paths and brief description. Group by surface (verification, endpoint calls, signup flow, profile management, broadcasts, etc.).]

## Estimated effort
[Rough estimate per change category. Use day/week granularity.]

## Open questions
[Things that need user input or design decisions. Be specific.]

## User-visible behavior changes
[What real Holler users will notice when v2 ships. Especially: any verification messaging changes; any "verified by other apps" UI that comes down.]

## Things that get simpler
[Net positives — code that gets to delete, complexity that goes away.]

## New affordances to consider
[The OSM opt-in toggle, anything else that v2 enables Holler to do better.]
```

## What to do with the report

Save the report somewhere Holler-side (probably `docs/commons-v2-migration.md` in the Holler repo). The operator will collect this report alongside Fiber's, Merrie's, and Studio's, and use them together to refine the v2 plan before NC migration code lands.

If your audit surfaces a showstopper or major surprise, flag it loudly. Holler's likely impact is moderate — most changes are simplifications — but the verification UX may need careful messaging work.

## A note on what isn't changing

Several things Holler depends on stay the same:

- The Service API authentication model (X-API-Key header)
- The per-business operational model
- The verification core mechanism (email loop, OTP, attestation)
- The image upload pipeline
- The CC BY 4.0 license
- The broadcasts primitive (unchanged in v2)

The migration affects specific surfaces (verification messaging, person primitive, kind discriminator, account → publisher endpoints) without disturbing the broader patterns that Holler depends on.

## A note on rolling

Holler and NC are operated by the same person. There's no external coordination overhead — no deprecation grace period, no compatibility shim. The cut is clean: NC ships v2, Holler updates to match. The audit's job is to surface what that "updates to match" actually entails, with particular attention to user-facing messaging around verification.

The discipline is: simplify Holler's verification story honestly, update the endpoint calls, and ship the migration cleanly.
