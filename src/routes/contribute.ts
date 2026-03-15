/**
 * Contribute API — Neighborhood Commons
 *
 * External apps push events into the commons via API key auth.
 * Events are validated, attributed, and placed in review queue
 * (or auto-published for verified/trusted contributors).
 *
 * Base: /api/v1/contribute
 * Auth: X-API-Key header (required)
 */

import { Router } from 'express';
import { z } from 'zod';
import { EVENT_CATEGORY_KEYS } from '../lib/categories.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { requireApiKey } from '../middleware/api-key.js';
import { validateRequest, validateUuidParam } from '../lib/helpers.js';
import { writeLimiter } from '../middleware/rate-limit.js';
import { dispatchWebhooks } from '../lib/webhook-delivery.js';
import type { NeighborhoodEvent } from '../lib/event-transform.js';
import { config } from '../config.js';

const router: ReturnType<typeof Router> = Router();

// All contribute routes require an API key
router.use(requireApiKey);

// =============================================================================
// SCHEMAS
// =============================================================================

const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

const locationSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  address: z.string().max(500).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  place_id: z.string().max(500).optional(),
});

const contributeEventSchema = z.object({
  // Required — Neighborhood API field names
  name: z.string().min(1).max(200).trim(),
  start: z.string().datetime({ offset: true }),
  timezone: z.string().max(50).refine(
    (tz) => VALID_TIMEZONES.has(tz),
    { message: 'Invalid timezone. Use IANA format (e.g., America/New_York)' },
  ),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]),
  location: locationSchema,

  // Optional
  end: z.string().datetime({ offset: true }).optional(),
  description: z.string().max(2000).optional(),
  cost: z.string().max(100).optional(),
  url: z.string().url().max(2000).optional(),
  image_url: z.string().url().max(2000).optional(), // External URL reference only — not fetched or re-encoded server-side
  tags: z.array(z.string().max(50)).max(15).optional(),
  wheelchair_accessible: z.boolean().optional(),
  custom_category: z.string().max(50).optional(),

  // External tracking (for dedup)
  external_id: z.string().max(500).optional(),
});

const contributeBatchSchema = z.object({
  events: z.array(contributeEventSchema).min(1).max(50),
});

// =============================================================================
// RATE LIMITS (DB-backed, per API key, by tier)
// =============================================================================

const TIER_LIMITS: Record<string, { hourly: number; daily: number }> = {
  pending: { hourly: 20, daily: 100 },
  verified: { hourly: 100, daily: 500 },
  trusted: { hourly: 500, daily: 2000 },
};

async function checkContributeRateLimit(apiKeyId: string, tier: string, batchSize: number = 1): Promise<void> {
  const limits = TIER_LIMITS[tier] || TIER_LIMITS['pending'];
  const keyFeed = `api-key:${apiKeyId}`;

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Hourly check — account for batch size (BUG 6 fix: prevent batch bypass)
  const { count: hourly } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('source_method', 'api')
    .eq('source_feed_url', keyFeed)
    .gte('created_at', oneHourAgo);

  if ((hourly || 0) + batchSize > limits.hourly) {
    throw createError(`Contribution limit reached (${limits.hourly}/hour). Try again later.`, 429, 'RATE_LIMIT');
  }

  // Daily check — account for batch size
  const { count: daily } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('source_method', 'api')
    .eq('source_feed_url', keyFeed)
    .gte('created_at', oneDayAgo);

  if ((daily || 0) + batchSize > limits.daily) {
    throw createError(`Contribution limit reached (${limits.daily}/day). Try again later.`, 429, 'RATE_LIMIT');
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/** Look up the API key's contributor tier and name */
async function getKeyInfo(apiKeyId: string): Promise<{ tier: string; name: string }> {
  const { data } = await supabaseAdmin
    .from('api_keys')
    .select('contributor_tier, name')
    .eq('id', apiKeyId)
    .single();

  return {
    tier: data?.contributor_tier || 'pending',
    name: data?.name || 'Unknown',
  };
}

/** Strip HTML tags from text fields */
function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Transform a contribute API event into a DB insert row */
function contributeEventToInsert(
  event: z.infer<typeof contributeEventSchema>,
  apiKeyId: string,
  keyName: string,
  tier: string,
): Record<string, unknown> {
  const startDate = new Date(event.start);
  const endDate = event.end ? new Date(event.end) : null;

  const status = (tier === 'verified' || tier === 'trusted') ? 'published' : 'pending_review';

  return {
    content: stripHtml(event.name),
    description: event.description ? stripHtml(event.description) : null,
    place_name: stripHtml(event.location.name),
    venue_address: event.location.address?.slice(0, 500) || null,
    place_id: event.location.place_id || null,
    approximate_location:
      event.location.lat != null && event.location.lng != null
        ? `POINT(${event.location.lng} ${event.location.lat})`
        : null,
    latitude: event.location.lat ?? null,
    longitude: event.location.lng ?? null,
    event_at: startDate.toISOString(),
    end_time: endDate ? endDate.toISOString() : null,
    event_timezone: event.timezone,
    category: event.category,
    custom_category: event.category === 'other' ? event.custom_category || null : null,
    recurrence: 'none',
    price: event.cost ? stripHtml(event.cost) : null,
    link_url: event.url || null,
    event_image_url: event.image_url || null,
    start_time_required: true,
    tags: event.tags || [],
    wheelchair_accessible: event.wheelchair_accessible ?? null,
    rsvp_limit: null,
    event_image_focal_y: 0.5,
    creator_account_id: null,
    user_id: null,
    source: 'api',
    source_method: 'api',
    source_publisher: keyName,
    source_feed_url: `api-key:${apiKeyId}`,
    external_id: event.external_id || null,
    visibility: 'public',
    status,
    is_business: false,
    region_id: config.defaultRegionId,
  };
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * POST /api/v1/contribute
 * Submit a single event.
 */
router.post('/', writeLimiter, async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');

    const { tier, name: keyName } = await getKeyInfo(apiKeyId);
    await checkContributeRateLimit(apiKeyId, tier);

    const event = validateRequest(contributeEventSchema, req.body);
    const insertData = contributeEventToInsert(event, apiKeyId, keyName, tier);

    const { data: row, error } = await supabaseAdmin
      .from('events')
      .insert(insertData)
      .select('id, status')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw createError('Event already exists (duplicate external_id)', 409, 'DUPLICATE');
      }
      console.error('[CONTRIBUTE] Insert error:', error.message);
      throw createError('Failed to create event', 500, 'SERVER_ERROR');
    }

    console.log(`[CONTRIBUTE] Event created: "${event.name}" (${row.id}) by ${keyName} [${row.status}]`);

    // Dispatch webhook for published events
    if (row.status === 'published') {
      void dispatchWebhooks('event.created', row.id, { id: row.id, name: event.name, start: event.start } as unknown as NeighborhoodEvent);
    }

    res.status(201).json({
      event: {
        id: row.id,
        status: row.status,
        source: {
          publisher: keyName,
          method: 'api',
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/contribute/batch
 * Submit up to 50 events at once.
 * Validates all first; inserts individually (partial success allowed).
 */
router.post('/batch', writeLimiter, async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');

    const { tier, name: keyName } = await getKeyInfo(apiKeyId);
    const { events } = validateRequest(contributeBatchSchema, req.body);
    await checkContributeRateLimit(apiKeyId, tier, events.length);

    const results: Array<{ index: number; id?: string; status?: string; error?: string }> = [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const insertData = contributeEventToInsert(event, apiKeyId, keyName, tier);

      const { data: row, error } = await supabaseAdmin
        .from('events')
        .insert(insertData)
        .select('id, status')
        .single();

      if (error) {
        if (error.code === '23505') {
          results.push({ index: i, error: 'Duplicate external_id' });
        } else {
          results.push({ index: i, error: 'Database error' });
        }
        continue;
      }

      results.push({ index: i, id: row.id, status: row.status });

      // Dispatch webhook for published events
      if (row.status === 'published') {
        void dispatchWebhooks('event.created', row.id, { id: row.id, name: event.name, start: event.start } as unknown as NeighborhoodEvent);
      }
    }

    const created = results.filter(r => r.id).length;
    const failed = results.filter(r => r.error).length;
    console.log(`[CONTRIBUTE] Batch: ${created} created, ${failed} failed by ${keyName}`);

    // 201 = all succeeded, 207 = partial, 400 = all failed
    const statusCode = created === 0 ? 400 : failed === 0 ? 201 : 207;
    res.status(statusCode).json({
      results,
      summary: {
        total: events.length,
        created,
        failed,
        publisher: keyName,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/contribute/mine
 * List events submitted by this API key.
 */
router.get('/mine', async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');

    const statusFilter = req.query.status as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    let query = supabaseAdmin
      .from('events')
      .select('id, content, event_at, end_time, event_timezone, place_name, category, status, external_id, created_at', { count: 'exact' })
      .eq('source_method', 'api')
      .eq('source_feed_url', `api-key:${apiKeyId}`)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (statusFilter && ['published', 'pending_review', 'unpublished'].includes(statusFilter)) {
      query = query.eq('status', statusFilter);
    }

    const { data: events, count, error } = await query;

    if (error) {
      console.error('[CONTRIBUTE] List error:', error.message);
      throw createError('Failed to fetch events', 500, 'SERVER_ERROR');
    }

    res.json({
      meta: { total: count || 0, limit, offset },
      events: (events || []).map(e => ({
        id: e.id,
        name: e.content,
        start: e.event_at,
        end: e.end_time,
        timezone: e.event_timezone,
        venue: e.place_name,
        category: e.category,
        status: e.status,
        external_id: e.external_id,
        created_at: e.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/contribute/:id
 * Delete an event submitted by this API key.
 */
router.delete('/:id', writeLimiter, async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');
    validateUuidParam(req.params.id, 'event ID');

    // Only allow deletion of events this key created
    const { data: event, error: fetchError } = await supabaseAdmin
      .from('events')
      .select('id, source_feed_url')
      .eq('id', req.params.id)
      .eq('source_method', 'api')
      .eq('source_feed_url', `api-key:${apiKeyId}`)
      .maybeSingle();

    if (fetchError || !event) {
      throw createError('Event not found or not owned by this API key', 404, 'NOT_FOUND');
    }

    // Defense-in-depth: carry ownership constraints on the DELETE itself
    const { error: deleteError } = await supabaseAdmin
      .from('events')
      .delete()
      .eq('id', req.params.id)
      .eq('source_method', 'api')
      .eq('source_feed_url', `api-key:${apiKeyId}`);

    if (deleteError) {
      console.error('[CONTRIBUTE] Delete error:', deleteError.message);
      throw createError('Failed to delete event', 500, 'SERVER_ERROR');
    }

    void dispatchWebhooks('event.deleted', req.params.id, { id: req.params.id } as unknown as NeighborhoodEvent);

    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

export default router;
