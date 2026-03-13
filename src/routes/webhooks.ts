/**
 * Webhook Subscription Management — Neighborhood API v0.2
 *
 * Consumers subscribe to event changes (create/update/delete) and receive
 * HMAC-signed POST requests to their HTTPS endpoints.
 *
 * All routes require a valid API key (X-API-Key header).
 */

import { Router } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { requireApiKey } from '../middleware/api-key.js';
import { validateRequest, validateUuidParam } from '../lib/helpers.js';
import { writeLimiter, enumerationLimiter } from '../middleware/rate-limit.js';
import { validateWebhookUrl } from '../lib/url-validation.js';
import { encryptSecret, isEncryptionConfigured } from '../lib/webhook-crypto.js';

const router: ReturnType<typeof Router> = Router();

// All webhook routes require an API key
router.use(requireApiKey);

const MAX_SUBSCRIPTIONS_PER_KEY = 5;

const EVENT_TYPES = ['event.created', 'event.updated', 'event.deleted'] as const;

// =============================================================================
// SCHEMAS
// =============================================================================

const createWebhookSchema = z.object({
  url: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'URL must use HTTPS'),
  event_types: z.array(z.enum(EVENT_TYPES)).min(1).max(3).default([...EVENT_TYPES]),
});

const updateWebhookSchema = z.object({
  url: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'URL must use HTTPS').optional(),
  event_types: z.array(z.enum(EVENT_TYPES)).min(1).max(3).optional(),
  status: z.enum(['active', 'paused']).optional(),
});

// =============================================================================
// ROUTES
// =============================================================================

/**
 * POST /api/v1/webhooks
 * Create a webhook subscription. Returns the signing secret once.
 */
router.post('/', writeLimiter, async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo!.id;
    const { url, event_types } = validateRequest(createWebhookSchema, req.body);

    // SSRF protection: validate URL resolves to a public IP
    try {
      await validateWebhookUrl(url);
    } catch (err) {
      throw createError(
        `Invalid webhook URL: ${err instanceof Error ? err.message : 'URL validation failed'}`,
        400,
        'INVALID_WEBHOOK_URL',
      );
    }

    // Generate signing secret
    const signingSecret = randomBytes(32).toString('hex');

    // Atomic count + insert via RPC — prevents concurrent requests exceeding the limit
    const rpcParams: Record<string, unknown> = {
      p_api_key_id: apiKeyId,
      p_url: url,
      p_event_types: event_types,
      p_signing_secret: signingSecret,
      p_max_subscriptions: MAX_SUBSCRIPTIONS_PER_KEY,
    };
    if (isEncryptionConfigured()) {
      rpcParams.p_signing_secret_encrypted = encryptSecret(signingSecret);
    }

    const { data: subscription, error } = await supabaseAdmin
      .rpc('create_webhook_subscription', rpcParams)
      .single();

    if (error) {
      // RPC raises P0001 for limit exceeded
      if (error.message?.includes('Subscription limit reached')) {
        throw createError(`Subscription limit reached (${MAX_SUBSCRIPTIONS_PER_KEY} per key)`, 429, 'SUBSCRIPTION_LIMIT');
      }
      console.error('[WEBHOOKS] Create error:', error.message);
      throw createError('Failed to create webhook', 500, 'SERVER_ERROR');
    }

    // Return signing secret ONCE — consumer must save it
    // RPC returns full row; pick only public fields
    const sub = subscription as Record<string, unknown>;
    res.status(201).json({
      subscription: {
        id: sub.id,
        url: sub.url,
        event_types: sub.event_types,
        status: sub.status,
        created_at: sub.created_at,
        signing_secret: signingSecret,
      },
      note: 'Save the signing_secret — it will not be shown again.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/webhooks
 * List subscriptions for the current API key.
 */
router.get('/', enumerationLimiter, async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo!.id;

    const { data: subscriptions, error } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('id, url, event_types, status, consecutive_failures, last_success_at, last_failure_at, last_failure_reason, created_at, updated_at')
      .eq('api_key_id', apiKeyId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[WEBHOOKS] List error:', error.message);
      throw createError('Failed to list webhooks', 500, 'SERVER_ERROR');
    }

    res.json({ subscriptions: subscriptions || [] });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/v1/webhooks/:id
 * Update a webhook subscription (URL, event types, status).
 */
router.patch('/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const id = req.params.id;
    const apiKeyId = req.apiKeyInfo!.id;
    const updates = validateRequest(updateWebhookSchema, req.body);

    if (Object.keys(updates).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    // Verify ownership
    const { data: existing } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('id')
      .eq('id', id)
      .eq('api_key_id', apiKeyId)
      .maybeSingle();

    if (!existing) {
      throw createError('Webhook not found', 404, 'NOT_FOUND');
    }

    // SSRF protection: validate new URL if provided
    if (updates.url) {
      try {
        await validateWebhookUrl(updates.url);
      } catch (err) {
        throw createError(
          `Invalid webhook URL: ${err instanceof Error ? err.message : 'URL validation failed'}`,
          400,
          'INVALID_WEBHOOK_URL',
        );
      }
    }

    // If reactivating, reset failure counter
    const updatePayload: Record<string, unknown> = { ...updates };
    if (updates.status === 'active') {
      updatePayload.consecutive_failures = 0;
      updatePayload.disabled_at = null;
    }

    const { data: subscription, error } = await supabaseAdmin
      .from('webhook_subscriptions')
      .update(updatePayload)
      .eq('id', id)
      .select('id, url, event_types, status, consecutive_failures, last_success_at, created_at, updated_at')
      .single();

    if (error) {
      console.error('[WEBHOOKS] Update error:', error.message);
      throw createError('Failed to update webhook', 500, 'SERVER_ERROR');
    }

    res.json({ subscription });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/webhooks/:id
 * Delete a webhook subscription.
 */
router.delete('/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const id = req.params.id;
    const apiKeyId = req.apiKeyInfo!.id;

    const { error } = await supabaseAdmin
      .from('webhook_subscriptions')
      .delete()
      .eq('id', id)
      .eq('api_key_id', apiKeyId);

    if (error) {
      console.error('[WEBHOOKS] Delete error:', error.message);
      throw createError('Failed to delete webhook', 500, 'SERVER_ERROR');
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/webhooks/:id/test
 * Send a test webhook delivery with a sample event.
 */
router.post('/:id/test', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const id = req.params.id;
    const apiKeyId = req.apiKeyInfo!.id;

    const { data: sub } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('id, url, signing_secret, signing_secret_encrypted, event_types')
      .eq('id', id)
      .eq('api_key_id', apiKeyId)
      .maybeSingle();

    if (!sub) {
      throw createError('Webhook not found', 404, 'NOT_FOUND');
    }

    // Deliver a test event to this specific subscription only
    const { deliverTestWebhook } = await import('../lib/webhook-delivery.js');

    const testEvent = {
      id: '00000000-0000-0000-0000-000000000000',
      name: 'Test Event',
      start: new Date().toISOString(),
      end: null,
      description: 'This is a test webhook delivery from Neighborhood Commons.',
      category: ['test'],
      place_id: null,
      location: { name: 'Test Venue', address: null, lat: null, lng: null },
      url: null,
      images: [],
      organizer: { name: 'Neighborhood Commons', phone: null as null },
      cost: null,
      series_id: null,
      series_instance_number: null,
      start_time_required: true,
      recurrence: null,
      source: {
        publisher: 'neighborhood-commons' as const,
        collected_at: new Date().toISOString(),
        method: 'portal' as const,
        license: 'CC BY 4.0' as const,
      },
    };

    void deliverTestWebhook(sub, 'event.created', testEvent);

    res.json({ success: true, message: 'Test webhook dispatched. Check your endpoint.' });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// DELIVERY HISTORY
// =============================================================================

const deliveryQuerySchema = z.object({
  status: z.enum(['pending', 'delivered', 'failed', 'retrying']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/v1/webhooks/:id/deliveries
 * List delivery history for a webhook subscription.
 */
router.get('/:id/deliveries', enumerationLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const id = req.params.id;
    const apiKeyId = req.apiKeyInfo!.id;
    const { status, limit, offset } = validateRequest(deliveryQuerySchema, req.query);

    // Verify subscription ownership
    const { data: sub } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('id')
      .eq('id', id)
      .eq('api_key_id', apiKeyId)
      .maybeSingle();

    if (!sub) {
      throw createError('Webhook not found', 404, 'NOT_FOUND');
    }

    // Query deliveries
    let query = supabaseAdmin
      .from('webhook_deliveries')
      .select('id, event_type, event_id, status, status_code, error_message, attempt, next_retry_at, created_at', { count: 'exact' })
      .eq('subscription_id', id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data: deliveries, count, error } = await query;

    if (error) {
      console.error('[WEBHOOKS] Deliveries list error:', error.message);
      throw createError('Failed to list deliveries', 500, 'SERVER_ERROR');
    }

    res.json({
      deliveries: deliveries || [],
      meta: { total: count || 0, limit, offset },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
