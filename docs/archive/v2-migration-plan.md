# Neighborhood Commons v2 — Migration Plan

The shape of the v2 release: what changes, why, and in what order. This document is the operator-facing reference for the migration. The grant letter and partner conversations may draw from it; downstream apps (currently all operated by the Commons operator) use it to coordinate their own transitions.

## Context

v1.x was built on an earlier conceptual model that included several features which, on reflection, didn't earn their keep:

- A `Person` primitive distinct from `Organization`
- A `kind` enum on organizations that mixed structural, vibe, and legal-status dimensions
- A `Curator` role and corresponding wild-west event publishing path
- An elaborate cross-app verification reputation graph with portable identifier credentials
- An `/v1/accounts` endpoint that conflated publisher identity with user accounts
- Implicit allowance for user PII to land in the Commons via portal_accounts business profile fields

v2 cuts all of these. The reasoning is articulated in [CLAUDE.md](../CLAUDE.md); this document is the migration sequence.

The Commons currently has one consumer ecosystem (the operator's own apps: Fiber, Merrie, Holler, Studio). This dramatically simplifies the migration — no grace periods, no compatibility shims, no deprecation outreach. We make the cut, we update the ecosystem apps.

## What v2 looks like

After migration:

**Schema:**
- Five primitives (places, organizations, events, broadcasts, lists). No persons.
- Organizations have `tags` (text[]) and `commercial` (boolean); no `kind`.
- Events have required `organizer_org_id`; no `organizer_person_id`.
- Lists curate via `curator_org_id`; no `curator_person_id`.
- Verification simplifies to `organization_verifications` (no polymorphic `target_type`).
- `portal_accounts` narrows to operational columns (email, claim, status, timestamps).
- New: `place_categories` and `category_source` on places (OSM-sourced).
- New: `match_key` on events (internal dedup mechanism).
- New: `witness_authority` boolean on api_keys; `source_method='witnessed'` enum value.

**API:**
- New: `/v1/publishers` reading from organizations.
- Removed: `/v1/accounts`, `/v1/persons`, `/v1/verifiers`, `/api/v1/contribute`.
- Service API event writes require `organizer_org_id` and key-org linkage.
- Webhook payloads reflect simplified organizer shape (always org reference).

**Spec:**
- OpenAPI bumped to reflect all removals/additions/changes.
- Comprehensive CHANGELOG entry with `BREAKING:` prefixes.

**SDK:**
- Major version bump to 2.0.0.
- Generated from new spec.
- TypeScript types reflect the new shape (no Person, no kind enum, single organizer shape).

## Migration sequence

The migration is one push because we have no external consumers to manage. Phases below are work-organization, not consumer-management gates.

### Phase 0 — Documentation (current)

**Goal:** Articulate the v2 model so all subsequent work is grounded. This phase is the substrate of grant work and partner conversations.

**Deliverables:**
- ✅ `CLAUDE.md` rewrite — converged model, principles, operational rules
- ✅ `docs/classifieds.md` — sustainability story for grant reference
- ✅ `docs/future-considerations.md` — parked decisions and reasoning
- ✅ `docs/v2-migration-plan.md` — this document
- ⬜ `public/llms.txt` rewrite — narrative guide aligned with v2
- ⬜ `public/index.html` rewrite — homepage aligned with v2
- ⬜ `docs/consumer-guide.md` rewrite — welcome mat aligned with v2 (or retire if not needed)

**Exit criterion:** All documentation reflects the v2 model consistently. Any reader (human or AI) encountering these docs gets a coherent picture of the substrate.

### Phase 1 — Schema migrations

**Goal:** Land all schema changes in production. Each migration is idempotent, numbered sequentially, tested against a fresh Supabase instance before merging.

**Migrations (in order):**

1. **Add new columns (non-breaking additions first):**
   - `organizations.tags text[]` (nullable)
   - `organizations.commercial boolean` (nullable)
   - `places.place_categories text[]` (nullable)
   - `places.category_source text` (nullable)
   - `events.match_key text` (nullable)
   - `api_keys.witness_authority boolean` (default false)
   - Extend `events.source_method` enum to include `'witnessed'`

2. **Migrate persons → organizations:**
   - For each row in `persons`, INSERT INTO `organizations` with matching slug, name, description, etc.
   - For each row in `events` with `organizer_person_id`, copy organizer linkage to `organizer_org_id` using the migrated org id.
   - For each row in `lists` with `curator_person_id`, copy to `curator_org_id` using migrated org id.
   - For each row in `account_verified_identifiers` with `target_type='person'`, copy to point at the migrated org.

3. **Create simplified verification table:**
   - `CREATE TABLE organization_verifications` with the simpler shape (no polymorphic target_type)
   - Copy active rows from `account_verified_identifiers` where `target_type='organization'`
   - Mark `account_verified_identifiers` for drop in a follow-up migration

4. **Enforce organizer authority:**
   - Backfill `events.organizer_org_id` from `creator_account_id → organizations.owner_account_id` for any null rows
   - Add `NOT NULL` constraint on `events.organizer_org_id`

5. **Drop deprecated columns and tables:**
   - Drop `organizations.kind` column
   - Drop `events.organizer_person_id` column
   - Drop `lists.curator_person_id` column
   - Drop `persons` table
   - Drop `account_verified_identifiers` table
   - Drop legacy tables: `groups`, `group_venues`, `api_key_account_links`, `developer_otps`
   - Drop unused business-profile columns from `portal_accounts` (those whose data now lives on organizations)

6. **Test fixtures and seed data:**
   - Update `migrations/seed.sql` to reflect new schema
   - Update test schema constants in `tests/schema-alignment.test.ts`

**Exit criterion:** All migrations applied to staging Supabase. Schema alignment tests pass. Test database reflects the new shape.

### Phase 2 — API changes

**Goal:** Update the Express API surface to match the new schema and the v2 conceptual model.

**Route changes:**

- **New: `GET /v1/publishers` and `GET /v1/publishers/:idOrSlug`**
  - Read from organizations
  - Return Type A profile data + verification status
  - Same data shape as the retired `/v1/accounts` but sourced honestly

- **Remove: `/v1/accounts` and `/v1/accounts/:idOrSlug`**
  - Return 410 Gone with pointer to `/v1/publishers`

- **Remove: `/v1/persons` and `/v1/persons/:idOrSlug`**
  - Return 410 Gone

- **Remove: `/v1/verifiers` and `/v1/verifiers/:appName/recent_approvals`**
  - Return 410 Gone

- **Remove: `/api/v1/contribute` (and `/contribute/batch`, `/contribute/mine`, `/contribute/:id`)**
  - Return 410 Gone with pointer to `/v1/service/events`

- **Remove: `/v1/service/persons` (POST, PATCH)**
  - Return 410 Gone

- **Service API event writes enforce authority:**
  - `POST /v1/service/events` requires `organizer_org_id` (camelCase: `organizerOrganizationId` or fold into `account_id` aliasing)
  - Verify calling key is in `api_key_organization_links` for that org, OR has `witness_authority=true` with `source_method='witnessed'`
  - Return `403 NOT_LINKED` on failure

- **Service API list writes constrain:**
  - List items must reference existing primitives only
  - Reject any create-and-add-in-one-shot patterns

**Transform changes:**

- Event response always has organization-shaped `organizer`. Drop polymorphic person/org logic from `event-transform.ts`.
- List response always has organization-shaped `curator`. Drop polymorphic logic.
- Verification responses drop `targetType` field.

**Exit criterion:** API integration tests pass against new shape. Spec viewer at `/spec` renders correctly. Manual smoke test through key endpoints.

### Phase 3 — Spec and SDK release

**Goal:** Publish v2.0.0 of the spec and SDK.

**Deliverables:**

- **Update `public/openapi.json`:**
  - Remove deleted endpoints
  - Add `/v1/publishers` paths
  - Update event/list response schemas (no person variants)
  - Update verification submission schemas
  - Add `place_categories`, `commercial`, `tags`, `claims-not-yet`, etc.
  - Bump spec metadata to reflect the new major

- **Update `sdk/package.json`:**
  - Bump version to 2.0.0
  - Regenerate types from new spec
  - Update SDK README with migration notes

- **Update `CHANGELOG.md`:**
  - Single comprehensive v2.0.0 entry
  - `BREAKING:` prefix on each removed/renamed item
  - Migration guide section: for each removed endpoint, what to call instead

- **Tag and release:**
  - `git tag sdk-v2.0.0` to trigger SDK publish workflow
  - Verify SDK published to npm successfully

**Exit criterion:** SDK 2.0.0 is on npm. Spec is published. CHANGELOG is comprehensive. The Commons Contract is updated and consistent.

### Phase 4 — Ecosystem app updates

**Goal:** Update the consumer apps (Fiber, Merrie, Holler, Studio) to work with v2. This work happens in those repos, not in the Commons repo.

This phase is the operator's work outside this codebase. Brief notes per app:

**Fiber:**
- Replace `/v1/accounts` calls with `/v1/publishers`
- Drop Person handling from organizer rendering
- Simplify tier rendering to use `first_party` boolean (no need for complex tier rules)
- Drop any `/v1/verifiers` reputation-graph consumption
- Update SDK to 2.0.0

**Merrie:**
- Stop offering curator/list-maker UI; curators contribute via Substack/feeds going forward
- Enforce `organizer_org_id` on every event write
- Treat solo performers (DJs, etc.) as organizations with `commercial`/`tags` describing them
- Update SDK to 2.0.0
- Add "share to OpenStreetMap" opt-in on venue self-declaration (future Studio work; Merrie just collects consent)

**Holler:**
- Simplify verification flow — single email loop, no cross-app reputation participation
- Update place display to use `place_categories` from OSM (when populated by Studio)
- Update SDK to 2.0.0

**Studio:**
- Rebuild per separate planning
- Adopt OSM-first place categorization workflow
- Build admin review for verification edge cases (manual_review method)
- Build place categorization workflow with real-time Google reference (display only, manual entry)
- Defer OSM contribute-back tool to Phase 5

**Exit criterion:** All four apps run against Commons v2 without errors. Visible features work end-to-end.

### Phase 5 — Post-v2 ongoing work

**Goal:** Watch what emerges. Refine. Build deferred items as demand appears.

**Activities (ongoing, not blocking):**
- Monitor Commons usage patterns
- Refine the `place_categories` and `tags` vocabularies as patterns emerge
- Build Studio's OSM contribute-back when verified data volume warrants
- Watch for publisher demand on the claims/declarations layer (see `docs/future-considerations.md`)
- Build classifieds when grant funding lands
- Document any unexpected patterns or required schema additions

**Exit criterion:** None. This phase is permanent operating mode.

## Critical-path dependencies

- Phase 0 (docs) blocks confident Phase 1-3 work because the docs articulate the target
- Phase 1 (schema) blocks Phase 2 (API) because routes depend on schema shape
- Phase 2 (API) blocks Phase 3 (spec/SDK) because the spec must reflect actual behavior
- Phase 3 (SDK release) blocks Phase 4 (ecosystem apps) because apps need the new types

Within each phase, work can parallelize across files but should be batched into coherent commits.

## Time estimate

Rough order-of-magnitude for the work in this repo (Phases 0-3):

- Phase 0 (docs): ~3-5 days
- Phase 1 (schema): ~3-5 days (mostly careful migration design + testing)
- Phase 2 (API): ~3-5 days
- Phase 3 (spec/SDK release): ~1-2 days

Total: ~2-3 weeks of focused work in this repo.

Phase 4 (ecosystem app updates) is operator's work elsewhere, sequenced as convenient.

## What this plan deliberately doesn't include

- **Classifieds implementation** — designed in `docs/classifieds.md`, built post-grant
- **Identity claims layer** — see `docs/future-considerations.md`, built when demand appears
- **Match-key clustering algorithm** — column exists, algorithm designed when dual-authority cases bite
- **OSM contribute-back tool** — Phase 5, in Studio
- **Multi-city federation** — see future considerations
- **New public-fact types beyond what exists** — additive in v2.x as use cases land

These are not in scope for the v2 cutover. v2 gets the existing model right; additive evolution continues from there.

## How to use this document

When working on any phase:
- Cross-reference with `CLAUDE.md` for principles and rationale
- Cross-reference with `docs/future-considerations.md` to avoid building deferred items
- Update this document if the plan changes — keep the operator's reference current
- When complete with v2, archive this document under `docs/archive/` and replace with `docs/v3-planning.md` (if and when v3 ever happens, which should be measured in years)

The migration is bounded. The discipline is to follow the plan, not to expand scope mid-flight.
