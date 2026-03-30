/**
 * Admin API Key Routes
 *
 * API key creation, listing, update, and revocation.
 */

import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase.js";
import { createError } from "../../middleware/error-handler.js";
import { validateRequest, validateUuidParam } from "../../lib/helpers.js";
import { generateAndStoreKey } from "../../lib/api-keys.js";
import { writeLimiter, portalLimiter } from "../../middleware/rate-limit.js";

const router: ReturnType<typeof Router> = Router();

const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  contact_email: z.string().email().max(200),
});

const updateApiKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(['active', 'revoked']).optional(),
  contributor_tier: z.enum(['pending', 'verified', 'trusted']).optional(),
  contact_email: z.string().email().max(200).optional(),
});

// =============================================================================
// API KEY MANAGEMENT
// =============================================================================

/**
 * POST /admin/api-keys
 * Create a new API key.
 */
router.post('/api-keys', writeLimiter, async (req, res, next) => {
  try {
    const { name, contact_email } = validateRequest(createApiKeySchema, req.body);

    const key = await generateAndStoreKey(name, contact_email);

    res.status(201).json({
      api_key: {
        id: key.id,
        raw_key: key.raw_key,
        name: key.name,
        contact_email,
        rate_limit_per_hour: 1000,
        status: 'active',
        created_at: key.created_at,
      },
      note: 'Save the raw_key — it will not be shown again.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/api-keys
 * List all API keys.
 */
router.get('/api-keys', portalLimiter, async (_req, res, next) => {
  try {
    const { data: keys, error } = await supabaseAdmin
      .from('api_keys')
      .select('id, key_prefix, name, contact_email, rate_limit_per_hour, status, contributor_tier, last_used_at, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[COMMONS-ADMIN] API keys list error:', error.message);
      throw createError('Failed to list API keys', 500, 'SERVER_ERROR');
    }

    // Fetch event counts and last submission per API key
    const keyIds = (keys || []).map((k) => k.id);
    let eventStats: Record<string, { event_count: number; last_submitted_at: string | null }> = {};

    if (keyIds.length > 0) {
      const sourceFeedUrls = keyIds.map((id) => `api-key:${id}`);
      const { data: stats } = await supabaseAdmin
        .from('events')
        .select('source_feed_url, created_at')
        .in('source_feed_url', sourceFeedUrls)
        .eq('source_method', 'api');

      if (stats) {
        for (const row of stats) {
          const keyId = row.source_feed_url?.replace('api-key:', '');
          if (!keyId) continue;
          if (!eventStats[keyId]) eventStats[keyId] = { event_count: 0, last_submitted_at: null };
          eventStats[keyId].event_count++;
          if (!eventStats[keyId].last_submitted_at || row.created_at > eventStats[keyId].last_submitted_at!) {
            eventStats[keyId].last_submitted_at = row.created_at;
          }
        }
      }
    }

    const enrichedKeys = (keys || []).map((k) => ({
      ...k,
      event_count: eventStats[k.id]?.event_count ?? 0,
      last_submitted_at: eventStats[k.id]?.last_submitted_at ?? null,
    }));

    res.json({ api_keys: enrichedKeys });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /admin/api-keys/:id
 * Update API key name or status.
 */
router.patch('/api-keys/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const id = req.params.id;
    const updates = validateRequest(updateApiKeySchema, req.body);

    if (Object.keys(updates).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const { data: apiKey, error } = await supabaseAdmin
      .from('api_keys')
      .update(updates)
      .eq('id', id)
      .select('id, key_prefix, name, contact_email, rate_limit_per_hour, status, contributor_tier, last_used_at, created_at')
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] API key update error:', error.message);
      throw createError('Failed to update API key', 500, 'SERVER_ERROR');
    }

    console.log(`[COMMONS-ADMIN] API key ${id} updated:`, Object.keys(updates).join(', '));
    res.json({ api_key: apiKey });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /admin/api-keys/:id
 * Revoke an API key (soft delete — sets status='revoked').
 */
router.delete('/api-keys/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const id = req.params.id;

    const { error } = await supabaseAdmin
      .from('api_keys')
      .update({ status: 'revoked' })
      .eq('id', id);

    if (error) {
      console.error('[COMMONS-ADMIN] API key revoke error:', error.message);
      throw createError('Failed to revoke API key', 500, 'SERVER_ERROR');
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});


export default router;
