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
import { validateRequest, validateUuidParam, sanitizeSearchInput } from '../lib/helpers.js';
import { writeLimiter } from '../middleware/rate-limit.js';
import { dispatchWebhooks } from '../lib/webhook-delivery.js';
import { toNeighborhoodEvent, type PortalEventRow } from '../lib/event-transform.js';
import { PORTAL_SELECT, fromTimestamptz } from '../lib/event-operations.js';
import { config } from '../config.js';
import { downloadAndAttachImage } from '../lib/image-processing.js';
import { nominatimGeocode } from '../lib/geocoding.js';
import { sanitizeUrl, checkContributeUrlDomain } from '../lib/url-sanitizer.js';
import { fromRRule } from '../lib/rrule.js';
import { createEventSeries } from '../lib/event-series.js';

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
  image_url: z.string().url().max(2000).optional(), // Fetched, re-encoded through Sharp, and stored in R2
  tags: z.array(z.string().max(50)).max(15).optional(),
  wheelchair_accessible: z.boolean().optional(),
  custom_category: z.string().max(50).optional(),

  // Recurrence (RRULE format — e.g. "FREQ=WEEKLY", "FREQ=MONTHLY;BYDAY=2FR;COUNT=12")
  recurrence: z.string().max(200).optional(),
  instance_count: z.number().int().min(0).max(52).optional(),

  // Venue linkage
  venue_id: z.string().uuid().optional(),

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

/**
 * Resolve coordinates for a contributed event:
 * 1. Use provided lat/lng if present
 * 2. Geocode the address via Nominatim if not
 *
 * Then look up the containing region via PostGIS.
 * Returns resolved coords + region_id (falls back to default region).
 */
async function resolveLocationAndRegion(
  event: z.infer<typeof contributeEventSchema>,
): Promise<{ lat: number | null; lng: number | null; regionId: string | null }> {
  let lat = event.location.lat ?? null;
  let lng = event.location.lng ?? null;

  // Geocode address if no coordinates provided
  if (lat == null || lng == null) {
    if (event.location.address) {
      const coords = await nominatimGeocode(event.location.address);
      if (coords) {
        lat = coords.lat;
        lng = coords.lng;
        console.log(`[CONTRIBUTE] Geocoded "${event.location.address}" → ${lat}, ${lng}`);
      }
    }
  }

  // Look up containing region via PostGIS
  let regionId = config.defaultRegionId;
  if (lat != null && lng != null) {
    const { data } = await supabaseAdmin.rpc('find_user_region', {
      p_longitude: lng,
      p_latitude: lat,
    });
    if (data && data.length > 0) {
      regionId = data[0].region_id;
      console.log(`[CONTRIBUTE] Region resolved: ${data[0].region_name} (${data[0].region_type})`);
    } else {
      console.log(`[CONTRIBUTE] Coordinates ${lat},${lng} outside all active regions — using default`);
    }
  }

  return { lat, lng, regionId };
}

/** Transform a contribute API event into a DB insert row */
function contributeEventToInsert(
  event: z.infer<typeof contributeEventSchema>,
  apiKeyId: string,
  keyName: string,
  tier: string,
  resolved: { lat: number | null; lng: number | null; regionId: string | null },
  opts?: { internalRecurrence?: string; venueId?: string },
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
      resolved.lat != null && resolved.lng != null
        ? `POINT(${resolved.lng} ${resolved.lat})`
        : null,
    latitude: resolved.lat,
    longitude: resolved.lng,
    event_at: startDate.toISOString(),
    end_time: endDate ? endDate.toISOString() : null,
    event_timezone: event.timezone,
    category: event.category,
    custom_category: event.category === 'other' ? event.custom_category || null : null,
    recurrence: opts?.internalRecurrence || 'none',
    price: event.cost ? stripHtml(event.cost) : null,
    link_url: event.url ? sanitizeUrl(event.url) : null,
    event_image_url: null, // Set async by downloadAndAttachImage if image_url provided
    start_time_required: true,
    tags: event.tags || [],
    wheelchair_accessible: event.wheelchair_accessible ?? null,
    rsvp_limit: null,
    event_image_focal_y: 0.5,
    creator_account_id: opts?.venueId || null,
    user_id: null,
    source: 'api',
    source_method: 'api',
    source_publisher: keyName,
    source_feed_url: `api-key:${apiKeyId}`,
    external_id: event.external_id || null,
    visibility: 'public',
    status,
    is_business: false,
    region_id: resolved.regionId,
  };
}

/** Derive a URL-safe slug from a venue name */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
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
    const event = validateRequest(contributeEventSchema, req.body);

    // Parse RRULE if provided (before rate limit so we know the instance count)
    let internalRecurrence: string | undefined;
    let resolvedInstanceCount: number | undefined;
    if (event.recurrence) {
      try {
        const parsed = fromRRule(event.recurrence);
        internalRecurrence = parsed.recurrence;
        resolvedInstanceCount = event.instance_count ?? parsed.instanceCount;
      } catch (err) {
        throw createError((err as Error).message, 400, 'VALIDATION_ERROR');
      }
    }

    // Rate-limit: count by expected instances for recurring events
    const rateLimitCount = (internalRecurrence && internalRecurrence !== 'none')
      ? (resolvedInstanceCount || 12)
      : 1;
    await checkContributeRateLimit(apiKeyId, tier, rateLimitCount);

    // Validate event URL domain if provided
    if (event.url) {
      const domainCheck = checkContributeUrlDomain(event.url);
      if (!domainCheck.approved) {
        throw createError(
          `URL domain "${domainCheck.domain}" is not on the approved list. Contact hello@joinfiber.app to request approval.`,
          400,
          'DOMAIN_NOT_APPROVED',
        );
      }
    }

    // Resolve coordinates (geocode if needed) and find containing region
    const resolved = await resolveLocationAndRegion(event);

    // Verify venue_id if provided
    let venueId: string | undefined;
    if (event.venue_id) {
      const { data: venue } = await supabaseAdmin
        .from('portal_accounts')
        .select('id')
        .eq('id', event.venue_id)
        .eq('status', 'active')
        .maybeSingle();
      if (!venue) throw createError('Venue not found or inactive', 400, 'VALIDATION_ERROR');
      venueId = venue.id;
    }

    const insertData = contributeEventToInsert(event, apiKeyId, keyName, tier, resolved, {
      internalRecurrence,
      venueId,
    });

    // Recurring event: create a series
    if (internalRecurrence && internalRecurrence !== 'none') {
      const { date: eventDate, time: startTime } = fromTimestamptz(event.start, event.timezone);
      const endTime = event.end ? fromTimestamptz(event.end, event.timezone).time : null;

      const instances = await createEventSeries(
        insertData,
        internalRecurrence,
        eventDate,
        startTime,
        endTime,
        event.timezone,
        resolvedInstanceCount,
      );

      // Get series_id from the first created instance
      let seriesId: string | null = null;
      if (instances.length > 0 && instances[0]?.id) {
        const { data: firstEvent } = await supabaseAdmin
          .from('events')
          .select('series_id')
          .eq('id', instances[0].id)
          .maybeSingle();
        seriesId = firstEvent?.series_id || null;
      }

      // Fire-and-forget image download for first instance
      if (event.image_url && instances.length > 0 && instances[0]?.id) {
        void downloadAndAttachImage(instances[0].id, event.image_url);
      }

      console.log(`[CONTRIBUTE] Series created: ${instances.length} instances of "${event.name}" by ${keyName}`);

      res.status(201).json({
        event: {
          series_id: seriesId,
          instance_count: instances.length,
          instance_ids: instances.map(i => i.id),
          status: insertData.status,
          source: { publisher: keyName, method: 'api' },
        },
      });
      return;
    }

    // Single event
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

    // Re-encode external image through Sharp and upload to R2 (fire-and-forget)
    if (event.image_url) {
      void downloadAndAttachImage(row.id, event.image_url);
    }

    // Dispatch webhook with full event data (fire-and-forget)
    if (row.status === 'published') {
      void (async () => {
        try {
          const { data: fullRow } = await supabaseAdmin
            .from('events')
            .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
            .eq('id', row.id)
            .maybeSingle();
          if (fullRow) void dispatchWebhooks('event.created', row.id, toNeighborhoodEvent(fullRow as unknown as PortalEventRow));
        } catch (err) {
          console.error('[CONTRIBUTE] Webhook dispatch error:', err instanceof Error ? err.message : err);
        }
      })();
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

      // Validate event URL domain if provided
      if (event.url) {
        const domainCheck = checkContributeUrlDomain(event.url);
        if (!domainCheck.approved) {
          results.push({ index: i, error: `URL domain "${domainCheck.domain}" not approved` });
          continue;
        }
      }

      // Resolve coordinates and region (geocode if needed)
      const resolved = await resolveLocationAndRegion(event);
      const insertData = contributeEventToInsert(event, apiKeyId, keyName, tier, resolved);

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

      // Re-encode external image through Sharp and upload to R2 (fire-and-forget)
      if (event.image_url) {
        void downloadAndAttachImage(row.id, event.image_url);
      }

      // Dispatch webhook with full event data (fire-and-forget)
      if (row.status === 'published') {
        void (async () => {
          try {
            const { data: fullRow } = await supabaseAdmin
              .from('events')
              .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
              .eq('id', row.id)
              .maybeSingle();
            if (fullRow) void dispatchWebhooks('event.created', row.id, toNeighborhoodEvent(fullRow as unknown as PortalEventRow));
          } catch (err) {
            console.error('[CONTRIBUTE] Webhook dispatch error:', err instanceof Error ? err.message : err);
          }
        })();
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

    // Fetch full event for webhook before deletion
    const { data: fullRow } = await supabaseAdmin
      .from('events')
      .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
      .eq('id', req.params.id)
      .maybeSingle();

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

    if (fullRow) {
      void dispatchWebhooks('event.deleted', req.params.id as string, toNeighborhoodEvent(fullRow as unknown as PortalEventRow));
    }

    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// PATCH — Edit own event
// =============================================================================

const updateContributeEventSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional().nullable(),
  timezone: z.string().max(50).refine(
    (tz) => VALID_TIMEZONES.has(tz),
    { message: 'Invalid timezone. Use IANA format (e.g., America/New_York)' },
  ).optional(),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
  location: locationSchema.partial().optional(),
  description: z.string().max(2000).optional().nullable(),
  cost: z.string().max(100).optional().nullable(),
  url: z.string().url().max(2000).optional().nullable(),
  image_url: z.string().url().max(2000).optional(),
  tags: z.array(z.string().max(50)).max(15).optional(),
  wheelchair_accessible: z.boolean().optional().nullable(),
  custom_category: z.string().max(50).optional(),
  venue_id: z.string().uuid().optional(),
});

/**
 * PATCH /api/v1/contribute/:id
 * Edit an event submitted by this API key.
 */
router.patch('/:id', writeLimiter, async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');
    validateUuidParam(req.params.id, 'event ID');

    const data = validateRequest(updateContributeEventSchema, req.body);
    if (Object.keys(data).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    // Verify ownership
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('events')
      .select('id, event_at, end_time, event_timezone, status')
      .eq('id', req.params.id)
      .eq('source_method', 'api')
      .eq('source_feed_url', `api-key:${apiKeyId}`)
      .maybeSingle();

    if (fetchError || !existing) {
      throw createError('Event not found or not owned by this API key', 404, 'NOT_FOUND');
    }

    const update: Record<string, unknown> = {};

    if (data.name !== undefined) update.content = stripHtml(data.name);
    if (data.description !== undefined) update.description = data.description ? stripHtml(data.description) : null;
    if (data.category !== undefined) update.category = data.category;
    if (data.custom_category !== undefined) update.custom_category = data.custom_category;
    if (data.cost !== undefined) update.price = data.cost ? stripHtml(data.cost) : null;
    if (data.tags !== undefined) update.tags = data.tags;
    if (data.wheelchair_accessible !== undefined) update.wheelchair_accessible = data.wheelchair_accessible;

    // URL validation
    if (data.url !== undefined) {
      if (data.url) {
        const domainCheck = checkContributeUrlDomain(data.url);
        if (!domainCheck.approved) {
          throw createError(`URL domain "${domainCheck.domain}" is not approved`, 400, 'DOMAIN_NOT_APPROVED');
        }
        update.link_url = sanitizeUrl(data.url);
      } else {
        update.link_url = null;
      }
    }

    // Location fields
    if (data.location) {
      if (data.location.name !== undefined) update.place_name = stripHtml(data.location.name);
      if (data.location.address !== undefined) update.venue_address = data.location.address?.slice(0, 500) || null;
      if (data.location.place_id !== undefined) update.place_id = data.location.place_id || null;
      if (data.location.lat !== undefined && data.location.lng !== undefined) {
        update.latitude = data.location.lat;
        update.longitude = data.location.lng;
        if (data.location.lat != null && data.location.lng != null) {
          update.approximate_location = `POINT(${data.location.lng} ${data.location.lat})`;
        }
      }
    }

    // Timestamp recomposition
    if (data.start !== undefined || data.timezone !== undefined) {
      const tz = data.timezone || (existing.event_timezone as string) || 'America/New_York';
      const startIso = data.start || (existing.event_at as string);
      update.event_at = new Date(startIso).toISOString();
      update.event_timezone = tz;
    }
    if (data.end !== undefined) {
      update.end_time = data.end ? new Date(data.end).toISOString() : null;
    }

    // Venue linkage
    if (data.venue_id !== undefined) {
      const { data: venue } = await supabaseAdmin
        .from('portal_accounts')
        .select('id')
        .eq('id', data.venue_id)
        .eq('status', 'active')
        .maybeSingle();
      if (!venue) throw createError('Venue not found or inactive', 400, 'VALIDATION_ERROR');
      update.creator_account_id = venue.id;
    }

    // Execute update with ownership constraints
    const { error: updateError } = await supabaseAdmin
      .from('events')
      .update(update)
      .eq('id', req.params.id)
      .eq('source_method', 'api')
      .eq('source_feed_url', `api-key:${apiKeyId}`);

    if (updateError) {
      console.error('[CONTRIBUTE] Update error:', updateError.message);
      throw createError('Failed to update event', 500, 'SERVER_ERROR');
    }

    // Fire-and-forget image download
    if (data.image_url) {
      void downloadAndAttachImage(req.params.id, data.image_url);
    }

    // Dispatch webhook with full event data (fire-and-forget)
    if (existing.status === 'published') {
      void (async () => {
        try {
          const { data: fullRow } = await supabaseAdmin
            .from('events')
            .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
            .eq('id', req.params.id)
            .maybeSingle();
          if (fullRow) void dispatchWebhooks('event.updated', req.params.id as string, toNeighborhoodEvent(fullRow as unknown as PortalEventRow));
        } catch (err) {
          console.error('[CONTRIBUTE] Webhook dispatch error:', err instanceof Error ? err.message : err);
        }
      })();
    }

    console.log(`[CONTRIBUTE] Event updated: ${req.params.id}`);
    res.json({ updated: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// VENUES
// =============================================================================

const createVenueSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  address: z.string().min(1).max(500).trim(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  place_id: z.string().max(500).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(2000).optional(),
});

const venueSearchSchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

/**
 * POST /api/v1/contribute/venues
 * Create a venue (or return existing if slug matches).
 * Minimum: name + address. Venues are shared resources — not owned by the creator.
 */
router.post('/venues', writeLimiter, async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');

    const data = validateRequest(createVenueSchema, req.body);
    const slug = toSlug(data.name);
    if (!slug) throw createError('Venue name produces an empty slug', 400, 'VALIDATION_ERROR');

    // Dedup: check if a venue with the same slug already exists
    // Narrow by ilike on the first word to avoid full table scan, then slug-match in JS
    const firstWord = data.name.split(/\s+/)[0] || data.name;
    const { data: candidates } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, business_name, default_address, status')
      .eq('status', 'active')
      .ilike('business_name', `${firstWord}%`);

    const existing = (candidates || []).find(c =>
      toSlug(c.business_name as string) === slug
    );

    if (existing) {
      res.status(200).json({
        venue: {
          id: existing.id,
          name: existing.business_name,
          slug,
          address: existing.default_address,
        },
        created: false,
      });
      return;
    }

    // Geocode address if no coordinates
    let lat = data.lat ?? null;
    let lng = data.lng ?? null;
    if (lat == null || lng == null) {
      const coords = await nominatimGeocode(data.address);
      if (coords) {
        lat = coords.lat;
        lng = coords.lng;
      }
    }

    const { data: venue, error } = await supabaseAdmin
      .from('portal_accounts')
      .insert({
        business_name: data.name,
        default_venue_name: data.name,
        default_address: data.address,
        default_latitude: lat,
        default_longitude: lng,
        default_place_id: data.place_id || null,
        phone: data.phone || null,
        website: data.website ? sanitizeUrl(data.website) : null,
        email: `contribute-${slug}@placeholder.internal`,
        status: 'active',
      })
      .select('id, business_name, default_address')
      .single();

    if (error) {
      // Email uniqueness collision (unlikely but handle gracefully)
      if (error.code === '23505') {
        throw createError('A venue with a similar name already exists', 409, 'DUPLICATE');
      }
      console.error('[CONTRIBUTE] Venue create error:', error.message);
      throw createError('Failed to create venue', 500, 'SERVER_ERROR');
    }

    console.log(`[CONTRIBUTE] Venue created: "${data.name}" (${venue.id})`);
    res.status(201).json({
      venue: {
        id: venue.id,
        name: venue.business_name,
        slug,
        address: venue.default_address,
      },
      created: true,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/contribute/venues
 * Search venues.
 */
router.get('/venues', async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');

    const params = validateRequest(venueSearchSchema, req.query);

    let query = supabaseAdmin
      .from('portal_accounts')
      .select('id, business_name, default_address, default_latitude, default_longitude', { count: 'exact' })
      .eq('status', 'active')
      .order('business_name', { ascending: true })
      .range(params.offset, params.offset + params.limit - 1);

    if (params.q) {
      const sanitized = sanitizeSearchInput(params.q);
      if (sanitized) {
        query = query.or(`business_name.ilike.%${sanitized}%,default_address.ilike.%${sanitized}%`);
      }
    }

    const { data: venues, count, error } = await query;

    if (error) {
      console.error('[CONTRIBUTE] Venue search error:', error.message);
      throw createError('Failed to search venues', 500, 'SERVER_ERROR');
    }

    res.json({
      meta: { total: count || 0, limit: params.limit, offset: params.offset },
      venues: (venues || []).map(v => ({
        id: v.id,
        name: v.business_name,
        slug: toSlug(v.business_name as string),
        address: v.default_address,
        lat: v.default_latitude,
        lng: v.default_longitude,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GROUPS
// =============================================================================

const createGroupSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  slug: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().max(2000).optional(),
  type: z.enum(['business', 'community_group', 'nonprofit', 'collective', 'curator']).default('community_group'),
  category_tags: z.array(z.string().max(50)).max(20).optional(),
  neighborhood: z.string().max(200).optional(),
  city: z.string().max(200).default('Philadelphia'),
  address: z.string().max(500).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  website: z.string().url().max(2000).optional(),
  phone: z.string().max(50).optional(),
  links: z.record(z.string()).optional(),
});

const updateGroupSchema = createGroupSchema.partial().omit({ slug: true });

const groupSearchSchema = z.object({
  q: z.string().max(200).optional(),
  type: z.enum(['business', 'community_group', 'nonprofit', 'collective', 'curator']).optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

const groupVenueSchema = z.object({
  venue_name: z.string().min(1).max(200).trim(),
  venue_address: z.string().max(500).optional(),
  place_id: z.string().max(500).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  is_primary: z.boolean().default(false),
});

/**
 * POST /api/v1/contribute/groups
 * Create a group. Dedup by slug — returns existing if match found.
 */
router.post('/groups', writeLimiter, async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');

    const data = validateRequest(createGroupSchema, req.body);

    // Dedup by slug
    const { data: existing } = await supabaseAdmin
      .from('groups')
      .select('id, name, slug, status')
      .eq('slug', data.slug)
      .maybeSingle();

    if (existing) {
      res.status(200).json({ group: existing, created: false });
      return;
    }

    const { data: group, error } = await supabaseAdmin
      .from('groups')
      .insert({
        name: data.name,
        slug: data.slug,
        description: data.description || null,
        type: data.type,
        category_tags: data.category_tags || [],
        neighborhood: data.neighborhood || null,
        city: data.city,
        address: data.address || null,
        latitude: data.lat ?? null,
        longitude: data.lng ?? null,
        website: data.website ? sanitizeUrl(data.website) : null,
        phone: data.phone || null,
        links: data.links || {},
        source_method: 'api',
        source_publisher: (await getKeyInfo(apiKeyId)).name,
        status: 'active',
      })
      .select('id, name, slug, type, status')
      .single();

    if (error) {
      if (error.code === '23505') throw createError('Group with this slug already exists', 409, 'DUPLICATE');
      console.error('[CONTRIBUTE] Group create error:', error.message);
      throw createError('Failed to create group', 500, 'SERVER_ERROR');
    }

    console.log(`[CONTRIBUTE] Group created: "${data.name}" (${group.id})`);
    res.status(201).json({ group, created: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/contribute/groups
 * Search groups.
 */
router.get('/groups', async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');

    const params = validateRequest(groupSearchSchema, req.query);

    let query = supabaseAdmin
      .from('groups')
      .select('id, name, slug, type, neighborhood, status', { count: 'exact' })
      .in('status', ['active', 'dormant'])
      .order('name', { ascending: true })
      .range(params.offset, params.offset + params.limit - 1);

    if (params.q) {
      const sanitized = sanitizeSearchInput(params.q);
      if (sanitized) {
        query = query.or(`name.ilike.%${sanitized}%,neighborhood.ilike.%${sanitized}%`);
      }
    }
    if (params.type) {
      query = query.eq('type', params.type);
    }

    const { data: groups, count, error } = await query;

    if (error) {
      console.error('[CONTRIBUTE] Group search error:', error.message);
      throw createError('Failed to search groups', 500, 'SERVER_ERROR');
    }

    res.json({
      meta: { total: count || 0, limit: params.limit, offset: params.offset },
      groups: groups || [],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/v1/contribute/groups/:id
 * Update a group.
 */
router.patch('/groups/:id', writeLimiter, async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');
    validateUuidParam(req.params.id, 'group ID');

    const data = validateRequest(updateGroupSchema, req.body);

    const update: Record<string, unknown> = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description || null;
    if (data.type !== undefined) update.type = data.type;
    if (data.category_tags !== undefined) update.category_tags = data.category_tags;
    if (data.neighborhood !== undefined) update.neighborhood = data.neighborhood || null;
    if (data.city !== undefined) update.city = data.city;
    if (data.address !== undefined) update.address = data.address || null;
    if (data.lat !== undefined) update.latitude = data.lat;
    if (data.lng !== undefined) update.longitude = data.lng;
    if (data.website !== undefined) update.website = data.website ? sanitizeUrl(data.website) : null;
    if (data.phone !== undefined) update.phone = data.phone || null;
    if (data.links !== undefined) update.links = data.links;

    if (Object.keys(update).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    const { data: group, error } = await supabaseAdmin
      .from('groups')
      .update(update)
      .eq('id', req.params.id)
      .select('id, name, slug, type, status')
      .single();

    if (error) throw createError('Failed to update group', 500, 'SERVER_ERROR');

    res.json({ group });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/contribute/groups/:id/venues
 * Add a venue to a group.
 */
router.post('/groups/:id/venues', writeLimiter, async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');
    validateUuidParam(req.params.id, 'group ID');

    const data = validateRequest(groupVenueSchema, req.body);

    const { data: venue, error } = await supabaseAdmin
      .from('group_venues')
      .insert({
        group_id: req.params.id,
        venue_name: data.venue_name,
        venue_address: data.venue_address || null,
        place_id: data.place_id || null,
        latitude: data.lat ?? null,
        longitude: data.lng ?? null,
        is_primary: data.is_primary,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') throw createError('Venue already linked to this group', 409, 'CONFLICT');
      throw createError('Failed to add venue', 500, 'SERVER_ERROR');
    }

    res.status(201).json({ venue });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/contribute/groups/:groupId/venues/:venueId
 * Remove a venue from a group.
 */
router.delete('/groups/:groupId/venues/:venueId', writeLimiter, async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');
    validateUuidParam(req.params.groupId, 'group ID');
    validateUuidParam(req.params.venueId, 'venue ID');

    const { error } = await supabaseAdmin
      .from('group_venues')
      .delete()
      .eq('id', req.params.venueId)
      .eq('group_id', req.params.groupId);

    if (error) throw createError('Failed to remove venue', 500, 'SERVER_ERROR');

    res.json({ deleted: true, id: req.params.venueId });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/v1/contribute/events/:id/group
 * Link or unlink an event to a group. Ownership enforced.
 */
router.patch('/events/:id/group', writeLimiter, async (req, res, next) => {
  try {
    const apiKeyId = req.apiKeyInfo?.id;
    if (!apiKeyId) throw createError('API key required', 401, 'UNAUTHORIZED');
    validateUuidParam(req.params.id, 'event ID');

    const schema = z.object({ group_id: z.string().uuid().nullable() });
    const { group_id } = validateRequest(schema, req.body);

    // Verify ownership
    const { data: event } = await supabaseAdmin
      .from('events')
      .select('id')
      .eq('id', req.params.id)
      .eq('source_method', 'api')
      .eq('source_feed_url', `api-key:${apiKeyId}`)
      .maybeSingle();

    if (!event) throw createError('Event not found or not owned by this API key', 404, 'NOT_FOUND');

    // Verify group exists if linking
    if (group_id) {
      const { data: group } = await supabaseAdmin
        .from('groups')
        .select('id')
        .eq('id', group_id)
        .in('status', ['active', 'dormant'])
        .maybeSingle();
      if (!group) throw createError('Group not found', 404, 'NOT_FOUND');
    }

    const { error } = await supabaseAdmin
      .from('events')
      .update({ group_id })
      .eq('id', req.params.id)
      .eq('source_method', 'api')
      .eq('source_feed_url', `api-key:${apiKeyId}`);

    if (error) throw createError('Failed to update event group', 500, 'SERVER_ERROR');

    res.json({ updated: true, event_id: req.params.id, group_id });
  } catch (err) {
    next(err);
  }
});

export default router;
