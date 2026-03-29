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

import { Router } from 'express';
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
import { processAndUploadImage } from '../lib/image-processing.js';
import { config } from '../config.js';

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
});

/** GET /service/accounts — List all accounts with event counts */
router.get('/accounts', serviceLimiter, async (_req, res, next) => {
  try {
    const { data: accounts, error } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, email, business_name, auth_user_id, status, default_venue_name, default_place_id, default_address, default_latitude, default_longitude, website, phone, operating_hours, last_login_at, created_at, updated_at')
      .order('created_at', { ascending: false });

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

    res.json({ accounts: result });
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

    const { data: events } = await supabaseAdmin
      .from('events')
      .select(PORTAL_SELECT)
      .eq('creator_account_id', account.id)
      .in('source', [...MANAGED_SOURCES])
      .order('event_at', { ascending: true });

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
  instance_count: z.number().int().min(0).max(52).optional(),
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
});

/** GET /service/events — All events (unique: one-offs + first instance of series) */
router.get('/events', serviceLimiter, async (_req, res, next) => {
  try {
    const { data: events, error } = await supabaseAdmin
      .from('events')
      .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name, email)`)
      .in('source', [...MANAGED_SOURCES])
      .order('event_at', { ascending: true })
      .limit(5000);

    if (error) throw createError('Failed to fetch events', 500, 'SERVER_ERROR');

    const result = (events || []).map((e) => {
      const pe = toPortalEvent(e);
      pe.portal_accounts = e.portal_accounts;
      return pe;
    });

    res.json({ events: result });
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
    }, adminUserId, data.account_id, config.defaultRegionId || undefined);

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
      .select('id, event_timezone, creator_account_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!existing) throw createError('Event not found', 404, 'NOT_FOUND');

    const tz = data.event_timezone || existing.event_timezone || 'America/New_York';
    const dbUpdate: Record<string, unknown> = {};

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

/** POST /service/events/:id/image — Upload event image */
router.post('/events/:id/image', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');

    const schema = z.object({ image: z.string().min(1).max(14_000_000) });
    const { image } = validateRequest(schema, req.body);

    const imageUrl = await processAndUploadImage(image, req.params.id);

    await supabaseAdmin
      .from('events')
      .update({ event_image_url: imageUrl })
      .eq('id', req.params.id);

    res.json({ image_url: resolveEventImageUrl(imageUrl, config.apiBaseUrl) });
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
    const { data: accounts } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, claimed_at, status');

    const totalAccounts = accounts?.length || 0;
    const claimedAccounts = accounts?.filter((a) => a.claimed_at).length || 0;
    const pendingAccounts = accounts?.filter((a) => a.status === 'pending').length || 0;

    // Unique event counts
    const { count: totalOneOffs } = await supabaseAdmin
      .from('events')
      .select('id', { count: 'exact', head: true })
      .in('source', [...MANAGED_SOURCES])
      .is('series_id', null);

    const { count: totalSeries } = await supabaseAdmin
      .from('events')
      .select('id', { count: 'exact', head: true })
      .in('source', [...MANAGED_SOURCES])
      .not('series_id', 'is', null)
      .eq('series_instance_number', 1);

    const totalEvents = (totalOneOffs || 0) + (totalSeries || 0);

    // Category distribution
    const { data: categoryRows } = await supabaseAdmin
      .from('events')
      .select('category, series_id, series_instance_number')
      .in('source', [...MANAGED_SOURCES]);

    const category_distribution: Record<string, number> = {};
    if (categoryRows) {
      for (const row of categoryRows) {
        if (row.series_id && row.series_instance_number !== 1) continue;
        const cat = row.category || 'uncategorized';
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

export default router;
