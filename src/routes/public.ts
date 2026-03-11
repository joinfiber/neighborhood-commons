/**
 * Public Event Aliases — Neighborhood Commons
 *
 * /api/events redirects to /api/v1/events (the canonical public API).
 * /api/events/changes is the only unique endpoint here — a lightweight
 * sync feed for consumers without a service key.
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, resolveEventImageUrl } from '../lib/helpers.js';
import { config } from '../config.js';

const router: ReturnType<typeof Router> = Router();

// Stricter rate limiter for the changes endpoint (public sync alternative)
const changesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests. Use /api/internal/events/sync with a service key for higher limits.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const changesSchema = z.object({
  since: z.string().datetime({ message: 'since must be a valid ISO 8601 timestamp' }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// =============================================================================
// CHANGES ENDPOINT (unique to this route file)
// =============================================================================

/**
 * GET /api/events/changes — Public changes endpoint
 * Lightweight alternative to /api/internal/events/sync for consumers
 * that don't have a service key. Lower rate limit, fewer fields.
 *
 * NOTE: Must be defined BEFORE the redirect to avoid Express matching "changes" as a param.
 */
router.get('/changes', changesLimiter, async (req, res, next) => {
  try {
    const { since, limit } = validateRequest(changesSchema, req.query);

    const { data: events, error } = await supabaseAdmin
      .from('events')
      .select('id, content, description, place_name, event_at, end_time, category, link_url, event_image_url, updated_at, region:regions (name, slug, timezone)')
      .eq('status', 'published')
      .gt('updated_at', since)
      .order('updated_at', { ascending: true })
      .limit(limit);

    if (error) {
      console.error('[PUBLIC] Changes query failed:', error.message);
      throw createError('Failed to fetch changes', 500, 'SERVER_ERROR');
    }

    const { data: endedEvents } = await supabaseAdmin
      .from('events')
      .select('id')
      .gt('ended_at', since)
      .not('ended_at', 'is', null)
      .limit(limit);

    const deletedIds = (endedEvents || []).map(e => e.id);

    const changedEvents = (events || []).map(event => {
      const region = event.region as unknown as { name: string; slug: string; timezone: string } | null;
      return {
        id: event.id,
        content: event.content,
        description: event.description || null,
        place_name: event.place_name || null,
        event_at: event.event_at || null,
        end_time: event.end_time || null,
        category: event.category || null,
        link_url: event.link_url || null,
        event_image_url: resolveEventImageUrl(event.event_image_url, config.apiBaseUrl),
        region_slug: region?.slug || null,
        updated_at: event.updated_at || null,
      };
    });

    const lastEvent = changedEvents.length > 0 ? changedEvents[changedEvents.length - 1] : undefined;
    const syncCursor = lastEvent?.updated_at ?? since;

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      events: changedEvents,
      deleted_ids: deletedIds,
      sync_cursor: syncCursor,
      has_more: (events || []).length >= limit,
    });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// REDIRECTS — /api/events → /api/v1/events
// =============================================================================

/**
 * GET /api/events — Redirect to canonical v1 API
 * Preserves query parameters.
 */
router.get('/', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(301, `/api/v1/events${qs}`);
});

/**
 * GET /api/events/:id — Redirect to canonical v1 API
 */
router.get('/:id', (req, res) => {
  res.redirect(301, `/api/v1/events/${req.params.id}`);
});

export default router;
