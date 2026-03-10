/**
 * Public Data Endpoints — The Fiber Commons
 *
 * Simple, cacheable public event data endpoints.
 * No authentication required. Rate-limited by IP.
 *
 * These endpoints serve structured event data for lightweight consumers
 * (city dashboards, calendars, civic apps) that don't need the full
 * Neighborhood API v0.2 format or webhook subscriptions.
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, validateUuidParam, resolveEventImageUrl } from '../lib/helpers.js';
import { config } from '../config.js';
import { browseLimiter } from '../middleware/rate-limit.js';

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

// =============================================================================
// SCHEMAS
// =============================================================================

const listEventsSchema = z.object({
  region: z.string().max(100).optional(),
  category: z.string().max(50).optional(),
  start_after: z.string().datetime().optional(),
  start_before: z.string().datetime().optional(),
  near: z.string().regex(/^-?\d+\.?\d*,-?\d+\.?\d*$/).optional(),
  radius_km: z.coerce.number().min(0.1).max(100).default(10),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const changesSchema = z.object({
  since: z.string().datetime({ message: 'since must be a valid ISO 8601 timestamp' }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// =============================================================================
// Event list SELECT projection (public-safe fields only)
// =============================================================================

const PUBLIC_EVENT_SELECT = 'id, content, description, place_name, venue_address, event_at, end_time, category, link_url, event_image_url, event_image_focal_y, latitude, longitude, created_at, updated_at, region:regions (name, slug, timezone)';

const PUBLIC_EVENT_DETAIL_SELECT = 'id, content, description, place_name, venue_address, place_id, event_at, end_time, category, custom_category, mode, link_url, event_image_url, event_image_focal_y, latitude, longitude, recurrence, price, created_at, updated_at, region:regions (name, slug, timezone)';

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET /api/events — List published events
 * Filterable by region, category, date range, geo proximity.
 * Cached for 5 minutes.
 */
router.get('/', browseLimiter, async (req, res, next) => {
  try {
    const params = validateRequest(listEventsSchema, req.query);

    const selectStr = params.region
      ? PUBLIC_EVENT_SELECT.replace('region:regions', 'region:regions!inner')
      : PUBLIC_EVENT_SELECT;

    let query = supabaseAdmin
      .from('events')
      .select(selectStr, { count: 'exact' })
      .eq('status', 'published')
      .is('ended_at', null)
      .order('event_at', { ascending: true })
      .range(params.offset, params.offset + params.limit - 1);

    // Region filter (by slug, via inner join)
    if (params.region) {
      query = query.eq('regions.slug', params.region);
    }

    // Category filter
    if (params.category) {
      const categoryKey = params.category.replace(/-/g, '_');
      query = query.eq('category', categoryKey);
    }

    // Date range filters
    if (params.start_after) {
      query = query.gte('event_at', params.start_after);
    }
    if (params.start_before) {
      query = query.lte('event_at', params.start_before);
    }

    // Geo proximity filter (bounding box approximation)
    if (params.near) {
      const [lat, lng] = params.near.split(',').map(Number);
      if (lat !== undefined && lng !== undefined && !isNaN(lat) && !isNaN(lng)) {
        const radiusKm = params.radius_km;
        const latDelta = radiusKm / 111;
        const lngDelta = radiusKm / (111 * Math.cos(lat * Math.PI / 180));

        query = query
          .not('latitude', 'is', null)
          .gte('latitude', lat - latDelta)
          .lte('latitude', lat + latDelta)
          .gte('longitude', lng - lngDelta)
          .lte('longitude', lng + lngDelta);
      }
    }

    const { data: events, count, error } = await query;

    if (error) {
      console.error('[PUBLIC] Events list error:', error.message);
      throw createError('Failed to fetch events', 500, 'SERVER_ERROR');
    }

    // Transform: resolve image URLs, flatten region
    const publicEvents = ((events || []) as any[]).map(event => {
      const region = event.region as unknown as { name: string; slug: string; timezone: string } | null;
      return {
        id: event.id,
        content: event.content,
        description: event.description || null,
        place_name: event.place_name || null,
        venue_address: (event as unknown as { venue_address?: string }).venue_address || null,
        event_at: event.event_at || null,
        end_time: event.end_time || null,
        category: event.category || null,
        link_url: (event as unknown as { link_url?: string }).link_url || null,
        event_image_url: resolveEventImageUrl(event.event_image_url, config.apiBaseUrl),
        event_image_focal_y: (event as unknown as { event_image_focal_y?: number }).event_image_focal_y ?? 0.5,
        latitude: (event as unknown as { latitude?: number }).latitude || null,
        longitude: (event as unknown as { longitude?: number }).longitude || null,
        region_name: region?.name || null,
        region_slug: region?.slug || null,
        event_timezone: region?.timezone || null,
        created_at: (event as unknown as { created_at?: string }).created_at || null,
        updated_at: (event as unknown as { updated_at?: string }).updated_at || null,
      };
    });

    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      meta: {
        total: count || 0,
        limit: params.limit,
        offset: params.offset,
      },
      events: publicEvents,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/events/:id — Single event detail
 * Cached for 1 hour.
 */
router.get('/:id', browseLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event id');
    const id = req.params.id;

    const { data: event, error } = await supabaseAdmin
      .from('events')
      .select(PUBLIC_EVENT_DETAIL_SELECT)
      .eq('id', id)
      .eq('status', 'published')
      .maybeSingle();

    if (error) {
      console.error('[PUBLIC] Event detail error:', error.message);
      throw createError('Failed to fetch event', 500, 'SERVER_ERROR');
    }

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const region = event.region as unknown as { name: string; slug: string; timezone: string } | null;

    const publicEvent = {
      id: event.id,
      content: event.content,
      description: event.description || null,
      place_name: event.place_name || null,
      venue_address: (event as unknown as { venue_address?: string }).venue_address || null,
      place_id: (event as unknown as { place_id?: string }).place_id || null,
      event_at: event.event_at || null,
      end_time: event.end_time || null,
      category: event.category || null,
      custom_category: (event as unknown as { custom_category?: string }).custom_category || null,
      mode: (event as unknown as { mode?: string }).mode || null,
      link_url: (event as unknown as { link_url?: string }).link_url || null,
      event_image_url: resolveEventImageUrl(event.event_image_url, config.apiBaseUrl),
      event_image_focal_y: (event as unknown as { event_image_focal_y?: number }).event_image_focal_y ?? 0.5,
      latitude: (event as unknown as { latitude?: number }).latitude || null,
      longitude: (event as unknown as { longitude?: number }).longitude || null,
      recurrence: (event as unknown as { recurrence?: string }).recurrence || null,
      price: (event as unknown as { price?: string }).price || null,
      region_name: region?.name || null,
      region_slug: region?.slug || null,
      event_timezone: region?.timezone || null,
      created_at: (event as unknown as { created_at?: string }).created_at || null,
      updated_at: (event as unknown as { updated_at?: string }).updated_at || null,
    };

    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ event: publicEvent });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/events/changes — Public changes endpoint
 * Lightweight alternative to /api/internal/events/sync for consumers
 * that don't have a service key. Lower rate limit, fewer fields.
 */
router.get('/changes', changesLimiter, async (req, res, next) => {
  try {
    const { since, limit } = validateRequest(changesSchema, req.query);

    // Fetch recently updated events (public fields only)
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

    // Fetch deleted event IDs (events that ended since the cursor)
    const { data: endedEvents } = await supabaseAdmin
      .from('events')
      .select('id')
      .gt('ended_at', since)
      .not('ended_at', 'is', null)
      .limit(limit);

    const deletedIds = (endedEvents || []).map(e => e.id);

    // Build lightweight response
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
        link_url: (event as unknown as { link_url?: string }).link_url || null,
        event_image_url: resolveEventImageUrl(event.event_image_url, config.apiBaseUrl),
        region_slug: region?.slug || null,
        updated_at: (event as unknown as { updated_at?: string }).updated_at || null,
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

export default router;
