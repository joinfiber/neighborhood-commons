# Neighborhood Commons 0.8.0 — Consumer App Update

**Paste this into a fresh Claude Code session in your consumer repo (Fiber / Merrie / Holler / Studio).**

---

## What shipped

The Neighborhood Commons API moved to **spec 0.8.0** today (2026-04-23). Two additive, non-breaking capabilities:

### 1. Per-event delivery confirmation
`GET /api/v1/webhooks/{id}/deliveries` now accepts an `event_id` query parameter.

```
GET /api/v1/webhooks/{your-subscription-id}/deliveries
    ?event_id={the-uuid-you-care-about}
    &status=delivered
```

Returns the delivery record for that specific event on that specific subscription. Combine `event_id` + `status=delivered` to answer "did this event reach me?" in one HTTP call instead of paginating the full delivery history or running a periodic full-collection reconcile.

Same auth as the existing endpoint (`X-API-Key` + ownership-scoped to the calling key). Same rate limit (5/min).

### 2. New webhook event_type: `event.image_processed`
Fires once per event when the Commons' async image download + R2 re-encode pipeline reaches a terminal state — success **or** permanent failure. Closes the silent-failure window the spec used to acknowledge ("POST/PATCH returns before the image is fetched. If download fails, the event is created without an image; no notification is sent.").

**Payload** (intentionally focused — does NOT mirror `event.updated`):
```json
{
  "event_type": "event.image_processed",
  "event_id": "uuid",
  "status": "succeeded" | "failed",
  "image_url": "https://..." | null,
  "error_code": "URL_BLOCKED" | "DOWNLOAD_FAILED" | "INVALID_FORMAT" | "ENCODE_FAILED" | "UPLOAD_FAILED" | null,
  "timestamp": "ISO8601",
  "delivery_id": "..."
}
```

**Opt-in only.** This event_type is NOT included in the default `event_types` for new webhook subscriptions because the payload shape differs from the standard `{ event_type, event, ... }`. Existing subscriptions are unaffected. To receive it, explicitly include `"event.image_processed"` in your subscription's `event_types` array (PATCH the subscription or recreate it).

If you only need the success URL: read `image_url`. If you also want to stop polling on permanent failure: check `status === "failed"` and `error_code`.

---

## Update path

### Step 1 — Bump the SDK
```bash
npm update neighborhood-commons   # picks up @0.0.4
# or pin: npm install neighborhood-commons@0.0.4
```

The TypeScript types regenerate from the spec automatically. Anywhere you have an `event_types` array typed against the SDK, `"event.image_processed"` is now a valid enum member. The `listWebhookDeliveries` operation has the new `event_id` query parameter typed.

### Step 2 — Decide what you can retire

If your repo currently does any of the following, the new endpoints likely let you delete or simplify it:

- **Periodic full-collection reconcile** (`GET /events?sort=newest` walked across all pages) used to catch missed webhook deliveries → replace with per-event delivery-status polling using the new `event_id` filter, only for events you suspect were missed.
- **Image-landing polling** on `GET /events/{id}` after a write → subscribe to `event.image_processed` instead. The webhook fires exactly once per terminal state.
- **30-minute reconcile crons** to bridge the webhook visibility gap → if you only care about confirming specific writes landed (e.g. you publish via Studio and want to know Fiber received them), the `event_id` delivery query is point-and-shoot.

### Step 3 — Subscribe to `event.image_processed` (only if you care about images)

```bash
# Patch an existing subscription to add the new event_type:
curl -X PATCH "https://api.neighborhood-commons.org/api/v1/webhooks/{subscription_id}" \
  -H "X-API-Key: nc_yourkey..." \
  -H "Content-Type: application/json" \
  -d '{
    "event_types": ["event.created", "event.updated", "event.deleted", "event.series_created", "event.image_processed"]
  }'
```

Your webhook handler will need to recognize the new event_type and branch on payload shape. Don't try to parse it as `event.updated` — the keys are different.

---

## Reference

- **Spec:** [openapi.json](https://api.neighborhood-commons.org/openapi.json) — version `0.8.0`. The `/webhooks/{id}/deliveries` parameters and response schema are now an exact match for what the server returns (a pre-existing drift was corrected in the same release).
- **Guide:** [llms.txt](https://api.neighborhood-commons.org/llms.txt) Part 4 — the new event_type and payload shape are documented under "Event Types".
- **Log:** [CHANGELOG.md](https://github.com/joinfiber/neighborhood-commons/blob/master/CHANGELOG.md) — full entry under 2026-04-23.
- **SDK:** [neighborhood-commons@0.0.4](https://www.npmjs.com/package/neighborhood-commons) — published with SLSA v1 provenance via OIDC Trusted Publishing. No long-lived secret was used to publish.

---

## Suggested first task for the consuming repo

> Audit this codebase for places that currently work around the absence of either capability:
> 1. Any reconcile cron, polling loop, or "did this webhook fire?" workaround that could be replaced by a per-event delivery query (`event_id` filter on `/api/v1/webhooks/{id}/deliveries`).
> 2. Any image-landing polling on `GET /events/{id}` that could be replaced by subscribing to `event.image_processed`.
>
> For each finding: report the file + line, what the current workaround does, and a proposed replacement using the new spec capabilities. Don't refactor yet — just produce the audit. We'll decide what to land based on the report.
