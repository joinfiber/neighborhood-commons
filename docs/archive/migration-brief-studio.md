# Migration Brief: Studio

**For:** A Claude Code session opened in the Studio repository.
**Purpose:** Audit Studio for impact from the Neighborhood Commons v2 release, and produce a structured assessment so we can sequence the migration work — especially given Studio is already slated for a rebuild.

## What this is

The Neighborhood Commons is moving to v2 — a coherent set of breaking changes that simplifies the substrate around a tighter conceptual model. Studio is the operator-facing tool: ingestion pipelines, admin operations, manual review queues, the contribute-back-to-OSM workflow (future). The v2 changes affect Studio more deeply than the reader/publisher apps because Studio touches almost every primitive in NC and uses the admin-level surface.

This brief is also context for the planned Studio rebuild. Some items here are "audit current code" and some are "design considerations for the rebuilt Studio." Both are valuable.

Before reading further, **load the supporting context** from the Neighborhood Commons repo at `C:\dev2\neighborhood-commons\`:

- `CLAUDE.md` — the v2 model articulated in full (mission, Type A/B framing, no-users principle, constrained publishing, three authority paths)
- `docs/v2-migration-plan.md` — the migration sequence and what each phase does
- `docs/future-considerations.md` — items deliberately deferred (including OSM contribute-back, which is Studio's future work)
- `docs/classifieds.md` — the sustainability story (Studio may eventually surface participating-publication management)

Read those first. The rest of this brief assumes that context.

## The v2 changes relevant to Studio

Studio's surfaces:

- Ingestion pipelines (scraping authoritative feeds, importing spreadsheets, partner integrations)
- Admin operations (manual verification reviews, content reports, account management)
- Place data curation (OSM-first, with Google-as-reference, admin-review for gaps)
- Service-tier writes with admin authority (bypasses scoping)

Each affected by v2:

### Persons primitive goes away

All ingestion paths that create persons in NC need to create organizations instead. A scraped DJ name becomes an organization (kind absent; tags + commercial describe). A performer lifted from a venue's calendar becomes either an organization (if they have a public handle) or a free-form `performer_name` string in `event_performers` (if they don't merit an org row).

### Kind discriminator goes away

Ingestion paths that currently set `kind` on organizations need to stop. Replace with `commercial` (where determinable from source) and `tags` (where the source has classification info). Or leave both null — the substrate permits unspecified entities, and consumer apps derive classification from structural signals.

### Endpoint changes

- `/v1/accounts` → `/v1/publishers`. Any Studio reads against `/v1/accounts` migrate.
- `/v1/persons` removed.
- `/v1/verifiers` removed.

### Place categorization workflow (the OSM-first pattern)

This is the biggest workflow change Studio needs to implement. The pattern:

1. **Ingest a place from a source** (scraping a venue website, importing from a spreadsheet, etc.). Store `google_place_id` and `place_id` if available.
2. **Query OpenStreetMap** (Overpass API or Nominatim) for the place's existing OSM data. Pull whatever categorization tags are there. Store as `place_categories` (text[]) with `category_source = 'osm'`.
3. **If OSM has gaps** (sparse data, no categorization, or admin judges it wrong): admin reviews the place. Studio can display Google's response as reference data **at runtime** (Google's terms permit this — the restriction is on caching/storing, not on displaying). Admin manually types in categories. Stored with `category_source = 'admin_review'` plus `category_reviewed_at` and `category_reviewed_by`.
4. **Publisher self-declaration** (future, via Merrie/Holler integration): when a verified publisher refines their place's categorization, that data is stored with `category_source = 'publisher_declaration'`.

The discipline: **Google's response data is never persisted.** Only `google_place_id` is stored (Google's terms explicitly permit indefinite storage of this). Other Google fields are displayed at runtime for reference, then discarded.

The future contribute-back-to-OSM tool will act only on `admin_review` and `publisher_declaration` rows. Never on data that traces back to Google.

### Witnessed-evidence authority (Fiber Community pattern)

New in v2: the `source_method = 'witnessed'` event-creation path, gated on `api_keys.witness_authority = true`. Studio (as the admin tool) may need to:

1. Surface `witness_authority` as a key-config option during admin key management
2. Surface witnessed-method events in any operator review queue (these may warrant different attention than normal events)
3. Possibly: surface the attached evidence (poster photo) for admin review

### Verification methods evolve

The v2 verification system retains:

- `domain_email_loop` (existing, default for businesses)
- `manual_review` (existing, for community groups without clean email-loop access — needs to be more first-class in Studio's admin UI)

And anticipates (future, see future-considerations.md):

- `stewardship_attestation` (a community body vouches for entities in their scope)
- Other evidence types as needed

Studio's manual review queue UI becomes more important under v2 because the constrained-publishing model formally recognizes community groups (the Fishtown Neighbors Association case) as a verification path that needs operator review. The queue should be easy to work through, the evidence should be presentable, and decisions should be recorded with reasoning.

### account_verified_identifiers → organization_verifications

The verification storage table is being simplified. Studio code that queries the old table needs to migrate to the new one. The polymorphic target_type field is gone (everything targets organizations).

### Legacy table removals

Studio likely has code touching tables that are being dropped in v2:

- `persons`
- `account_verified_identifiers`
- `api_key_account_links` (replaced by `api_key_organization_links`)
- `groups`, `group_venues` (legacy)
- `developer_otps` (legacy)
- Various business-profile columns on `portal_accounts` (data now lives on organizations)

Any Studio code referencing these needs updating.

### portal_accounts narrows

`portal_accounts` keeps only operational columns (email, claim, status, timestamps) in v2. Business profile data (business_name, default_*, logo_url, description, operating_hours, etc.) is gone from this table — it lives on organizations now.

Studio code that reads business profile data from portal_accounts needs to migrate to reading from organizations. Studio code that writes portal_accounts business profile fields needs to remove those writes (or write to organizations instead).

### Constrained publishing enforcement on Service API

Service API event writes will enforce `organizer_org_id` and the api_key_organization_links check. Studio's admin keys bypass scoping (they have `is_admin = true`), so this enforcement doesn't break Studio's writes — but Studio's writes should still set organizer_org_id correctly because it's required at the schema level (the column becomes NOT NULL in v2).

Studio ingestion pipelines that don't currently set organizer_org_id reliably need to do so. The backfill plan in the migration handles existing rows; new writes need to comply going forward.

## What to audit in Studio

Walk Studio's code and answer these questions. Be specific — file paths, function names, ingestion-pipeline names where relevant.

### Ingestion pipeline audit

For each ingestion pipeline (scraping, spreadsheet import, partner feed, etc.):

1. Does it write `kind` on organizations? (Stop; remove or transform.)
2. Does it write persons rows? (Migrate to organizations.)
3. Does it set `organizer_org_id` on every event write? (Required in v2.)
4. Does it set `source.contributor` honestly (attributing to the original source, not pretending to be the source)?
5. Does it touch `account_verified_identifiers` or `api_key_account_links`? (Migrate to the v2 replacements.)
6. Does it write to portal_accounts business profile columns? (Move to organizations.)

### Admin UI audit

Find Studio's admin surfaces. Note:

1. Manual verification review queue — how it works today, what needs to change.
2. Content reports / DMCA queue — should be unchanged but worth verifying.
3. Account management — does it expose persons? Kind? Cross-app verification reputation?
4. Place management — does it currently use Google's response data, OSM, or both? What needs to change?

### Place workflow audit

The OSM-first pattern is the biggest new workflow Studio needs to support:

1. Where does Studio currently get place data? (Google? OSM? Manual entry?)
2. What's the migration path for existing places that have Google-sourced data persisted? (May need a backfill from OSM, or just leave existing rows alone and apply the new pattern to new ingestions.)
3. What does the admin-review UI look like for places where OSM is sparse?
4. Where would the contribute-back-to-OSM tool live? (Future work, but worth noting design considerations.)

### Legacy code audit

Find every reference in Studio to:

1. `persons` table or person-related types
2. `account_verified_identifiers` table
3. `api_key_account_links` table
4. `groups` or `group_venues` tables
5. `developer_otps` table
6. `organizations.kind` field
7. `events.organizer_person_id` field
8. `lists.curator_person_id` field
9. `/v1/accounts`, `/v1/persons`, `/v1/verifiers` endpoints

Each is going away in v2. List what needs to change.

### Verification queue audit

The manual_review path becomes more important in v2 (community groups without email-loop access). Studio's manual review queue UI should be:

1. Visible — admin should see pending reviews easily
2. Informative — evidence should be presentable (bylaws, meeting minutes, photos, etc.)
3. Recordable — decisions should capture reasoning for audit
4. Efficient — common cases should be quick to approve/reject

Note what Studio currently has and what's missing.

### Admin key management audit

In v2, `api_keys.witness_authority` becomes a meaningful field. Studio should surface it during admin key creation/editing:

1. Where does Studio currently manage api_keys?
2. Where would `witness_authority` toggle naturally sit?
3. What's the policy for granting it? (Probably: only for apps with clear collective-witnessing patterns like Fiber's OCR contribution.)

## Design considerations for the Studio rebuild

Beyond the migration audit, the rebuild should be designed with v2 in mind:

### OSM-first as the default place pattern

The rebuilt Studio should:

- Make OSM queries the default for place ingestion
- Surface Google's response as reference during admin review (at runtime, never stored)
- Have a clear admin UI for places where OSM is sparse
- Track `category_source` reliably so future contribute-back acts on the right rows
- Eventually: include the OSM contribute-back tool (Phase 5 of v2-migration-plan.md)

### Manual review queue as first-class

The verification system's narrow scope makes manual_review the path for community groups, which is a real use case. The rebuilt Studio should have:

- A dedicated manual review queue with filters and sorting
- Evidence display (text, attached documents, links)
- Decision recording with reasoning
- Audit trail per decision

### Contribute-back to OSM (future)

When verified data flows through Studio with publisher consent, Studio should be able to push that data to OSM. The rebuild should anticipate this:

- Track `osm_share_consent` from publishers
- Have a queued/batched push mechanism
- Use the OSM API with appropriate attribution (changeset comment indicating Commons-sourced)
- Only act on `admin_review` and `publisher_declaration` rows (never on data sourced from Google)

### Witnessed-method event review

If Studio surfaces an admin review for witnessed events (Fiber Community OCR contributions), the UI should:

- Show the attached evidence (poster photo) prominently
- Allow admin to flag false-claim events
- Allow admin to merge with venue-published events when the venue later posts

This is editorial work, distinct from verification review.

## The structured report

Produce a report in this exact shape so it can be compared with the other apps' reports:

```markdown
# Studio v2 Migration Assessment

## Showstoppers
[List any v2 change that would prevent Studio from operating or that requires a design decision before migration can proceed.]

## Required changes (audit results)
[Bulleted list of specific code changes needed in the current Studio. Group by surface (ingestion pipelines, admin UI, place workflow, verification queue, legacy code, etc.).]

## Rebuild design considerations
[Items the planned Studio rebuild should bake in from the start to align with v2. Distinct from migration of current code.]

## Estimated effort
[Rough estimate. Distinguish between (a) migrating current Studio code and (b) building the rebuilt Studio with v2 in mind.]

## Open questions
[Things that need user input or design decisions. Likely includes: OSM contribute-back design, manual review queue UI, place workflow specifics.]

## User-visible behavior changes
[What the operator (you) will notice when v2 ships. Includes: simpler verification UI, OSM-first place data, new manual review prominence.]

## Things that get simpler
[Net positives — code that gets to delete, dead concepts that go away.]

## New capabilities the rebuild should add
[OSM contribute-back, witness_authority management, place categorization workflow, etc.]
```

## What to do with the report

Save the report somewhere Studio-side (probably `docs/commons-v2-migration.md` in the Studio repo, or in a planning doc for the rebuild). The operator will collect this report alongside Fiber's, Merrie's, and Holler's, and use them together to refine the v2 plan and the Studio rebuild plan.

Studio's report is likely the longest and most detailed because Studio touches the most surfaces. That's expected — surface everything, let the operator prioritize.

## A note on what isn't changing

Several things Studio depends on stay the same:

- The admin-key authentication model (`is_admin = true` bypasses scoping)
- The image upload pipeline
- The webhook system
- The audit log infrastructure
- The CC BY 4.0 license on published data

The migration affects specific surfaces (persons gone, kind gone, verification simplified, place workflow OSM-first) without disturbing the broader admin operations infrastructure.

## A note on Studio's distinctness

Studio is the operator's personal power tool. It doesn't need to scale to many users; it needs to be efficient at the operator's curation and admin work. This frees Studio from many normal product constraints (no need for accessible UI for unfamiliar users, no need for elaborate onboarding) — but raises the bar on efficiency at the operator's specific tasks.

The rebuilt Studio should optimize for: how fast can the operator move through a queue of 100 places needing review? How easily can the operator approve a community-group verification with evidence? How clearly does the OSM contribute-back workflow surface what's safe to push? Those are the design questions.
