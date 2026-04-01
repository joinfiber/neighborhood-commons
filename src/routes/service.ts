/**
 * Service API — Neighborhood Commons
 *
 * Full CRUD for accounts and events via service-tier API keys.
 * Enables external admin tools to manage the commons dataset
 * without Supabase JWT auth. Any trusted operator can build
 * their own admin tool against these endpoints.
 *
 * Auth: X-API-Key header with contributor_tier='service'
 * Base: /api/v1/service
 */

import { Router, json as expressJson } from 'express';
import { z } from 'zod';
import { EVENT_CATEGORY_KEYS } from '../lib/categories.js';
import { validateTags } from '../lib/tags.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, validateUuidParam, resolveEventImageUrl } from '../lib/helpers.js';
import { requireServiceApiKey } from '../middleware/api-key.js';
import { dispatchWebhooks } from '../lib/webhook-delivery.js';
import { toNeighborhoodEvent, type PortalEventRow } from '../lib/event-transform.js';
import { serviceLimiter } from '../middleware/rate-limit.js';
import {
  PORTAL_SELECT, MANAGED_SOURCES, toPortalEvent, portalInputToInsert,
  toTimestamptz, getAdminUserId,
} from '../lib/event-operations.js';
import { createEventSeries } from '../lib/event-series.js';
import { processAndUploadImage, downloadAndAttachImage } from '../lib/image-processing.js';
import { nominatimGeocode } from '../lib/geocoding.js';
import { config } from '../config.js';

/** Per-route body limit override for image uploads (12MB vs global 5MB) */
const imageBodyLimit = expressJson({ limit: '12mb' });

const router: ReturnType<typeof Router> = Router();

// All service routes require a service-tier API key
router.use(requireServiceApiKey);

// =============================================================================
// ACCOUNTS
// =============================================================================

const createAccountSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
  business_name: z.string().min(1).max(200),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(500).optional().or(z.literal('')),
  default_venue_name: z.string().max(200).optional(),
  default_place_id: z.string().max(500).optional(),
  default_address: z.string().max(500).optional(),
  default_latitude: z.number().min(-90).max(90).optional(),
  default_longitude: z.number().min(-180).max(180).optional(),
  operating_hours: z.array(z.object({
    open: z.boolean(),
    ranges: z.array(z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    })),
  })).length(7).optional(),
});

const updateAccountSchema = z.object({
  business_name: z.string().min(1).max(200).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(500).optional().or(z.literal('')),
  default_venue_name: z.string().max(200).optional(),
  default_place_id: z.string().max(500).optional(),
  default_address: z.string().max(500).optional(),
  default_latitude: z.number().min(-90).max(90).optional(),
  default_longitude: z.number().min(-180).max(180).optional(),
  operating_hours: z.array(z.object({
    open: z.boolean(),
    ranges: z.array(z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    })),
  })).length(7).optional(),
  status: z.enum(['active', 'suspended', 'pending', 'rejected']).optional(),
  logo_url: z.string().url().max(2000).optional().or(z.literal('')).or(z.null()),
  cover_image_url: z.string().url().max(2000).optional().or(z.literal('')).or(z.null()),
  description: z.string().max(2000).optional().or(z.literal('')).or(z.null()),
});

/** GET /service/accounts — List accounts with event counts, optional search + pagination */
router.get('/accounts', serviceLimiter, async (req, res, next) => {
  try {
    const search = req.query.search as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 500, 500);
    const offset = parseInt(req.query.offset as string) || 0;

    let query = supabaseAdmin
      .from('portal_accounts')
      .select('id, email, business_name, auth_user_id, status, default_venue_name, default_place_id, default_address, default_latitude, default_longitude, website, phone, operating_hours, logo_url, cover_image_url, description, last_login_at, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (search) {
      query = query.or(`business_name.ilike.%${search}%,default_address.ilike.%${search}%`);
    }

    query = query.range(offset, offset + limit - 1);

    const { data: accounts, error, count } = await query;

    if (error) throw createError('Failed to fetch accounts', 500, 'SERVER_ERROR');

    // Count unique events per account
    const accountIds = (accounts || []).map((a: { id: string }) => a.id);
    let eventCounts: Record<string, number> = {};
    if (accountIds.length > 0) {
      const { data: counts } = await supabaseAdmin
        .from('events')
        .select('creator_account_id, series_id, series_instance_number')
        .in('source', [...MANAGED_SOURCES])
        .in('creator_account_id', accountIds);

      if (counts) {
        eventCounts = counts.reduce((acc: Record<string, number>, row: { creator_account_id: string; series_id: string | null; series_instance_number: number | null }) => {
          if (row.series_id && row.series_instance_number !== 1) return acc;
          acc[row.creator_account_id] = (acc[row.creator_account_id] || 0) + 1;
          return acc;
        }, {});
      }
    }

    const result = (accounts || []).map((a: { id: string }) => ({
      ...a,
      event_count: eventCounts[a.id] || 0,
    }));

    res.json({ accounts: result, total: count ?? result.length });
  } catch (err) {
    next(err);
  }
});

/** GET /service/accounts/:id — Single account with events */
router.get('/accounts/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, email, business_name, auth_user_id, status, default_venue_name, default_place_id, default_address, default_latitude, default_longitude, website, phone, operating_hours, last_login_at, claimed_at, created_at, updated_at')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error || !account) throw createError('Account not found', 404, 'NOT_FOUND');

    // Fetch unique events only (one-offs + first instance of each series)
    // and limit to a reasonable page size. Past events are rarely needed in this view.
    const { data: events } = await supabaseAdmin
      .from('events')
      .select(PORTAL_SELECT)
      .eq('creator_account_id', account.id)
      .in('source', [...MANAGED_SOURCES])
      .or('series_id.is.null,series_instance_number.eq.1')
      .order('event_at', { ascending: false })
      .limit(200);

    res.json({ account, events: (events || []).map(toPortalEvent) });
  } catch (err) {
    next(err);
  }
});

/** POST /service/accounts — Create account */
router.post('/accounts', serviceLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(createAccountSchema, req.body);

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .insert({
        email: data.email,
        business_name: data.business_name,
        phone: data.phone || null,
        website: data.website || null,
        default_venue_name: data.default_venue_name || null,
        default_place_id: data.default_place_id || null,
        default_address: data.default_address || null,
        default_latitude: data.default_latitude ?? null,
        default_longitude: data.default_longitude ?? null,
        operating_hours: data.operating_hours ?? null,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') throw createError('Account with this email already exists', 409, 'CONFLICT');
      console.error('[SERVICE] Create account error:', error.message);
      throw createError('Failed to create account', 500, 'SERVER_ERROR');
    }

    console.log(`[SERVICE] Account created: ${account.business_name}`);
    res.status(201).json({ account });
  } catch (err) {
    next(err);
  }
});

/** PATCH /service/accounts/:id — Update account */
router.patch('/accounts/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    const data = validateRequest(updateAccountSchema, req.body);

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) update[key] = value ?? null;
    }

    if (Object.keys(update).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .update(update)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw createError('Failed to update account', 500, 'SERVER_ERROR');
    res.json({ account });
  } catch (err) {
    next(err);
  }
});

/** DELETE /service/accounts/:id — Delete account and all its events */
router.delete('/accounts/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');

    // Delete all events owned by this account first
    await supabaseAdmin
      .from('events')
      .delete()
      .eq('creator_account_id', req.params.id);

    // Delete the account
    const { error } = await supabaseAdmin
      .from('portal_accounts')
      .delete()
      .eq('id', req.params.id);

    if (error) throw createError('Failed to delete account', 500, 'SERVER_ERROR');

    console.log(`[SERVICE] Account deleted: ${req.params.id}`);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// EVENTS
// =============================================================================

const createEventSchema = z.object({
  account_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  venue_name: z.string().min(1).max(200),
  address: z.string().max(500).optional(),
  place_id: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]),
  custom_category: z.string().max(30).optional(),
  recurrence: z.string()
    .regex(/^(none|daily|weekly|biweekly|monthly|ordinal_weekday:[1-5]:(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|weekly_days:(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*)$/)
    .default('none'),
  instance_count: z.number().int().min(0).max(260).optional(),
  event_timezone: z.string().max(50).default('America/New_York'),
  description: z.string().max(2000).optional(),
  price: z.string().max(100).optional(),
  ticket_url: z.preprocess(
    (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    z.string().url().max(2000).optional().or(z.literal('')),
  ),
  tags: z.array(z.string().max(50)).max(15).optional(),
  wheelchair_accessible: z.boolean().nullable().default(null),
  rsvp_limit: z.number().int().min(1).max(10000).nullable().default(null),
  start_time_required: z.boolean().default(true),
  image_focal_y: z.number().min(0).max(1).optional(),
});

const updateEventSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  venue_name: z.string().min(1).max(200).optional(),
  address: z.string().max(500).optional(),
  place_id: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
  custom_category: z.string().max(30).optional().nullable(),
  event_timezone: z.string().max(50).optional(),
  description: z.string().max(2000).optional().nullable(),
  price: z.string().max(100).optional().nullable(),
  ticket_url: z.preprocess(
    (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    z.string().url().max(2000).optional().or(z.literal('')).nullable(),
  ),
  tags: z.array(z.string().max(50)).max(15).optional(),
  wheelchair_accessible: z.boolean().nullable().optional(),
  rsvp_limit: z.number().int().min(1).max(10000).nullable().optional(),
  start_time_required: z.boolean().optional(),
  image_focal_y: z.number().min(0).max(1).optional(),
  status: z.enum(['published', 'pending_review', 'suspended', 'unpublished']).optional(),
});

/** GET /service/events — Events with pagination, search, and filters */
router.get('/events', serviceLimiter, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.search as string | undefined;
    const time = req.query.time as string | undefined; // 'upcoming' | 'past' | 'all'

    let query = supabaseAdmin
      .from('events')
      .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name, email)`, { count: 'exact' })
      .in('source', [...MANAGED_SOURCES]);

    // Status filter
    const status = req.query.status as string | undefined;
    if (status) {
      const allowed = ['published', 'pending_review', 'suspended', 'draft'];
      if (!allowed.includes(status)) throw createError(`Invalid status filter: ${status}`, 400, 'VALIDATION_ERROR');
      query = query.eq('status', status);
    }

    // Source method filter (e.g. 'api' for contributed events)
    const sourceMethod = req.query.source_method as string | undefined;
    if (sourceMethod) {
      query = query.eq('source_method', sourceMethod);
    }

    // Category filter
    const category = req.query.category as string | undefined;
    if (category) {
      query = query.eq('category', category);
    }

    // Text search on title, venue name, and address (covers zip code searches)
    if (search) {
      query = query.or(`content.ilike.%${search}%,place_name.ilike.%${search}%,venue_address.ilike.%${search}%`);
    }

    // Time filter
    const now = new Date().toISOString();
    if (time === 'upcoming' || !time) {
      query = query.gte('event_at', now);
      query = query.order('event_at', { ascending: true });
    } else if (time === 'past') {
      query = query.lt('event_at', now);
      query = query.order('event_at', { ascending: false });
    } else {
      // 'all' — order by creation date
      query = query.order('created_at', { ascending: false });
    }

    // Filter to unique events: one-offs + first instance of each series
    query = query.or('series_id.is.null,series_instance_number.eq.1');
    query = query.range(offset, offset + limit - 1);

    const { data: rawEvents, error, count } = await query;

    if (error) throw createError('Failed to fetch events', 500, 'SERVER_ERROR');

    const paged = rawEvents || [];

    const result = paged.map((e) => {
      const pe = toPortalEvent(e);
      pe.portal_accounts = e.portal_accounts;
      return pe;
    });

    res.json({ events: result, total: count || 0 });
  } catch (err) {
    next(err);
  }
});

/** GET /service/events/:id — Single event with account */
router.get('/events/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');

    const { data: event, error } = await supabaseAdmin
      .from('events')
      .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(id, email, business_name, status)`)
      .eq('id', req.params.id)
      .maybeSingle();

    if (error || !event) throw createError('Event not found', 404, 'NOT_FOUND');
    res.json({ event: toPortalEvent(event), account: event.portal_accounts || null });
  } catch (err) {
    next(err);
  }
});

/** POST /service/events — Create event (with optional recurrence) */
router.post('/events', serviceLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(createEventSchema, req.body);

    // Verify account exists
    const { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, auth_user_id')
      .eq('id', data.account_id)
      .maybeSingle();

    if (!account) throw createError('Account not found', 404, 'NOT_FOUND');

    const adminUserId = account.auth_user_id || getAdminUserId();
    const validatedTags = data.tags ? validateTags(data.tags, data.category) : [];

    const insert = portalInputToInsert({
      ...data,
      title: data.title,
      tags: validatedTags,
    }, data.account_id, adminUserId);

    // Resolve coordinates + region (matching Contribute API behavior)
    let lat = data.latitude ?? null;
    let lng = data.longitude ?? null;

    // If no coordinates but has address, geocode it
    if (lat == null && lng == null && data.address) {
      try {
        const coords = await nominatimGeocode(data.address);
        if (coords) {
          lat = coords.lat;
          lng = coords.lng;
          insert.latitude = lat;
          insert.longitude = lng;
          insert.approximate_location = `POINT(${lng} ${lat})`;
          console.log(`[SERVICE] Geocoded "${data.address}" → ${lat}, ${lng}`);
        }
      } catch (err) {
        console.error('[SERVICE] Geocode failed:', err instanceof Error ? err.message : err);
      }
    }

    // Resolve region from coordinates
    if (lat != null && lng != null) {
      const { data: regionData } = await supabaseAdmin.rpc('find_user_region', {
        p_longitude: lng,
        p_latitude: lat,
      });
      if (regionData && regionData.length > 0) {
        insert.region_id = regionData[0].region_id;
        console.log(`[SERVICE] Region resolved: ${regionData[0].region_name}`);
      }
    }

    // Ensure region_id is never null — fall back to default
    if (!insert.region_id && config.defaultRegionId) {
      insert.region_id = config.defaultRegionId;
    }

    if (data.recurrence !== 'none') {
      // Recurring: create series
      const instances = await createEventSeries(
        insert,
        data.recurrence,
        data.event_date,
        data.start_time,
        data.end_time,
        data.event_timezone,
        data.instance_count,
      );

      console.log(`[SERVICE] Series created: ${data.title} (${instances.length} instances)`);
      res.status(201).json({
        series_count: instances.length,
        series_id: instances[0] ? (await supabaseAdmin.from('events').select('series_id').eq('id', instances[0].id).maybeSingle()).data?.series_id : null,
        instance_ids: instances.map(i => i.id),
      });
    } else {
      // One-off event
      console.log('[SERVICE] Insert payload:', JSON.stringify(insert).slice(0, 1000));
      const { data: event, error } = await supabaseAdmin
        .from('events')
        .insert(insert)
        .select(PORTAL_SELECT)
        .single();

      if (error) {
        console.error('[SERVICE] Create event error:', error.message);
        throw createError('Failed to create event', 500, 'SERVER_ERROR');
      }

      // Dispatch webhook (fire-and-forget)
      void (async () => {
        try {
          const { data: row } = await supabaseAdmin
            .from('events')
            .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
            .eq('id', event.id)
            .maybeSingle();
          if (row) void dispatchWebhooks('event.created', event.id, toNeighborhoodEvent(row as unknown as PortalEventRow));
        } catch (err) {
          console.error('[SERVICE] Webhook dispatch error:', err instanceof Error ? err.message : err);
        }
      })();

      console.log(`[SERVICE] Event created: ${data.title}`);
      res.status(201).json({ event: toPortalEvent(event) });
    }
  } catch (err) {
    next(err);
  }
});

/** PATCH /service/events/:id — Update single event */
router.patch('/events/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const data = validateRequest(updateEventSchema, req.body);

    // Fetch existing event
    const { data: existing } = await supabaseAdmin
      .from('events')
      .select('id, status, event_timezone, creator_account_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!existing) throw createError('Event not found', 404, 'NOT_FOUND');

    const tz = data.event_timezone || existing.event_timezone || 'America/New_York';
    const wasPublished = existing.status === 'published';
    const dbUpdate: Record<string, unknown> = {};

    if (data.status !== undefined) dbUpdate.status = data.status;
    if (data.title !== undefined) dbUpdate.content = data.title;
    if (data.venue_name !== undefined) dbUpdate.place_name = data.venue_name;
    if (data.address !== undefined) dbUpdate.venue_address = data.address;
    if (data.place_id !== undefined) dbUpdate.place_id = data.place_id;
    if (data.latitude !== undefined) dbUpdate.latitude = data.latitude;
    if (data.longitude !== undefined) dbUpdate.longitude = data.longitude;
    if (data.description !== undefined) dbUpdate.description = data.description;
    if (data.price !== undefined) dbUpdate.price = data.price;
    if (data.ticket_url !== undefined) dbUpdate.link_url = data.ticket_url || null;
    if (data.category !== undefined) dbUpdate.category = data.category;
    if (data.custom_category !== undefined) dbUpdate.custom_category = data.custom_category;
    if (data.event_timezone !== undefined) dbUpdate.event_timezone = data.event_timezone;
    if (data.wheelchair_accessible !== undefined) dbUpdate.wheelchair_accessible = data.wheelchair_accessible;
    if (data.rsvp_limit !== undefined) dbUpdate.rsvp_limit = data.rsvp_limit;
    if (data.start_time_required !== undefined) dbUpdate.start_time_required = data.start_time_required;
    if (data.image_focal_y !== undefined) dbUpdate.event_image_focal_y = data.image_focal_y;

    if (data.tags !== undefined) {
      const cat = data.category || 'community';
      dbUpdate.tags = validateTags(data.tags, cat);
    }

    if (data.event_date && data.start_time) {
      dbUpdate.event_at = toTimestamptz(data.event_date, data.start_time, tz);
    }
    if (data.end_time !== undefined) {
      if (data.end_time && data.event_date) {
        dbUpdate.end_time = toTimestamptz(data.event_date, data.end_time, tz);
      } else {
        dbUpdate.end_time = null;
      }
    }

    if (Object.keys(dbUpdate).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    const { data: updated, error } = await supabaseAdmin
      .from('events')
      .update(dbUpdate)
      .eq('id', req.params.id)
      .select(PORTAL_SELECT)
      .single();

    if (error) throw createError('Failed to update event', 500, 'SERVER_ERROR');

    // Dispatch webhook when event transitions to published (e.g. approved from pending_review)
    if (data.status === 'published' && !wasPublished) {
      (async () => {
        try {
          const { data: row } = await supabaseAdmin
            .from('events')
            .select(`*, portal_accounts!events_creator_account_id_fkey(business_name)`)
            .eq('id', updated.id)
            .maybeSingle();
          if (row) void dispatchWebhooks('event.created', updated.id, toNeighborhoodEvent(row as unknown as PortalEventRow));
        } catch (err) {
          console.error('[SERVICE] Webhook dispatch error:', err instanceof Error ? err.message : err);
        }
      })();
    }

    res.json({ event: toPortalEvent(updated) });
  } catch (err) {
    next(err);
  }
});

/** DELETE /service/events/:id — Delete event */
router.delete('/events/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');

    const { error } = await supabaseAdmin
      .from('events')
      .delete()
      .eq('id', req.params.id);

    if (error) throw createError('Failed to delete event', 500, 'SERVER_ERROR');
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

/** PATCH /service/events/batch — Bulk update events */
router.patch('/events/batch', serviceLimiter, async (req, res, next) => {
  try {
    const schema = z.object({
      ids: z.array(z.string().uuid()).min(1).max(200),
      updates: z.object({
        category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
        tags: z.array(z.string().max(50)).max(15).optional(),
        description: z.string().max(2000).optional().nullable(),
        price: z.string().max(100).optional().nullable(),
        wheelchair_accessible: z.boolean().nullable().optional(),
        start_time_required: z.boolean().optional(),
      }).refine((u) => Object.keys(u).length > 0, { message: 'No fields to update' }),
    });

    const data = validateRequest(schema, req.body);
    const dbUpdate: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data.updates)) {
      if (key === 'tags' && data.updates.category) {
        dbUpdate.tags = validateTags(value as string[], data.updates.category);
      } else {
        dbUpdate[key] = value;
      }
    }

    const { data: updated, error } = await supabaseAdmin
      .from('events')
      .update(dbUpdate)
      .in('id', data.ids)
      .select('id');

    if (error) throw createError('Failed to batch update', 500, 'SERVER_ERROR');
    res.json({ updated: updated?.length || 0, ids: (updated || []).map((r) => r.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /service/events/:id/image — Upload event image
 *
 * Accepts three formats:
 * 1. JSON: { "image": "<base64>" } — legacy, backward compatible
 * 2. JSON: { "image_url": "https://..." } — download from URL (preferred for scraped images)
 * 3. Multipart: form field "file" — standard file upload (preferred for user uploads)
 */
router.post('/events/:id/image', imageBodyLimit, serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const eventId = req.params.id;

    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
      // Multipart file upload — read raw body chunks
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);

      // Parse multipart boundary
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) throw createError('Missing multipart boundary', 400, 'VALIDATION_ERROR');

      // Extract the file data between boundaries
      const boundary = boundaryMatch[1];
      const parts = body.toString('binary').split(`--${boundary}`);
      let fileBuffer: Buffer | null = null;

      for (const part of parts) {
        if (part.includes('filename=')) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd >= 0) {
            const fileData = part.slice(headerEnd + 4).replace(/\r\n$/, '');
            fileBuffer = Buffer.from(fileData, 'binary');
          }
        }
      }

      if (!fileBuffer || fileBuffer.length < 8) {
        throw createError('No valid file found in upload', 400, 'VALIDATION_ERROR');
      }

      const base64 = fileBuffer.toString('base64');
      const imageUrl = await processAndUploadImage(eventId, base64);

      await supabaseAdmin.from('events').update({ event_image_url: imageUrl }).eq('id', eventId);
      res.json({ image_url: resolveEventImageUrl(imageUrl, config.apiBaseUrl) });

    } else if (req.body?.image_url) {
      // URL-based: download, process, upload
      const { image_url } = req.body;
      if (typeof image_url !== 'string' || !image_url.startsWith('http')) {
        throw createError('image_url must be a valid HTTP URL', 400, 'VALIDATION_ERROR');
      }

      await downloadAndAttachImage(eventId, image_url);

      // Re-fetch to get the stored URL
      const { data: updated } = await supabaseAdmin
        .from('events')
        .select('event_image_url')
        .eq('id', eventId)
        .maybeSingle();

      res.json({ image_url: resolveEventImageUrl(updated?.event_image_url || '', config.apiBaseUrl) });

    } else if (req.body?.image) {
      // Legacy base64 JSON
      const image = req.body.image as string;
      if (typeof image !== 'string' || image.length < 1) {
        throw createError('image must be a non-empty base64 string', 400, 'VALIDATION_ERROR');
      }

      const imageUrl = await processAndUploadImage(eventId, image);
      await supabaseAdmin.from('events').update({ event_image_url: imageUrl }).eq('id', eventId);
      res.json({ image_url: resolveEventImageUrl(imageUrl, config.apiBaseUrl) });

    } else {
      throw createError('Provide "image" (base64), "image_url" (URL), or a multipart file upload', 400, 'VALIDATION_ERROR');
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /service/accounts/:id/cover-image — Upload account cover image
 * Accepts { "image": "<base64>" } or { "image_url": "https://..." }
 */
router.post('/accounts/:id/cover-image', imageBodyLimit, serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    const accountId = req.params.id;

    if (req.body?.image_url) {
      const { image_url } = req.body;
      if (typeof image_url !== 'string' || !image_url.startsWith('http')) {
        throw createError('image_url must be a valid HTTP URL', 400, 'VALIDATION_ERROR');
      }

      // Download, re-encode, upload — reuse event image pipeline with account-specific key
      const response = await fetch(image_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeighborhoodCommons/1.0)' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw createError('Failed to download image', 400, 'VALIDATION_ERROR');

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');
      const servingPath = `/api/portal/accounts/${accountId}/cover`;
      const imageUrl = await processAndUploadImage(`accounts/${accountId}/cover`, base64, servingPath);

      await supabaseAdmin.from('portal_accounts').update({ cover_image_url: imageUrl }).eq('id', accountId);
      res.json({ cover_image_url: imageUrl });

    } else if (req.body?.image) {
      const image = req.body.image as string;
      if (typeof image !== 'string' || image.length < 1) {
        throw createError('image must be a non-empty base64 string', 400, 'VALIDATION_ERROR');
      }

      const servingPath = `/api/portal/accounts/${accountId}/cover`;
      const imageUrl = await processAndUploadImage(`accounts/${accountId}/cover`, image, servingPath);
      await supabaseAdmin.from('portal_accounts').update({ cover_image_url: imageUrl }).eq('id', accountId);
      res.json({ cover_image_url: imageUrl });

    } else {
      throw createError('Provide "image" (base64) or "image_url" (URL)', 400, 'VALIDATION_ERROR');
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /service/accounts/:id/logo — Upload account logo
 * Same pipeline as cover-image: accepts { "image": "<base64>" } or { "image_url": "https://..." }
 */
router.post('/accounts/:id/logo', imageBodyLimit, serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    const accountId = req.params.id;

    if (req.body?.image_url) {
      const { image_url } = req.body;
      if (typeof image_url !== 'string' || !image_url.startsWith('http')) {
        throw createError('image_url must be a valid HTTP URL', 400, 'VALIDATION_ERROR');
      }

      const response = await fetch(image_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeighborhoodCommons/1.0)' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw createError('Failed to download image', 400, 'VALIDATION_ERROR');

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');
      const servingPath = `/api/portal/accounts/${accountId}/logo`;
      const imageUrl = await processAndUploadImage(`accounts/${accountId}/logo`, base64, servingPath);

      await supabaseAdmin.from('portal_accounts').update({ logo_url: imageUrl }).eq('id', accountId);
      res.json({ logo_url: imageUrl });

    } else if (req.body?.image) {
      const image = req.body.image as string;
      const servingPath = `/api/portal/accounts/${accountId}/logo`;
      const imageUrl = await processAndUploadImage(`accounts/${accountId}/logo`, image, servingPath);

      await supabaseAdmin.from('portal_accounts').update({ logo_url: imageUrl }).eq('id', accountId);
      res.json({ logo_url: imageUrl });

    } else {
      throw createError('Provide "image" (base64) or "image_url" (URL)', 400, 'VALIDATION_ERROR');
    }
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// STATS
// =============================================================================

/** GET /service/stats — Platform statistics + category distribution */
router.get('/stats', serviceLimiter, async (_req, res, next) => {
  try {
    // Run account and event counts in parallel
    const [accountCounts, oneOffCount, seriesCount, categoryRows] = await Promise.all([
      // Account counts: use head:true to avoid fetching rows
      supabaseAdmin.from('portal_accounts').select('id', { count: 'exact', head: true }),

      // One-off events
      supabaseAdmin.from('events')
        .select('id', { count: 'exact', head: true })
        .in('source', [...MANAGED_SOURCES])
        .is('series_id', null),

      // Series (first instance only)
      supabaseAdmin.from('events')
        .select('id', { count: 'exact', head: true })
        .in('source', [...MANAGED_SOURCES])
        .not('series_id', 'is', null)
        .eq('series_instance_number', 1),

      // Category distribution — only fetch unique events (one-offs + first instances)
      // Use minimal select to reduce payload
      supabaseAdmin.from('events')
        .select('category')
        .in('source', [...MANAGED_SOURCES])
        .or('series_id.is.null,series_instance_number.eq.1'),
    ]);

    // Account breakdowns need status/claimed_at — separate lightweight query
    const { data: accountStatuses } = await supabaseAdmin
      .from('portal_accounts')
      .select('status, claimed_at');

    const totalAccounts = accountCounts.count || 0;
    const claimedAccounts = accountStatuses?.filter((a) => a.claimed_at).length || 0;
    const pendingAccounts = accountStatuses?.filter((a) => a.status === 'pending').length || 0;

    const totalEvents = (oneOffCount.count || 0) + (seriesCount.count || 0);

    const category_distribution: Record<string, number> = {};
    if (categoryRows.data) {
      for (const row of categoryRows.data) {
        const cat = (row as Record<string, unknown>).category as string || 'uncategorized';
        category_distribution[cat] = (category_distribution[cat] || 0) + 1;
      }
    }

    res.json({
      stats: {
        total_accounts: totalAccounts,
        claimed_accounts: claimedAccounts,
        pending_accounts: pendingAccounts,
        total_events: totalEvents,
        category_distribution,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// API KEYS
// =============================================================================

/** GET /service/api-keys — List all API keys with event stats */
router.get('/api-keys', serviceLimiter, async (_req, res, next) => {
  try {
    const { data: keys, error } = await supabaseAdmin
      .from('api_keys')
      .select('id, key_prefix, name, contact_email, rate_limit_per_hour, status, contributor_tier, last_used_at, created_at')
      .order('created_at', { ascending: false });

    if (error) throw createError('Failed to list API keys', 500, 'SERVER_ERROR');

    // Fetch event counts and last submission per API key
    const keyIds = (keys || []).map((k) => k.id);
    let eventStats: Record<string, { event_count: number; last_submitted_at: string | null; pending_count: number }> = {};

    if (keyIds.length > 0) {
      // Fetch counts per key — use minimal select, the new compound index handles this efficiently
      const sourceFeedUrls = keyIds.map((id) => `api-key:${id}`);
      const { data: stats } = await supabaseAdmin
        .from('events')
        .select('source_feed_url, status, created_at')
        .in('source_feed_url', sourceFeedUrls)
        .eq('source_method', 'api')
        .order('created_at', { ascending: false });

      if (stats) {
        for (const row of stats) {
          const keyId = row.source_feed_url?.replace('api-key:', '');
          if (!keyId) continue;
          if (!eventStats[keyId]) eventStats[keyId] = { event_count: 0, last_submitted_at: null, pending_count: 0 };
          eventStats[keyId].event_count++;
          if (row.status === 'pending_review') eventStats[keyId].pending_count++;
          if (!eventStats[keyId].last_submitted_at) {
            eventStats[keyId].last_submitted_at = row.created_at;
          }
        }
      }
    }

    const enrichedKeys = (keys || []).map((k) => ({
      ...k,
      event_count: eventStats[k.id]?.event_count ?? 0,
      pending_count: eventStats[k.id]?.pending_count ?? 0,
      last_submitted_at: eventStats[k.id]?.last_submitted_at ?? null,
    }));

    res.json({ api_keys: enrichedKeys });
  } catch (err) {
    next(err);
  }
});

/** PATCH /service/api-keys/:id — Update API key tier, name, status, or contact email */
router.patch('/api-keys/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'API key ID');
    const schema = z.object({
      name: z.string().min(1).max(100).optional(),
      status: z.enum(['active', 'revoked']).optional(),
      contributor_tier: z.enum(['pending', 'verified', 'trusted']).optional(),
      contact_email: z.string().email().max(200).optional(),
    });
    const updates = validateRequest(schema, req.body);

    if (Object.keys(updates).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    const { data: apiKey, error } = await supabaseAdmin
      .from('api_keys')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, key_prefix, name, contact_email, rate_limit_per_hour, status, contributor_tier, last_used_at, created_at')
      .single();

    if (error) throw createError('Failed to update API key', 500, 'SERVER_ERROR');

    console.log(`[SERVICE] API key ${req.params.id} updated: ${Object.keys(updates).join(', ')}`);
    res.json({ api_key: apiKey });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GROUPS
// =============================================================================

const GROUP_SELECT = `
  id, name, slug, description, type,
  category_tags, neighborhood, city, address, latitude, longitude,
  avatar_url, hero_image_url, links, phone, website,
  operating_hours, status, claimed,
  source_publisher, source_method, portal_account_id,
  created_at, updated_at
`;

const createGroupSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().max(2000).optional(),
  type: z.enum(['business', 'community_group', 'nonprofit', 'collective', 'curator']).default('community_group'),
  category_tags: z.array(z.string().max(50)).max(20).optional(),
  neighborhood: z.string().max(200).optional(),
  city: z.string().max(200).default('Philadelphia'),
  address: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  avatar_url: z.string().url().max(2000).optional(),
  hero_image_url: z.string().url().max(2000).optional(),
  links: z.record(z.string()).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(2000).optional(),
  operating_hours: z.array(z.object({
    open: z.boolean(),
    ranges: z.array(z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    })),
  })).length(7).optional(),
  portal_account_id: z.string().uuid().optional(),
});

const updateGroupSchema = createGroupSchema.partial().omit({ slug: true });

const groupVenueSchema = z.object({
  place_id: z.string().max(500).optional(),
  venue_name: z.string().min(1).max(200),
  venue_address: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  is_primary: z.boolean().default(false),
});

/** GET /service/groups — List all groups */
router.get('/groups', serviceLimiter, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.search as string | undefined;

    let query = supabaseAdmin
      .from('groups')
      .select(`${GROUP_SELECT}, group_venues(id, place_id, venue_name, venue_address, latitude, longitude, is_primary)`, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`name.ilike.%${search}%,neighborhood.ilike.%${search}%`);
    }

    const typeFilter = req.query.type as string | undefined;
    if (typeFilter) {
      query = query.eq('type', typeFilter);
    }

    const { data: groups, count, error } = await query;
    if (error) throw createError('Failed to fetch groups', 500, 'SERVER_ERROR');

    res.json({ groups: groups || [], total: count || 0 });
  } catch (err) {
    next(err);
  }
});

/** GET /service/groups/:id — Single group with venues */
router.get('/groups/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'group ID');

    const { data: group, error } = await supabaseAdmin
      .from('groups')
      .select(`${GROUP_SELECT}, group_venues(id, place_id, venue_name, venue_address, latitude, longitude, is_primary)`)
      .eq('id', req.params.id)
      .maybeSingle();

    if (error || !group) throw createError('Group not found', 404, 'NOT_FOUND');

    res.json({ group });
  } catch (err) {
    next(err);
  }
});

/** POST /service/groups — Create a group */
router.post('/groups', serviceLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(createGroupSchema, req.body);

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
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        avatar_url: data.avatar_url || null,
        hero_image_url: data.hero_image_url || null,
        links: data.links || {},
        phone: data.phone || null,
        website: data.website || null,
        operating_hours: data.operating_hours ?? null,
        portal_account_id: data.portal_account_id || null,
        source_method: 'merrie',
        status: 'active',
      })
      .select(GROUP_SELECT)
      .single();

    if (error) {
      if (error.code === '23505') throw createError('Group with this slug already exists', 409, 'CONFLICT');
      console.error('[SERVICE] Create group error:', error.message);
      throw createError('Failed to create group', 500, 'SERVER_ERROR');
    }

    console.log(`[SERVICE] Group created: "${data.name}" (${group.id})`);
    res.status(201).json({ group });
  } catch (err) {
    next(err);
  }
});

/** PATCH /service/groups/:id — Update a group */
router.patch('/groups/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'group ID');
    const data = validateRequest(updateGroupSchema, req.body);

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) update[key] = value ?? null;
    }

    if (Object.keys(update).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    const { data: group, error } = await supabaseAdmin
      .from('groups')
      .update(update)
      .eq('id', req.params.id)
      .select(GROUP_SELECT)
      .single();

    if (error) throw createError('Failed to update group', 500, 'SERVER_ERROR');

    res.json({ group });
  } catch (err) {
    next(err);
  }
});

/** DELETE /service/groups/:id — Delete a group */
router.delete('/groups/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'group ID');

    // Unlink events from this group first
    await supabaseAdmin
      .from('events')
      .update({ group_id: null })
      .eq('group_id', req.params.id);

    const { error } = await supabaseAdmin
      .from('groups')
      .delete()
      .eq('id', req.params.id);

    if (error) throw createError('Failed to delete group', 500, 'SERVER_ERROR');

    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GROUP VENUES
// =============================================================================

/** POST /service/groups/:id/venues — Add a venue to a group */
router.post('/groups/:id/venues', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'group ID');
    const data = validateRequest(groupVenueSchema, req.body);

    const { data: venue, error } = await supabaseAdmin
      .from('group_venues')
      .insert({
        group_id: req.params.id,
        place_id: data.place_id || null,
        venue_name: data.venue_name,
        venue_address: data.venue_address || null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
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

/** DELETE /service/groups/:groupId/venues/:venueId — Remove a venue from a group */
router.delete('/groups/:groupId/venues/:venueId', serviceLimiter, async (req, res, next) => {
  try {
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

/** PATCH /service/events/:id/group — Link an event to a group */
router.patch('/events/:id/group', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const schema = z.object({
      group_id: z.string().uuid().nullable(),
    });
    const { group_id } = validateRequest(schema, req.body);

    // Verify group exists if linking
    if (group_id) {
      const { data: group } = await supabaseAdmin
        .from('groups')
        .select('id')
        .eq('id', group_id)
        .maybeSingle();
      if (!group) throw createError('Group not found', 404, 'NOT_FOUND');
    }

    const { error } = await supabaseAdmin
      .from('events')
      .update({ group_id })
      .eq('id', req.params.id);

    if (error) throw createError('Failed to update event group', 500, 'SERVER_ERROR');

    res.json({ updated: true, event_id: req.params.id, group_id });
  } catch (err) {
    next(err);
  }
});

export default router;
