# Task brief: Verification layer for the Neighborhood Commons

> **Origin:** Spec design conversation between Merrie and Commons, 2026-04-29.
>
> **Status:** Architecture decided, spec design pending.
>
> **Owner when picked up:** Whichever Claude session continues Commons work next.

## What this is

Add a **verification layer** to the Commons as a first-class primitive — alongside events, accounts, venues, and groups. Verification is the canonical answer to *"is this account who they say they are?"* The Commons holds the flag; consumer apps read it; tier-appropriate apps submit evidence.

This is **not** a per-product feature. Holler doesn't own verification; neither does Merrie. The Commons owns it. Both products (and any future consumer app) are equal participants.

## Why this is the right shape

The full architectural reasoning, in priority order:

1. **Verification is identity infrastructure.** *"Is this account who they say they are?"* is a fact, not an editorial choice. The Commons doctrine — *thin, durable, authoritative* — applies. Different from curation, recommendations, or social features (which the Guide explicitly says belong in apps).

2. **The user-facing promise is portability.** *"Verify once, access flows."* A bar verifies through whatever path is convenient — Merrie's IG-handle proof, Holler's in-person ritual, another consumer app's email-domain match — and the verification flag is then visible to every app reading from the Commons. The user never thinks about which product holds the verification because no product does. This is the Commons promise applied to identity.

3. **The third-party angle is the strategic prize.** A neighborhood food app shows verified badges. A booking platform restricts to verified-only. A local press org submits evidence based on existing relationships. A future trust/reviews app builds entirely on top of the layer. Without Commons-owned verification, each of those has to build verification separately or partner bespoke with a vendor. With it, they read for free; they submit evidence if they have something to contribute. Same posture as event data today.

4. **Eliminates bidirectional sync.** The prior model had verification "symmetric Merrie↔Holler" — meaning a sync mechanism, drift risk, race conditions. With Commons-owned verification, both products just read; no sync.

5. **Holler's value narrative gets sharper.** Holler shifts from *"verification owner"* to *"first verification vendor — specializing in in-person trust + peer-recommendation networks."* Same daily work, stronger positioning. The moat is the network of trust, not the database.

## Proposed API surface

### Read (existing endpoints, additive fields)

The existing `GET /v1/accounts/:idOrSlug` and account list endpoints add three fields:

- `verification_status`: `"unverified"` | `"pending"` | `"verified"`
- `verified_at`: ISO 8601 timestamp, nullable
- `verification_method`: `"email_domain_match"` | `"ig_ownership_proof"` | `"peer_recommendation"` | `"in_person"` | `"domain_email_loop"` | null

Read access matches existing read tier — no new auth gate. Anyone reading from the Commons can show verification badges.

### Submit evidence (new)

`POST /v1/contribute/verify` — submit evidence for an account.

Request body:

```jsonc
{
  "account_id": "uuid",
  "method": "email_domain_match" | "ig_ownership_proof" | "peer_recommendation" | "in_person" | "domain_email_loop",
  "evidence": {
    // method-specific shape; e.g. for email_domain_match:
    "email": "manager@blue-collar-bar.com",
    "matched_domain": "blue-collar-bar.com"
    // for ig_ownership_proof:
    // "instagram_handle": "@blue_collar_bar",
    // "code": "...one-time code we issued...",
    // "verified_via": "dm" | "story"
    // for peer_recommendation:
    // "recommender_account_id": "uuid"
    // for in_person:
    // "reviewer_account_id": "uuid",
    // "notes": "..."
  }
}
```

Tier behavior:

- **Service-tier**: submitted evidence is processed immediately by the policy engine. Auto-verify if sufficient; reject if not.
- **Contribute-tier**: submitted evidence enters a review queue. Returns `{ status: "queued", review_id }`.
- **Pending-tier**: returns `403 INSUFFICIENT_TIER`.

Response on auto-verify: `{ status: "verified", verified_at, verification_method }` and the account record updates.

Response on rejection: `{ status: "rejected", reason: "..." }`.

### Service-only: review queue

`GET /v1/service/verifications/pending` — list pending evidence reviews
`POST /v1/service/verifications/:id/approve` — approve, sets the flag
`POST /v1/service/verifications/:id/reject` — reject

These are admin/Holler tools.

## The policy engine

The Commons applies a policy to incoming evidence. Roughly:

| Method | Auto-verify if... | Otherwise |
|---|---|---|
| `email_domain_match` | Submitted email's domain matches a domain published by the venue (website, Google Business profile, or a manually-curated allowlist) | Reject — the submitter can try again with a matching domain |
| `ig_ownership_proof` | Submitted code matches one issued by the Commons; verified via DM to a Commons IG account or stories post | Reject |
| `peer_recommendation` | Recommending account is `verified`; recommending account has zero other pending recommendations open | Queue for admin review (cap-violation cases) |
| `in_person` | Reviewer account has the `trusted_reviewer` flag (e.g., Holler service-tier) | Queue |
| `domain_email_loop` | Code emailed to an address on the venue's published domain, returned via a verification link | Reject |

The Commons is authoritative on *what is sufficient*. Apps just submit what they gathered.

## Migration path

1. **Schema** — new migration adds `verification_status`, `verified_at`, `verification_method`, optional `verification_evidence` (JSONB) on `accounts`. Default `unverified` for existing rows.
2. **Read surface** — additive change to `GET /v1/accounts/*` endpoints. Existing consumers ignore the new fields. Bumps OpenAPI minor version.
3. **Submit endpoints** — new endpoints, no breaking changes.
4. **Policy engine** — internal module; lives in `src/lib/verification.ts` or similar. Each method has its own validator function.
5. **Service review queue** — new service-tier endpoints. UI tooling can come from Holler / Commons admin separately.

## What's NOT in scope

- **Specific verification UX** — apps own that. Holler designs the in-person flow; Merrie designs the IG-DM flow. The Commons receives evidence, doesn't dictate the user-facing experience.
- **Editorial / curation / recommendations** — apps. Commons stores facts.
- **End-user identity** (subscribers, RSVP-ers, individual consumers) — verification is for accounts representing organizations, venues, or verified persons. Not for every Commons reader.
- **Per-event verification** — verification is on the account, not the event. An event at a verified venue inherits the venue's verification status; events from an unverified account are unverified regardless of the venue.

## Open questions for the spec session

1. **Should `verification_method` carry weighting?** E.g., `peer_recommendation` is "weaker" than `in_person`. Do consumers expose a quality tier, or is verified just verified? *Default: just verified — quality is on the policy engine, not the consumer surface.*

2. **What about de-verification?** If a verified account turns out to be fraudulent, is there a `revoke` flow? *Default: yes, service-tier endpoint to revoke. Sets status back to `unverified` with a reason.*

3. **What about expiration?** Should verifications expire and require re-attestation? *Default: no expiration in v1. Revisit if abuse patterns emerge.*

4. **Should evidence be retained?** Retain the JSON evidence blob for audit, or hash-and-discard for privacy? *Default: retain for service-tier visibility, encrypted at rest if it contains PII (emails, IG handles).*

5. **What's the relationship to existing `creator_account_id` ownership semantics?** Per the 2026-04-14 changelog entry on Contribute API ownership, accounts are the unit of trust for events. Verification is on the same account. No conflict, but the relationship should be explicit in the spec.

## How to pick this up

Start a Commons-context session and read this brief plus:

- `CLAUDE.md` (Commons project doctrine)
- `public/openapi.json` (current spec — where the new fields and endpoints will land)
- `public/llms.txt` (the Guide — for the *"thin, durable, authoritative"* framing)
- The existing `accounts` table schema in `migrations/`
- Any prior memory on verification (none expected — this is the design conversation that proposes the feature)

First moves:
1. Sketch the migration (schema)
2. Sketch the OpenAPI delta (read fields + submit endpoints)
3. Sketch the policy engine module shape
4. Bring back to Merrie / Holler consumers for review before implementation

This is real spec work. Not a one-session implementation. Plan accordingly.

## Cross-references

In Merrie's memory:
- `project_merrie_holler_bridge.md` — the bridge model, updated to reflect Commons-owned verification
- `project_commons_verification_layer.md` — the architecture from Merrie's side, full third-party-promise framing
