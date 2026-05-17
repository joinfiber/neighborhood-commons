# Neighborhood Commons — Legal / IP / Privacy Risk Audit

**Audit date:** 2026-05-11
**Codebase commit:** `f1d98eb` (post-photo-gate)
**Audit scope:** all read/write/serve paths in `neighborhood-commons` that touch third-party content or PII.

---

## Posture & framing

The Commons is a thin neutral data layer. Its job is to store **facts** — uncopyrightable per *Feist v. Rural Telephone* — and let consumer apps (Fiber, Merrie, Go There, Holler) apply their own editorial filters on top. Original creative expression — photos, prose descriptions, logos, performer bios — requires an explicit rights-holder path, not a "we'll just store whatever you POST" path.

Where the audit finds the Commons accepting, storing, or republishing material it does not have the right to license, the recommendation is a **thin alternative**: drop the feature, narrow the storage, or gate the write. "Remove this feature; consumers handle it themselves" is a valid answer wherever the Commons is the wrong layer to be opinionated.

Severity scale:

- **CRITICAL** — actively storing or serving content the Commons cannot lawfully license, or operating without a foundational legal mechanism (e.g. DMCA agent).
- **HIGH** — feature enables CRITICAL outcomes under realistic usage by writers acting in good faith.
- **MEDIUM** — narrower exposure or specific input shapes; meaningful but not load-bearing.
- **LOW** — edge cases, hygiene items, or already mitigated by adjacent controls.

---

## Top issues to fix first

In order of leverage:

1. **No submitter terms; no DMCA agent.** The Commons asserts a CC-BY-4.0 license over redistributed content via [src/routes/v1.ts:344-362](C:/dev2/neighborhood-commons/src/routes/v1.ts) (`GET /events/terms`), but no submitter terms exist anywhere. Service registration ([src/routes/service/register.ts:46-57](C:/dev2/neighborhood-commons/src/routes/service/register.ts)) collects metadata but no rights attestation. No DMCA designated-agent registration. Together: the platform is asserting licensing rights it has no contractual basis for, and has no statutory safe-harbor cover. This is the legal foundation under which every other "we host user content" service operates. Fixable in an afternoon. **CRITICAL.**

2. **Free-text `description` is the main copyright vector.** `events.description` accepts up to 2,000 chars of arbitrary prose ([000_full_schema.sql:378](C:/dev2/neighborhood-commons/migrations/000_full_schema.sql)), republished verbatim through JSON, iCal, RSS, public HTML pages, and webhooks. Studio's scraper pipeline is the most likely current source of verbatim third-party prose, but any writer can do the same. Either cap hard and require attestation, or drop the column from the public read shape and let consumers fetch from `url`. **HIGH.**

3. **Organizations and Persons brand surfaces are wide open.** Any Service-tier key can `POST /v1/service/organizations` with `kind: 'local_business'`, a real venue's name, and the venue's logo URL — auto-linked to the calling key for editing ([service/organizations.ts:97-152](C:/dev2/neighborhood-commons/src/routes/service/organizations.ts)). Persons table has the same gap with `image_url`, `description`, `givenName/familyName` ([service/persons.ts:26-49](C:/dev2/neighborhood-commons/src/routes/service/persons.ts)). The photo gate (`canContributePhotos`) does not yet apply to orgs or persons. **HIGH** (trademark + right-of-publicity).

4. **Public HTML pages amplify everything.** `/events/:id` and `/venues/:slug` ([pages.ts:280-499](C:/dev2/neighborhood-commons/src/routes/pages.ts)) render every event and unclaimed venue as a Commons-branded, indexable landing page with Open Graph metadata and Schema.org JSON-LD. Whatever's broken upstream becomes a publicly crawlable, Commons-domain artifact. Either remove (right answer for a thin layer) or gate on `claimed_at IS NOT NULL AND first_party = true`. The widget at `/widget/events.js` is the supported embed; the HTML page is redundant.

5. **Legacy `portal_accounts` carries parallel risk.** The portal-accounts editorial fields (`description`, `logo_url`, `cover_image_url`, `phone`) on unclaimed accounts are the same gap migration 077 just closed for `event_image_url` — but applied to one column only, on one table. The accounts table still serves the rest. Also: `POST /v1/contribute/venues` ([contribute.ts:1077-1162](C:/dev2/neighborhood-commons/src/routes/contribute.ts)) is an open create path for anyone with an authenticated key. Migration 065 already plans to drop `portal_accounts` in 1.1 in favor of `organizations`; accelerate that, and meanwhile null the editorial fields on unclaimed rows.

---

## Catalog

### A. Free-text content storage and republishing

#### A1. Event `description` (up to 2,000 chars of free prose)
**File(s):** [migrations/000_full_schema.sql:378](C:/dev2/neighborhood-commons/migrations/000_full_schema.sql), [routes/contribute.ts:71,228,292](C:/dev2/neighborhood-commons/src/routes/contribute.ts), [routes/service/events.ts:90,560](C:/dev2/neighborhood-commons/src/routes/service/events.ts), [routes/v1.ts:633,738](C:/dev2/neighborhood-commons/src/routes/v1.ts), [routes/pages.ts:302,409](C:/dev2/neighborhood-commons/src/routes/pages.ts), [lib/event-transform.ts:203](C:/dev2/neighborhood-commons/src/lib/event-transform.ts), [lib/webhook-delivery.ts:325](C:/dev2/neighborhood-commons/src/lib/webhook-delivery.ts)
**What:** Free-text prose, capped at 2,000 chars. Contribute API `stripHtml()`s it; Service API stores verbatim. Republished verbatim in JSON, iCal `DESCRIPTION:`, RSS, HTML, webhook payloads.
**Risk:** Copyright — **HIGH**.
**Trigger:** Any pipeline that passes scraped/copy-pasted upstream prose without rewriting. Highly likely already happening in Studio's newsletter ingest.
**Thin alternative:** Drop from public read shape entirely and require consumers to fetch from `url`. Or hard-cap to ~200 chars + add `description_source: 'first_party' | 'verbatim_external' | 'paraphrased'` and refuse `verbatim_external` from non-claimed accounts the same way photos now are. Add policy text in the Service API 400 error: "description must be your own words or licensed for CC-BY-4.0 redistribution."

#### A2. Event `content` (title), `price`, `custom_category`
**Risk:** Copyright — **LOW**. Titles and short factual strings are below copyright threshold. Keep as is.

#### A3. Event `link_url`
**File(s):** [routes/contribute.ts:381-395](C:/dev2/neighborhood-commons/src/routes/contribute.ts), [lib/url-sanitizer.ts](C:/dev2/neighborhood-commons/src/lib/url-sanitizer.ts)
**What:** Outbound URL, validated against approved-domain list + sanitizer.
**Risk:** **LOW** — already gated; linking to copyrighted content is not infringing.

---

### B. Organization / business identity surface (trademark)

#### B1. `organizations` write API — open brand creation
**File(s):** [migrations/065_organizations_table.sql:14-39](C:/dev2/neighborhood-commons/migrations/065_organizations_table.sql), [routes/service/organizations.ts:97-152,259-287](C:/dev2/neighborhood-commons/src/routes/service/organizations.ts), [routes/v1-organizations.ts:70-258](C:/dev2/neighborhood-commons/src/routes/v1-organizations.ts)
**What:** Service-tier writers `POST /v1/service/organizations` with `name`, `legal_name`, `description` (2,000 char prose), `logo_url`, `image_url`, `keywords`, `sameAs`. Stored verbatim. The calling key auto-links on create, gaining edit rights ([line 136-145](C:/dev2/neighborhood-commons/src/routes/service/organizations.ts)). No verification gate on writes — `kind: 'local_business'` and `kind: 'community_group'` behave the same.
**Risk:** Trademark — **HIGH** (anyone can create "Starbucks" with a Starbucks logo URL). Copyright — **HIGH** (logo image + description prose). Image upload at line 259-287 is gated only by `assertLinkedOrganization`, but creation is the gap that lets you become the linked owner.
**Trigger:** Any Service-tier holder, including Studio scrapers, including malicious holders.
**Thin alternative:**
- Refuse `kind in (local_business, business, nonprofit)` from non-admin keys at create — funnel those through verification.
- Refuse external `logo_url` / `image_url` entirely; require the byte-upload path, which goes through the same photo gate.
- Cap `description` to 200 chars or remove; consumers hit the org's `url`.

#### B2. Org `email` and `telephone` on public read
**File(s):** [migrations/065:31-32](C:/dev2/neighborhood-commons/migrations/065_organizations_table.sql), [v1-organizations.ts:40,247-248](C:/dev2/neighborhood-commons/src/routes/v1-organizations.ts)
**What:** Stored and publicly served. For a `local_business` this is reasonable; for a `person`-kind Org this is a personal email exposed under anonymous read.
**Risk:** Privacy — **MEDIUM**. Harvest-and-spam target at scale.
**Trigger:** Mass org creation with scraped contact info.
**Thin alternative:** Drop `email` from the public read response. Keep `telephone` only for `kind=local_business`. Require an explicit `contact_email_public: bool` (default false) if email is kept.

#### B3. `portal_accounts` legacy editorial fields
**File(s):** [migrations/000_full_schema.sql:110-155](C:/dev2/neighborhood-commons/migrations/000_full_schema.sql), [routes/v1-accounts.ts:38-45,235-265](C:/dev2/neighborhood-commons/src/routes/v1-accounts.ts), [routes/service/accounts.ts:41-61](C:/dev2/neighborhood-commons/src/routes/service/accounts.ts), [routes/contribute.ts:1077-1162](C:/dev2/neighborhood-commons/src/routes/contribute.ts), [routes/pages.ts:437-499](C:/dev2/neighborhood-commons/src/routes/pages.ts)
**What:** Public `/v1/accounts` and the HTML `/venues/:slug` page serve `business_name`, `description`, `website`, `logo_url`, `cover_image_url`, `default_address`, `phone`, `operating_hours`. `POST /v1/contribute/venues` is an open create path for any authenticated key — no rights or trademark check.
**Risk:** Trademark — **HIGH** (anyone creates venue records named after real businesses). Copyright — **MEDIUM** (description prose on unclaimed accounts; photo path gated by f1d98eb). Spam vector for venue takeover — **MEDIUM**.
**Thin alternative:**
- Accelerate the migration 065 plan to drop `portal_accounts` in 1.1; collapse onto `organizations`.
- Until then: don't serve `description`, `logo_url`, `cover_image_url`, or `phone` on `/v1/accounts` when `claimed_at IS NULL`. Extend the 077 idea to all editorial columns.
- Gate `/venues/:slug` HTML on `claimed_at IS NOT NULL`.
- Refuse `POST /v1/contribute/venues` for non-admin keys, or make it find-only (no create).

#### B4. Public HTML `/events/:id` and `/venues/:slug` pages
**File(s):** [routes/pages.ts:280-499](C:/dev2/neighborhood-commons/src/routes/pages.ts)
**What:** Server-rendered HTML with full event/venue prose, hero image, Open Graph metadata, Schema.org JSON-LD. Publicly indexable; the Commons becomes the visible republisher.
**Risk:** Copyright + trademark — **HIGH** for unclaimed/scraped sources. Worst-of-both: data layer plus CMS surface.
**Trigger:** Any event or venue in the DB.
**Thin alternative:** Remove the per-event/per-venue HTML pages entirely. The widget at `/widget/events.js` is the supported embed. The Commons is not a CMS — that's Merrie's job. Alternative: gate on `claimed_at IS NOT NULL AND first_party = true`.

---

### C. Persons — right of publicity / privacy

#### C1. `persons` table + service write + public read
**File(s):** [migrations/066_persons_table.sql](C:/dev2/neighborhood-commons/migrations/066_persons_table.sql), [routes/service/persons.ts:26-49,108-156](C:/dev2/neighborhood-commons/src/routes/service/persons.ts), [routes/v1-persons.ts](C:/dev2/neighborhood-commons/src/routes/v1-persons.ts)
**What:** Service-tier writers `POST /v1/service/persons` with `name`, `givenName`, `familyName`, `alternateName` (stage names, aliases), `description` (2,000 char prose), `image_url`, `url`, `sameAs`, `jobTitle`. Stored verbatim and served publicly. The `event_performers` table attaches Persons to events without that Person's consent.
**Risk:** Right of publicity — **HIGH**. Privacy — **HIGH**. Defamation — **MEDIUM** (freeform description). Copyright — **MEDIUM** (image URL points to third-party photo). Name-and-likeness statutes in California, NY, most US states.
**Trigger:** Any writer creating a real performer's row from scraped lineup data.
**Thin alternative:**
- Apply the same `canContributePhotos`-style gate to `image_url`: refuse external URLs, require byte-upload, refuse upload unless the Person row is itself verified (or claimed by a future schema). For 1.0, refuse `image` writes entirely.
- Drop or cap `description` to 200 chars with attestation.
- Discourage `givenName`/`familyName` in the schema; default callers to `name` (display/stage name only).
- Build a public takedown loop: any caller can `POST /v1/report` against a Person row → soft-hide pending operator review.
- Add a `creator_key` link on Person rows so takedowns can identify the introducer.

#### C2. `event_performers` table
**File(s):** [migrations/068_event_performers.sql](C:/dev2/neighborhood-commons/migrations/068_event_performers.sql)
**What:** Many performers per event, each one a Person or Organization. No write checks today.
**Risk:** Right of publicity — **MEDIUM** (compounds Person risk). Empty surface today per migration comments.
**Thin alternative:** When the surface gets populated, require a `source` attestation per performer-row and a per-row takedown flag.

---

### D. Verifier reputation graph — operator-name disclosure

#### D1. `account_verified_identifiers.approved_by_app` + `evidence` on public read
**File(s):** [migrations/071_verification_tables.sql:34-35,99-101](C:/dev2/neighborhood-commons/migrations/071_verification_tables.sql), [routes/v1-verifiers.ts:40-169](C:/dev2/neighborhood-commons/src/routes/v1-verifiers.ts), [lib/verification-hydrate.ts](C:/dev2/neighborhood-commons/src/lib/verification-hydrate.ts)
**What:** `/v1/verifiers/:appName/recent_approvals` returns each approval's freeform `evidence` blob — example from `llms.txt`: *"Met owner Jane at the bar, confirmed identity via driver license; business address matches."*
**Risk:** Privacy — **HIGH** if evidence carries real names, license details, interview notes. The reputation graph is intentionally public; the freeform prose attached to it is the leak.
**Trigger:** Any verifying app submitting prose evidence.
**Thin alternative:** Strip `evidence` to a controlled vocabulary at submit, or move it to private storage. Public-read returns `method` + `verifiedVia` + `verifiedAt` + `verifiedByApp`, nothing more. Operators can pull the full set via the Service API.

#### D2. `verification_challenges.identifier_value`
**File(s):** [migrations/071:27-29,71](C:/dev2/neighborhood-commons/migrations/071_verification_tables.sql)
**What:** Plaintext email of the verifying business. RLS blocks anon read; not exposed publicly.
**Risk:** Privacy — **LOW** (already mitigated). Confirm the `evidence` selection in [v1-verifiers.ts:120](C:/dev2/neighborhood-commons/src/routes/v1-verifiers.ts) cannot carry the identifier_value.

---

### E. Outbound fetch / re-serving

#### E1. `nominatimGeocode` (OpenStreetMap geocoding)
**File(s):** [lib/geocoding.ts:42-88](C:/dev2/neighborhood-commons/src/lib/geocoding.ts)
**What:** Server-side fetch to `nominatim.openstreetmap.org/search`. Returns lat/lng, stored on the event row.
**Risk:** Database rights (ODbL on OSM data) — **LOW/MEDIUM**. ODbL §4.4 requires share-alike on derivative databases. Storing many resolved coords and republishing them under CC-BY-4.0 may run afoul. Also: Nominatim ToS requires attribution + 1 req/sec.
**Trigger:** Bulk geocoding during ingest.
**Thin alternative:** Add attribution to `/v1/events/terms` ("Geocoding by OpenStreetMap contributors, ODbL"). Long-term: route through Google Geocoding (already used for `googlePlaceId`) or Mapbox to keep Nominatim out of the persistent dataset.

#### E2. `downloadAndAttachImage` (the photo path)
**Status:** **RESOLVED** in commit `f1d98eb`. Gated by `canContributePhotos`. Noted for completeness.

#### E3. `safeFetch` SSRF chokepoint
**File(s):** [lib/safe-fetch.ts](C:/dev2/neighborhood-commons/src/lib/safe-fetch.ts)
**Risk:** Security, not legal. Already well-designed.

---

### F. Webhook delivery — content fanout

#### F1. Event webhooks carry full event shape
**File(s):** [lib/webhook-delivery.ts:112-150,217-265,397-454](C:/dev2/neighborhood-commons/src/lib/webhook-delivery.ts)
**What:** Every event create/update/delete is HMAC-signed and POSTed to subscribers. Payload includes `description`, `images[]`, `organizer.name`, etc.
**Risk:** Copyright/trademark — **HIGH**, but downstream of A1. Clean storage → clean webhooks. Separate concern: the Commons-subscriber contract is the only thing covering redistribution.
**Thin alternative:** Slim payload to facts: `id, name, start, end, timezone, location, category, url, source, recurrence`. Drop `description`, `images`, organizer prose. Subscribers pull the full event from `/v1/events/:id` if they want it. Consistent with "thin Commons" — webhook is a notification, not a syndication firehose.

---

### G. Submission terms and process gaps

#### G1. No submitter terms anywhere
**File(s):** [routes/v1.ts:344-362](C:/dev2/neighborhood-commons/src/routes/v1.ts), [routes/service/register.ts:46-57](C:/dev2/neighborhood-commons/src/routes/service/register.ts), [CONTRIBUTING.md](C:/dev2/neighborhood-commons/CONTRIBUTING.md), [SECURITY.md](C:/dev2/neighborhood-commons/SECURITY.md)
**What:** `/api/v1/events/terms` describes consumer terms (CC-BY-4.0). There are no submitter terms anywhere. Service registration collects `what_youre_building` prose but no rights attestation.
**Risk:** Database rights / submission terms — **CRITICAL**. The CC-BY-4.0 claim on outbound content is asserting a license over content the platform may not have the right to license.
**Thin alternative:**
- Add a `rights_attestation` literal field on the Service registration OTP-verify body. Refuse activation if the value differs from the canonical text.
- Add a `service_terms_version` column to `api_keys`. Refuse writes from keys whose version is behind current.
- Surface submitter terms in `CONTRIBUTING.md` and on `/v1/terms` (rename `/v1/events/terms` and split into `consumer_terms` + `submitter_terms`).
- Stamp `submitted_under_terms_version` on each write so future takedowns can identify what the submitter agreed to.

#### G2. No DMCA agent, no takedown process
**File(s):** [SECURITY.md](C:/dev2/neighborhood-commons/SECURITY.md), [public/llms.txt](C:/dev2/neighborhood-commons/public/llms.txt), [routes/v1.ts:360](C:/dev2/neighborhood-commons/src/routes/v1.ts), [routes/service/disputes.ts](C:/dev2/neighborhood-commons/src/routes/service/disputes.ts)
**What:** Only contact is `hi@neighborhood-commons.org`. No designated DMCA agent registered with the Copyright Office. No public takedown route. The disputes endpoint exists but only writes to `audit_logs` — no operator workflow.
**Risk:** DMCA safe-harbor — **CRITICAL**. 17 U.S.C. § 512(c) requires a designated agent registered with the Copyright Office AND prominently posted. Without it, the Commons cannot claim safe-harbor immunity.
**Thin alternative:**
- Register a DMCA agent with the U.S. Copyright Office ($6 every 3 years; ~10 minutes).
- Publish `/dmca` (HTML) and `/api/v1/dmca` (JSON) with the agent's address, the takedown process, and counter-notice instructions.
- Wire `/v1/service/disputes` to actually act: email operator, auto-flag the target row (`status='suspended'` for events, `status='pending_review'` for orgs, soft-hide for persons) pending review.
- Add unauthenticated, captcha-gated `POST /v1/report` so non-API-key users can file takedowns. Today `disputes` requires a service-tier key, which means only the perpetrators of infringement can report it.

#### G3. No "rights to image" attestation prompt
**File(s):** [routes/service/events.ts:96](C:/dev2/neighborhood-commons/src/routes/service/events.ts), [routes/service/organizations.ts:47-48](C:/dev2/neighborhood-commons/src/routes/service/organizations.ts), [routes/service/persons.ts:33](C:/dev2/neighborhood-commons/src/routes/service/persons.ts), [routes/contribute.ts:74](C:/dev2/neighborhood-commons/src/routes/contribute.ts)
**What:** Wherever image URLs are accepted, no inline attestation. The contributor-policy gate refuses unclaimed contributors entirely, but claimed contributors still have no surface acknowledging the rights requirement.
**Risk:** Process — **MEDIUM**.
**Thin alternative:** Require `image_rights_attestation: true` when `image_url` is non-null. Error message: "Set image_rights_attestation: true to confirm you have the right to publish this image under CC-BY-4.0."

#### G4. No public claim flow for unclaimed orgs / venues
**What:** No `/claim/<org-slug>` self-service path. Venue owners must discover Merrie or Studio first.
**Risk:** Process — **MEDIUM**. Stale unclaimed orgs accumulate (per migration 077); no obvious self-correction surface.
**Thin alternative:** Add public `/claim/<slug>`: emails OTP to the org's verified domain → creates an API key linked to the org. Reuses existing OTP infrastructure.

---

### H. PII / privacy minimization

#### H1. `/v1/service/accounts` exposes cross-tenant `email` + `auth_user_id`
**File(s):** [routes/service/accounts.ts:174,236](C:/dev2/neighborhood-commons/src/routes/service/accounts.ts)
**What:** Service-tier holders see all accounts' `email` and `auth_user_id`, not just their own linked accounts.
**Risk:** Privacy — **MEDIUM**. Cross-tenant leak between Service writers.
**Thin alternative:** Scope select to `assertLinkedAccount`-matching rows. Drop `auth_user_id` from the response entirely; admin keys get the full surface; non-admin service keys see only their own.

#### H2. `events.user_id` legacy column
**File(s):** [migrations/000_full_schema.sql:423](C:/dev2/neighborhood-commons/migrations/000_full_schema.sql)
**Risk:** Privacy — **LOW** (not selected by any current read path I checked, but vulnerable to wildcard selects).
**Thin alternative:** Drop the column.

#### H3. `audit_logs.metadata` retention
**File(s):** [lib/audit.ts:107](C:/dev2/neighborhood-commons/src/lib/audit.ts), [routes/service/disputes.ts:34-41](C:/dev2/neighborhood-commons/src/routes/service/disputes.ts)
**What:** Disputes drop `submitter_contact`, `submitted_by_app`, freeform `reason` into audit_logs. Cleanup purges after 90 days.
**Risk:** Privacy — **LOW/MEDIUM**. Submitter contact info (possibly personal email/phone) sits for 90 days.
**Thin alternative:** Document retention in the dispute response. Zod-cap and explicit "do not include other people's personal info" message at submission.

#### H4. `source_contributor_name` / `source_contributor_url` (free text)
**File(s):** [routes/service/events.ts:70-76](C:/dev2/neighborhood-commons/src/routes/service/events.ts), [lib/event-transform.ts:245-250](C:/dev2/neighborhood-commons/src/lib/event-transform.ts)
**What:** Per-event app attribution override ("via Go There"). Public.
**Risk:** Privacy — **MEDIUM** if writers misuse the field for a real person's name.
**Thin alternative:** Validate `contributor.name` against the calling key's `brand_config.app_name`. Forbid free-text. There's only one legitimate value per caller.

---

### I. Schema / process small items

#### I1. `sameAs` arrays accept arbitrary URLs
**File(s):** [routes/service/organizations.ts:51](C:/dev2/neighborhood-commons/src/routes/service/organizations.ts), [routes/service/persons.ts:35](C:/dev2/neighborhood-commons/src/routes/service/persons.ts)
**What:** Up to 20 URLs each, validated only as URLs.
**Risk:** Reputation / republishing of NSFW or malicious links — **LOW**.
**Thin alternative:** Allow-list of canonical-identity domains: wikipedia.org, wikidata.org, musicbrainz.org, soundcloud.com, instagram.com, x.com/twitter.com, linkedin.com, github.com, plus the org/person's own `url` domain.

#### I2. `groups` table — duplicate of organizations
**File(s):** [migrations/000_full_schema.sql:265-323](C:/dev2/neighborhood-commons/migrations/000_full_schema.sql), [routes/contribute.ts:1216-1499](C:/dev2/neighborhood-commons/src/routes/contribute.ts)
**What:** Legacy table writable via the Contribute API. Same fields as orgs minus the verification spine.
**Risk:** Duplicates the trademark/copyright surface on a table that lacks verification.
**Thin alternative:** Refuse Contribute writes to `groups` entirely. Service-tier callers use `organizations`. Drop in 1.1 per migration 065.

#### I3. Auto-link on `POST /v1/service/organizations`
**File(s):** [routes/service/organizations.ts:136-145](C:/dev2/neighborhood-commons/src/routes/service/organizations.ts)
**What:** Creating an org auto-links the calling key, making the caller editable-owner. Combined with no `owner_account_id` requirement, any service holder can become editorial owner of any-named org.
**Risk:** Trademark / brand-squatting — **HIGH** in conjunction with B1.
**Thin alternative:** Bundle into the B1 recommendation: admin-only or verification-pending for `kind in (local_business, business, nonprofit)`.

---

## Resolved / in-flight

- **Photo path (E2)** — gated at commit `f1d98eb`. Service API refuses `image_url` from unclaimed creators with 403 `IMAGE_NOT_PERMITTED`; `downloadAndAttachImage` defends at function entry. Existing affected rows nulled by migration 077; R2 byte cleanup pending via `scripts/scrub-unclaimed-creator-photos.ts`.

---

## Suggested roadmap

A reasonable sequence given the thin-Commons goal:

**Phase 1 — Legal foundation (one afternoon's work, blocks nothing else)**
- Register DMCA agent with the U.S. Copyright Office.
- Publish `/dmca` page and `/api/v1/dmca`.
- Add `rights_attestation` field + `submitter_terms` text to the Service registration flow.
- Add `service_terms_version` to `api_keys`; refuse stale writes.

**Phase 2 — Close the highest-leverage data leaks**
- Cap or drop `events.description` (A1) — pick a side.
- Slim webhook payload (F1) to facts.
- Apply `canContributePhotos`-equivalent to org logos and person images (B1, C1).
- Forbid external `logo_url` / `image_url` on orgs and persons; require byte upload.

**Phase 3 — Tighten brand surface**
- Refuse non-admin creation of `kind in (local_business, business, nonprofit)` orgs without verification (B1, I3).
- Drop `email` from `/v1/organizations` public read for non-business kinds (B2).
- Null editorial fields on unclaimed `portal_accounts` rows (B3, mirror of migration 077 for the rest of the columns).
- Gate or remove public HTML `/events/:id` and `/venues/:slug` pages (B4).

**Phase 4 — Process loops**
- Wire `/v1/service/disputes` to act, not just log.
- Add unauthenticated `POST /v1/report` (captcha-gated).
- Add public `/claim/<slug>` flow.
- Tighten `/v1/service/accounts` to scope by linked accounts (H1).

**Phase 5 — Long-tail cleanup**
- Drop or hide free-text `evidence` on verifier reputation graph (D1).
- Allow-list `sameAs` URLs (I1).
- Freeze and plan to drop `groups` table (I2).
- Add OSM/ODbL attribution to terms (E1); plan switch to Google/Mapbox geocoding for the persistent dataset.

---

## Posture note for the README / homepage

Once Phase 1 lands, the project deserves a short stance document — call it `/legal` or fold into the homepage — that says explicitly:

> The Neighborhood Commons stores **facts** about neighborhood events. Original creative expression — photos, prose descriptions, performer bios — is accepted only from accounts that have attested to the contributor terms and that we can identify as the rights-holder. We are a thin neutral data layer; consumer apps decide what to display.

That posture is itself the product differentiator. It's the answer to "why should I publish into this rather than the next event aggregator." The audit recommendations above are how the codebase earns the right to make that claim.
