/**
 * Webhook Delivery Engine — Neighborhood Commons
 *
 * Dispatches webhook notifications when portal events are created/updated/deleted.
 * Fire-and-forget from the main request path (no latency impact).
 *
 * HMAC-SHA256 signing:
 *   signature = HMAC-SHA256(signing_secret, JSON.stringify(payload))
 *   Header: X-NC-Signature: sha256=<hex>
 *
 * Retry: 3 attempts with exponential backoff (1min, 5min, 25min).
 * Auto-disable: subscription disabled after 10 consecutive failures.
 */

import { createHmac } from 'crypto';
import { supabaseAdmin } from './supabase.js';
import { toNeighborhoodEvent, type NeighborhoodEvent, type PortalEventRow } from './event-transform.js';
import { PORTAL_SELECT } from './event-operations.js';
import { validateWebhookUrl } from './url-validation.js';
import { safeFetch } from './safe-fetch.js';
import { decryptSecret, isEncryptionConfigured } from './webhook-crypto.js';

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * Fire-and-forget dispatch: re-fetch an event by ID, transform, dispatch.
 *
 * Replaces the ~17 identical inline IIFEs that used to live in route
 * handlers across contribute/admin/service/portal. Each one rebuilt the
 * same "select the row with business_name join, transform, dispatch"
 * flow. Centralizing means webhook payload bugs have one place to hide.
 *
 * Intentionally void-returning (caller doesn't await): webhook delivery
 * must not gate the main response path. Errors log but don't throw.
 *
 * Pass `onlyPublished: true` to suppress dispatch on events whose row
 * comes back non-published — matches the historical pattern in series
 * loops and content-update handlers that don't want to notify
 * subscribers about pending/draft changes.
 */
export function dispatchEventWebhookById(
  eventType: 'event.created' | 'event.updated' | 'event.deleted' | 'event.series_created',
  eventId: string,
  opts: { onlyPublished?: boolean } = {},
): void {
  void (async () => {
    try {
      const { data: row } = await supabaseAdmin
        .from('events')
        .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name, wheelchair_accessible)`)
        .eq('id', eventId)
        .maybeSingle();
      if (!row) return;
      if (opts.onlyPublished && (row as Record<string, unknown>).status !== 'published') return;
      void dispatchWebhooks(eventType, eventId, toNeighborhoodEvent(row as unknown as PortalEventRow));
    } catch (err) {
      console.error(`[WEBHOOKS] dispatchEventWebhookById(${eventType}, ${eventId}) failed:`, err instanceof Error ? err.message : err);
    }
  })();
}

interface WebhookPayload {
  event_type: string;
  event: NeighborhoodEvent;
  timestamp: string;
  delivery_id: string;
}

export interface SeriesCreatedPayload {
  event_type: 'event.series_created';
  series_id: string;
  recurrence: { rrule: string };
  instance_count: number;
  instances: Array<{ id: string; start: string; series_instance_number: number }>;
  template: NeighborhoodEvent;
  timestamp: string;
  delivery_id: string;
}

export type ImageProcessedErrorCode =
  | 'URL_BLOCKED'
  | 'DOWNLOAD_FAILED'
  | 'INVALID_FORMAT'
  | 'ENCODE_FAILED'
  | 'UPLOAD_FAILED'
  | 'NOT_PERMITTED';

export interface ImageProcessedPayload {
  event_type: 'event.image_processed';
  event_id: string;
  status: 'succeeded' | 'failed';
  image_url: string | null;
  error_code: ImageProcessedErrorCode | null;
  timestamp: string;
  delivery_id: string;
}

interface WebhookSub {
  id: string;
  url: string;
  signing_secret: string;
  signing_secret_encrypted?: Buffer | null;
  event_types: string[];
}

/**
 * Dispatch webhooks for an event change. Fire-and-forget.
 * Finds all active subscriptions matching the event type and delivers.
 */
export async function dispatchWebhooks(
  eventType: string,
  eventId: string,
  eventData: NeighborhoodEvent,
): Promise<void> {
  try {
    const { data: subs } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('id, url, signing_secret, signing_secret_encrypted, event_types')
      .eq('status', 'active')
      .limit(10000);

    if (!subs || subs.length === 0) return;

    const matching = subs.filter((s) =>
      (s.event_types as string[]).includes(eventType)
    );

    for (const sub of matching) {
      const { data: delivery } = await supabaseAdmin
        .from('webhook_deliveries')
        .insert({
          subscription_id: sub.id,
          event_type: eventType,
          event_id: eventId,
          status: 'pending',
        })
        .select('id')
        .single();

      if (!delivery) continue;

      void deliverWebhook(sub as WebhookSub, delivery.id, eventType, eventData)
        .catch(e => console.error('[WEBHOOKS] Delivery error:', e instanceof Error ? e.message : e));
    }
  } catch (err) {
    console.error('[WEBHOOKS] Dispatch error:', err instanceof Error ? err.message : err);
  }
}

/**
 * Dispatch a single event.series_created webhook for a new recurring series.
 * Consumers who subscribe to this event type get one webhook per series instead
 * of N individual event.created webhooks — eliminating the webhook storm.
 */
export async function dispatchSeriesCreatedWebhook(
  seriesId: string,
  template: NeighborhoodEvent,
  instances: Array<{ id: string; start: string; series_instance_number: number }>,
  rrule: string,
): Promise<void> {
  try {
    const { data: subs } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('id, url, signing_secret, signing_secret_encrypted, event_types')
      .eq('status', 'active')
      .limit(10000);

    if (!subs || subs.length === 0) return;

    const matching = subs.filter((s) =>
      (s.event_types as string[]).includes('event.series_created')
    );

    for (const sub of matching) {
      const { data: delivery } = await supabaseAdmin
        .from('webhook_deliveries')
        .insert({
          subscription_id: sub.id,
          event_type: 'event.series_created',
          event_id: instances[0]?.id || seriesId,
          status: 'pending',
        })
        .select('id')
        .single();

      if (!delivery) continue;

      const payload: SeriesCreatedPayload = {
        event_type: 'event.series_created',
        series_id: seriesId,
        recurrence: { rrule },
        instance_count: instances.length,
        instances,
        template,
        timestamp: new Date().toISOString(),
        delivery_id: String(delivery.id),
      };

      void deliverRawWebhook(sub as WebhookSub, delivery.id, payload as unknown as Record<string, unknown>);
    }
  } catch (err) {
    console.error('[WEBHOOKS] Series created dispatch error:', err instanceof Error ? err.message : err);
  }
}

/**
 * Dispatch a single event.image_processed webhook for an async image
 * pipeline outcome. Fires once per event regardless of whether the
 * download/encode/upload succeeded or permanently failed — consumers
 * polling `images[]` need a stop signal in both directions.
 *
 * Uses deliverRawWebhook so the payload shape stays focused (no full
 * event mirror): consumers fetch the event by ID if they need more.
 */
export async function dispatchImageProcessedWebhook(
  eventId: string,
  status: 'succeeded' | 'failed',
  imageUrl: string | null,
  errorCode: ImageProcessedErrorCode | null,
): Promise<void> {
  try {
    const { data: subs } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('id, url, signing_secret, signing_secret_encrypted, event_types')
      .eq('status', 'active')
      .limit(10000);

    if (!subs || subs.length === 0) return;

    const matching = subs.filter((s) =>
      (s.event_types as string[]).includes('event.image_processed')
    );

    for (const sub of matching) {
      const { data: delivery } = await supabaseAdmin
        .from('webhook_deliveries')
        .insert({
          subscription_id: sub.id,
          event_type: 'event.image_processed',
          event_id: eventId,
          status: 'pending',
        })
        .select('id')
        .single();

      if (!delivery) continue;

      const payload: ImageProcessedPayload = {
        event_type: 'event.image_processed',
        event_id: eventId,
        status,
        image_url: imageUrl,
        error_code: errorCode,
        timestamp: new Date().toISOString(),
        delivery_id: String(delivery.id),
      };

      void deliverRawWebhook(sub as WebhookSub, delivery.id, payload as unknown as Record<string, unknown>);
    }
  } catch (err) {
    console.error('[WEBHOOKS] Image processed dispatch error:', err instanceof Error ? err.message : err);
  }
}

/**
 * Resolve the HMAC signing secret for a subscription. Centralizes:
 *   - the encrypted vs. plaintext branch
 *   - the decrypt try/catch (previously missing — a throw stranded the
 *     delivery row in `pending` state indefinitely)
 *   - marking the delivery row failed with a human-readable error BEFORE
 *     rethrowing, so the caller just bails out
 *
 * Throws after updating the row. Caller should log and return.
 *
 * Exported with a `_` prefix for unit tests only; callers should go through
 * deliverWebhook / deliverRawWebhook.
 */
export async function _resolveSigningSecretForTests(sub: WebhookSub, deliveryId: number): Promise<string> {
  return resolveSigningSecret(sub, deliveryId);
}

async function resolveSigningSecret(sub: WebhookSub, deliveryId: number): Promise<string> {
  async function markFailed(reason: string): Promise<void> {
    await supabaseAdmin
      .from('webhook_deliveries')
      .update({ status: 'failed', error_message: reason })
      .eq('id', deliveryId);
  }

  if (!isEncryptionConfigured()) {
    // Dev/test: encryption not configured, use plaintext column
    return sub.signing_secret;
  }

  if (!sub.signing_secret_encrypted) {
    await markFailed('Missing encrypted signing secret');
    throw new Error(`subscription ${sub.id} missing encrypted secret`);
  }

  try {
    return decryptSecret(sub.signing_secret_encrypted as unknown as Buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'decryption failed';
    await markFailed(`Signing secret decryption failed: ${msg}`);
    throw err;
  }
}

async function deliverWebhook(
  sub: WebhookSub,
  deliveryId: number,
  eventType: string,
  eventData: NeighborhoodEvent,
  attemptNumber = 1,
): Promise<void> {
  const payload: WebhookPayload = {
    event_type: eventType,
    event: eventData,
    timestamp: new Date().toISOString(),
    delivery_id: String(deliveryId),
  };

  const body = JSON.stringify(payload);

  // Resolve signing secret. A decryption failure MUST mark the delivery row
  // as failed — previously decryptSecret threw outside any try/catch, leaving
  // delivery rows stuck in `pending` forever (observed in prod after the
  // `\x<hex>` bytea encoding fix in this same PR). Failures log the cause so
  // an operator can tell key-mismatch from format-mismatch from corrupt-data.
  let secret: string;
  try {
    secret = await resolveSigningSecret(sub, deliveryId);
  } catch (err) {
    // The resolver has already updated the delivery row to failed before
    // throwing. Just log and bail.
    console.error(`[WEBHOOKS] Subscription ${sub.id} secret resolution failed:`, err instanceof Error ? err.message : err);
    return;
  }

  const signature = createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  try {
    // SSRF protection: validate URL resolves to a public IP
    await validateWebhookUrl(sub.url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    // redirect: 'error' — webhooks must not redirect (signature verification would fail).
    // safeFetch additionally routes through the SSRF-strict dispatcher when enabled.
    const response = await safeFetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NC-Signature': `sha256=${signature}`,
        'X-NC-Event': eventType,
        'User-Agent': 'Neighborhood-Commons/1.0',
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const responseBody = await response.text().catch(() => '');

    if (response.ok) {
      await supabaseAdmin
        .from('webhook_deliveries')
        .update({
          status: 'delivered',
          status_code: response.status,
        })
        .eq('id', deliveryId);

      await supabaseAdmin
        .from('webhook_subscriptions')
        .update({
          consecutive_failures: 0,
          last_success_at: new Date().toISOString(),
        })
        .eq('id', sub.id);
    } else {
      await handleDeliveryFailure(sub.id, deliveryId, attemptNumber, `HTTP ${response.status}: ${responseBody.substring(0, 200)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await handleDeliveryFailure(sub.id, deliveryId, attemptNumber, message);
  }
}

/** Deliver an arbitrary JSON payload to a webhook subscriber (used for series_created) */
async function deliverRawWebhook(
  sub: WebhookSub,
  deliveryId: number,
  payload: Record<string, unknown>,
  attemptNumber = 1,
): Promise<void> {
  const body = JSON.stringify(payload);
  const eventType = (payload.event_type as string) || 'unknown';

  let secret: string;
  try {
    secret = await resolveSigningSecret(sub, deliveryId);
  } catch (err) {
    console.error(`[WEBHOOKS] Subscription ${sub.id} secret resolution failed:`, err instanceof Error ? err.message : err);
    return;
  }

  const signature = createHmac('sha256', secret).update(body).digest('hex');

  try {
    await validateWebhookUrl(sub.url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    const response = await safeFetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NC-Signature': `sha256=${signature}`,
        'X-NC-Event': eventType,
        'User-Agent': 'Neighborhood-Commons/1.0',
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseBody = await response.text().catch(() => '');

    if (response.ok) {
      await supabaseAdmin
        .from('webhook_deliveries')
        .update({ status: 'delivered', status_code: response.status })
        .eq('id', deliveryId);

      await supabaseAdmin
        .from('webhook_subscriptions')
        .update({ consecutive_failures: 0, last_success_at: new Date().toISOString() })
        .eq('id', sub.id);
    } else {
      await handleDeliveryFailure(sub.id, deliveryId, attemptNumber, `HTTP ${response.status}: ${responseBody.substring(0, 200)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await handleDeliveryFailure(sub.id, deliveryId, attemptNumber, message);
  }
}

async function handleDeliveryFailure(
  subscriptionId: string,
  deliveryId: number,
  attemptNumber: number,
  errorMessage: string,
): Promise<void> {
  const canRetry = attemptNumber < MAX_RETRIES;
  // Exponential backoff: attempt 1 → 1min, attempt 2 → 5min, attempt 3 → 25min
  const retryDelayMs = canRetry ? Math.pow(5, attemptNumber - 1) * 60_000 : 0;

  await supabaseAdmin
    .from('webhook_deliveries')
    .update({
      status: canRetry ? 'retrying' : 'failed',
      error_message: errorMessage.substring(0, 500),
      attempt: attemptNumber,
      next_retry_at: canRetry
        ? new Date(Date.now() + retryDelayMs).toISOString()
        : null,
    })
    .eq('id', deliveryId);

  // Atomic increment of consecutive failures (prevents race condition)
  const { data: result } = await supabaseAdmin.rpc('increment_webhook_failures', {
    p_subscription_id: subscriptionId,
    p_error_message: errorMessage.substring(0, 500),
    p_max_failures: MAX_CONSECUTIVE_FAILURES,
  });

  if (result?.[0]?.was_disabled) {
    console.log(`[WEBHOOKS] Auto-disabled subscription ${subscriptionId} after ${result[0].new_count} failures`);
  }
}

/**
 * Deliver a test webhook to a single subscription.
 * Used by the /webhooks/:id/test endpoint -- only targets the subscription being tested.
 */
export async function deliverTestWebhook(
  sub: WebhookSub,
  eventType: string,
  eventData: NeighborhoodEvent,
): Promise<void> {
  try {
    const { data: delivery } = await supabaseAdmin
      .from('webhook_deliveries')
      .insert({
        subscription_id: sub.id,
        event_type: eventType,
        event_id: '00000000-0000-0000-0000-000000000000',
        status: 'pending',
      })
      .select('id')
      .single();

    if (!delivery) return;
    void deliverWebhook(sub, delivery.id, eventType, eventData)
      .catch(e => console.error('[WEBHOOKS] Delivery error:', e instanceof Error ? e.message : e));
  } catch (err) {
    console.error('[WEBHOOKS] Test delivery error:', err instanceof Error ? err.message : err);
  }
}

/**
 * Retry failed webhook deliveries. Called by cron.
 * Finds deliveries with status='retrying' and next_retry_at <= now.
 */
export async function retryFailedWebhooks(): Promise<number> {
  const { data: deliveries } = await supabaseAdmin
    .from('webhook_deliveries')
    .select('id, subscription_id, event_type, event_id, attempt')
    .eq('status', 'retrying')
    .lte('next_retry_at', new Date().toISOString())
    .limit(50);

  if (!deliveries || deliveries.length === 0) return 0;

  // Batch-fetch subscriptions and events to avoid N+1 queries.
  // Without this: 50 deliveries × 2 lookups each = 101 queries.
  // With this: 3 queries total regardless of batch size.
  const subIds = [...new Set(deliveries.map(d => d.subscription_id))];
  const eventIds = [...new Set(deliveries.map(d => d.event_id))];

  const [{ data: subs }, { data: events }] = await Promise.all([
    supabaseAdmin
      .from('webhook_subscriptions')
      .select('id, url, signing_secret, signing_secret_encrypted')
      .in('id', subIds)
      .eq('status', 'active'),
    supabaseAdmin
      .from('events')
      .select('id, content, description, place_name, venue_address, place_id, latitude, longitude, event_at, end_time, event_timezone, category, custom_category, recurrence, series_id, series_instance_number, open_window, capacity, rsvp, tags, wheelchair_accessible, price, link_url, event_image_url, created_at, source_method, source_publisher, source_contributor_url, source_contributor_name, portal_accounts!events_creator_account_id_fkey(business_name, wheelchair_accessible)')
      .in('id', eventIds),
  ]);

  const subMap = new Map((subs || []).map(s => [s.id, s]));
  const eventMap = new Map((events || []).map(e => [e.id, e]));

  let retried = 0;
  for (const d of deliveries) {
    const sub = subMap.get(d.subscription_id);
    if (!sub) {
      await supabaseAdmin
        .from('webhook_deliveries')
        .update({ status: 'failed', error_message: 'Subscription no longer active' })
        .eq('id', d.id);
      continue;
    }

    const event = eventMap.get(d.event_id);
    if (!event) {
      await supabaseAdmin
        .from('webhook_deliveries')
        .update({ status: 'failed', error_message: 'Event no longer exists' })
        .eq('id', d.id);
      continue;
    }

    // Re-transform and deliver with incremented attempt number
    const eventData = toNeighborhoodEvent(event as unknown as PortalEventRow);
    void deliverWebhook(sub as WebhookSub, d.id, d.event_type, eventData, d.attempt + 1)
      .catch(e => console.error('[WEBHOOKS] Retry delivery error:', e instanceof Error ? e.message : e));
    retried++;
  }

  return retried;
}
