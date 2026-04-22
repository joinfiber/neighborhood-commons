/**
 * Admin Event Routes
 *
 * Event CRUD, series operations, batch updates, image upload.
 */

import { Router, json as expressJson } from "express";
import { z } from "zod";
import { EVENT_CATEGORY_KEYS } from "../../lib/categories.js";
import { validateTags } from "../../lib/tags.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { createError } from "../../middleware/error-handler.js";
import { validateRequest, validateUuidParam } from "../../lib/helpers.js";
import { dispatchEventWebhookById, dispatchWebhooks } from "../../lib/webhook-delivery.js";
import { auditPortalAction } from "../../lib/audit.js";
import { sanitizeUrl, checkApprovedDomain } from "../../lib/url-sanitizer.js";
import { geocodeEventIfNeeded, geocodeSeriesEvents } from "../../lib/geocoding.js";
import { writeLimiter, portalLimiter } from "../../middleware/rate-limit.js";
import {
  PORTAL_SELECT, MANAGED_SOURCES, toPortalEvent, portalInputToInsert,
  toTimestamptz, fromTimestamptz, getAdminUserId,
} from "../../lib/event-operations.js";
import { createEventSeries, deleteSeriesEvents, updateSeriesFutureInstances } from "../../lib/event-series.js";
import { processAndUploadImage } from "../../lib/image-processing.js";

const router: ReturnType<typeof Router> = Router();

const createEventSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  venue_name: z.string().min(1, 'Venue is required').max(200),
  address: z.string().max(500).optional(),
  place_id: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, 'Start time must be HH:MM'),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, 'End time must be HH:MM').optional(),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]),
  custom_category: z.string().max(30).optional(),
  recurrence: z.string()
    .regex(
      /^(none|daily|weekly|biweekly|monthly|ordinal_weekday:[1-5]:(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|weekly_days:(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*)$/,
      'Invalid recurrence pattern',
    )
    .default('none'),
  instance_count: z.number().int().min(0).max(52).optional(),
  event_timezone: z.string().max(50).default('America/New_York'),
  description: z.string().max(2000).optional(),
  price: z.string().max(100).optional(),
  ticket_url: z.preprocess(
    (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    z.string().url().max(2000).optional().or(z.literal('')),
  ),
  open_window: z.boolean().default(false),
  capacity: z.number().int().min(1).max(10000).nullable().default(null),
  rsvp: z.enum(['recommended', 'required']).nullable().default(null),
  image_focal_y: z.number().min(0).max(1).optional(),
});

// Manual partial: strip .default() values so PATCH only updates fields the client actually sends
const updateEventSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  venue_name: z.string().min(1).max(200).optional(),
  address: z.string().max(500).optional(),
  place_id: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, 'Start time must be HH:MM').optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, 'End time must be HH:MM').optional().nullable(),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
  custom_category: z.string().max(30).optional().nullable(),
  recurrence: z.string()
    .regex(
      /^(none|daily|weekly|biweekly|monthly|ordinal_weekday:[1-5]:(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|weekly_days:(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*)$/,
      'Invalid recurrence pattern',
    )
    .optional(),
  instance_count: z.number().int().min(0).max(52).optional(),
  event_timezone: z.string().max(50).optional(),
  description: z.string().max(2000).optional().nullable(),
  price: z.string().max(100).optional().nullable(),
  ticket_url: z.preprocess(
    (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    z.string().url().max(2000).optional().or(z.literal('')).nullable(),
  ),
  open_window: z.boolean().optional(),
  capacity: z.number().int().min(1).max(10000).nullable().optional(),
  rsvp: z.enum(['recommended', 'required']).nullable().optional(),
  image_focal_y: z.number().min(0).max(1).optional(),
});

const imageUploadSchema = z.object({
  image: z.string().min(1).max(14_000_000),
});

/** Per-route body limit override for image uploads (12MB vs global 5MB) */
const imageBodyLimit = expressJson({ limit: '12mb' });


// =============================================================================
// EVENT CRUD
// =============================================================================

router.post('/accounts/:id/events', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    const data = validateRequest(createEventSchema, req.body);
    const adminUserId = getAdminUserId();

    const { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, business_name')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!account) {
      throw createError('Account not found', 404, 'NOT_FOUND');
    }

    if (data.category === 'other') {
      if (!data.custom_category || data.custom_category.trim().length === 0) {
        throw createError('Custom category is required when category is "other"', 400, 'VALIDATION_ERROR');
      }
      const wordCount = data.custom_category.trim().split(/\s+/).length;
      if (wordCount > 3) {
        throw createError('Custom category must be 1-3 words', 400, 'VALIDATION_ERROR');
      }
    }

    const insertData = portalInputToInsert(data, account.id, adminUserId);

    // Recurring events
    if (data.recurrence !== 'none') {
      const instances = await createEventSeries(
        insertData,
        data.recurrence,
        data.event_date,
        data.start_time,
        data.end_time,
        data.event_timezone || 'America/New_York',
        data.instance_count,
      );

      if (instances.length === 0) {
        throw createError('Failed to create event series', 500, 'SERVER_ERROR');
      }

      console.log(`[COMMONS-ADMIN] Series created for ${account.business_name}: "${data.title}" (${instances.length} instances)`);
      const { data: event } = await supabaseAdmin
        .from('events')
        .select(PORTAL_SELECT)
        .eq('id', instances[0]!.id)
        .single();

      // Fire-and-forget geocode — one lookup, update all instances
      void geocodeSeriesEvents(instances.map((i) => i.id), insertData.venue_address as string | null, insertData.latitude as number | null, insertData.longitude as number | null, account.id);

      res.status(201).json({ event: event ? toPortalEvent(event) : null, series_count: instances.length });
      return;
    }

    // Single event
    const { data: event, error } = await supabaseAdmin
      .from('events')
      .insert(insertData)
      .select(PORTAL_SELECT)
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Event create error:', error.message);
      throw createError('Failed to create event', 500, 'SERVER_ERROR');
    }

    console.log(`[COMMONS-ADMIN] Event created for ${account.business_name}: "${data.title}" (${event.id})`);

    // Fire-and-forget geocode if address present but no coordinates
    void geocodeEventIfNeeded(event.id, insertData.venue_address as string | null, insertData.latitude as number | null, insertData.longitude as number | null, account.id);

    // Dispatch webhook (fire-and-forget) — admin-created events are always published
    dispatchEventWebhookById('event.created', event.id);

    res.status(201).json({ event: toPortalEvent(event) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/events
 * All events across all accounts (with business info).
 */
router.get('/events', portalLimiter, async (_req, res, next) => {
  try {
    // Fetch all managed events sorted chronologically. The frontend groups
    // series instances into single cards and needs the full set to compute
    // "X upcoming / Y total" counts per series.
    const { data: events, error } = await supabaseAdmin
      .from('events')
      .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name, email)`)
      .in('source', [...MANAGED_SOURCES])
      .order('event_at', { ascending: true })
      .limit(5000);

    if (error) {
      console.error('[COMMONS-ADMIN] Events fetch error:', error.message);
      throw createError('Failed to fetch events', 500, 'SERVER_ERROR');
    }

    // Convert to portal format, preserving the portal_accounts join
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

/**
 * PATCH /admin/events/batch
 * Bulk-update multiple events (admin override, no RLS).
 * Same field set as portal batch — safe bulk fields only.
 *
 * NOTE: Must be defined before /events/:id to avoid route conflict.
 */
const adminBatchUpdateSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(50),
  updates: z.object({
    category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
    custom_category: z.string().max(30).optional().nullable(),
    tags: z.array(z.string().max(50)).max(15).optional(),
    wheelchair_accessible: z.boolean().nullable().optional(),
    open_window: z.boolean().optional(),
    capacity: z.number().int().min(1).max(10000).nullable().optional(),
    rsvp: z.enum(['recommended', 'required']).nullable().optional(),
    description: z.string().max(2000).optional().nullable(),
    price: z.string().max(100).optional().nullable(),
  }).refine((u) => Object.keys(u).length > 0, { message: 'No fields to update' }),
});

router.patch('/events/batch', writeLimiter, async (req, res, next) => {
  try {
    const adminUserId = getAdminUserId();
    const { ids, updates } = validateRequest(adminBatchUpdateSchema, req.body);

    if (updates.category === 'other') {
      if (!updates.custom_category || updates.custom_category.trim().length === 0) {
        throw createError('Custom category is required when category is "other"', 400, 'VALIDATION_ERROR');
      }
    }

    const dbUpdate: Record<string, unknown> = {};
    if (updates.category !== undefined) {
      dbUpdate.category = updates.category;
      if (updates.category !== 'other') dbUpdate.custom_category = null;
    }
    if (updates.custom_category !== undefined && updates.category === 'other') {
      dbUpdate.custom_category = updates.custom_category?.trim() || null;
    }
    if (updates.tags !== undefined) {
      const category = updates.category;
      dbUpdate.tags = category ? validateTags(updates.tags, category) : updates.tags;
    }
    if (updates.wheelchair_accessible !== undefined) dbUpdate.wheelchair_accessible = updates.wheelchair_accessible;
    if (updates.open_window !== undefined) dbUpdate.open_window = updates.open_window;
    if (updates.capacity !== undefined) dbUpdate.capacity = updates.capacity;
    if (updates.rsvp !== undefined) dbUpdate.rsvp = updates.rsvp;
    if (updates.description !== undefined) dbUpdate.description = updates.description || null;
    if (updates.price !== undefined) dbUpdate.price = updates.price || null;

    const { data: updated, error } = await supabaseAdmin
      .from('events')
      .update(dbUpdate)
      .in('id', ids)
      .in('source', [...MANAGED_SOURCES])
      .select('id, creator_account_id');

    if (error) {
      console.error('[ADMIN] Batch update error:', error.message);
      throw createError('Failed to update events', 500, 'SERVER_ERROR');
    }

    const updatedRows = (updated || []) as { id: string; creator_account_id: string }[];

    for (const row of updatedRows) {
      auditPortalAction('portal_event_updated', adminUserId, row.id,
        undefined, '/api/portal/admin/events/batch');
    }

    // Dispatch webhooks (fire-and-forget)
    for (const row of updatedRows) {
      dispatchEventWebhookById('event.updated', row.id);
    }

    res.json({ updated: updatedRows.length, ids: updatedRows.map((r) => r.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /admin/events/series/:seriesId
 * Update all future instances of a series (admin override, no RLS).
 * Handles field updates + instance count changes (add/remove instances).
 * NOTE: Must be defined before /events/:id to avoid route conflict.
 */
router.patch('/events/series/:seriesId', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.seriesId, 'series ID');
    const data = validateRequest(updateEventSchema, req.body);

    // Build template update from admin input
    const tz = data.event_timezone || 'America/New_York';
    const templateUpdate: Record<string, unknown> = {};
    if (data.title !== undefined) templateUpdate.content = data.title;
    if (data.venue_name !== undefined) templateUpdate.place_name = data.venue_name;
    if (data.address !== undefined) templateUpdate.venue_address = data.address || null;
    if (data.place_id !== undefined) templateUpdate.place_id = data.place_id || null;
    if (data.latitude !== undefined) templateUpdate.latitude = data.latitude ?? null;
    if (data.longitude !== undefined) templateUpdate.longitude = data.longitude ?? null;
    if (data.latitude !== undefined || data.longitude !== undefined) {
      const lat = data.latitude ?? null;
      const lng = data.longitude ?? null;
      templateUpdate.approximate_location = lat != null && lng != null
        ? `POINT(${lng} ${lat})` : null;
    }
    if (data.event_timezone !== undefined) templateUpdate.event_timezone = data.event_timezone;
    if (data.category !== undefined) {
      templateUpdate.category = data.category;
      if (data.category !== 'other') templateUpdate.custom_category = null;
    }
    if (data.custom_category !== undefined && data.category === 'other') {
      templateUpdate.custom_category = data.custom_category?.trim() || null;
    }
    if (data.description !== undefined) templateUpdate.description = data.description || null;
    if (data.price !== undefined) templateUpdate.price = data.price || null;
    if (data.ticket_url !== undefined) {
      templateUpdate.link_url = data.ticket_url ? (checkApprovedDomain(data.ticket_url), sanitizeUrl(data.ticket_url)) : null;
    }
    if (data.recurrence !== undefined) templateUpdate.recurrence = data.recurrence;
    if (data.image_focal_y !== undefined) templateUpdate.event_image_focal_y = data.image_focal_y;
    if (data.open_window !== undefined) templateUpdate.open_window = data.open_window;
    if (data.capacity !== undefined) templateUpdate.capacity = data.capacity;
    if (data.rsvp !== undefined) templateUpdate.rsvp = data.rsvp;

    const hasTimeChange = data.start_time !== undefined || data.end_time !== undefined;
    const hasInstanceCountChange = data.instance_count !== undefined;

    if (Object.keys(templateUpdate).length === 0 && !hasTimeChange && !hasInstanceCountChange) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    // Delegate to shared series update logic
    const result = await updateSeriesFutureInstances({
      seriesId: req.params.seriesId,
      updates: templateUpdate,
      timeChange: hasTimeChange ? { startTime: data.start_time, endTime: data.end_time } : undefined,
      instanceCountChange: hasInstanceCountChange ? data.instance_count : undefined,
      timezone: tz,
    });

    console.log(`[COMMONS-ADMIN] Series ${req.params.seriesId} updated: ${result.updatedCount} instances` +
      (result.instancesAdded ? `, +${result.instancesAdded} added` : '') +
      (result.instancesRemoved ? `, -${result.instancesRemoved} removed` : ''));

    // Dispatch webhooks (fire-and-forget) — only for published instances
    for (const id of result.updatedIds) {
      dispatchEventWebhookById('event.updated', id, { onlyPublished: true });
    }

    res.json({ updated: result.updatedCount, total: result.totalAfter, added: result.instancesAdded, removed: result.instancesRemoved });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/events/:id
 * Single event with account info. Allows the edit screen to load
 * an event directly without knowing the account ID first.
 */
router.get('/events/:id', portalLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');

    const { data: event, error } = await supabaseAdmin
      .from('events')
      .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(id, email, business_name, default_venue_name, default_place_id, default_address, default_latitude, default_longitude, website, phone, wheelchair_accessible, status)`)
      .eq('id', req.params.id)
      .maybeSingle();

    if (error || !event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    res.json({
      event: toPortalEvent(event),
      account: event.portal_accounts || null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /admin/events/:id
 * Edit any event (admin override, no RLS).
 */
router.patch('/events/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const data = validateRequest(updateEventSchema, req.body);

    if (data.category === 'other') {
      if (!data.custom_category || data.custom_category.trim().length === 0) {
        throw createError('Custom category is required when category is "other"', 400, 'VALIDATION_ERROR');
      }
    }

    // Fetch existing event to get timezone
    const { data: existing } = await supabaseAdmin
      .from('events')
      .select('event_timezone, event_at')
      .eq('id', req.params.id)
      .in('source', [...MANAGED_SOURCES])
      .maybeSingle();

    if (!existing) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const tz = data.event_timezone || (existing.event_timezone as string) || 'America/New_York';

    const update: Record<string, unknown> = {};
    if (data.title !== undefined) update.content = data.title;
    if (data.venue_name !== undefined) update.place_name = data.venue_name;
    if (data.address !== undefined) update.venue_address = data.address || null;
    if (data.place_id !== undefined) update.place_id = data.place_id || null;
    if (data.latitude !== undefined) update.latitude = data.latitude ?? null;
    if (data.longitude !== undefined) update.longitude = data.longitude ?? null;
    if (data.latitude !== undefined || data.longitude !== undefined) {
      const lat = data.latitude ?? null;
      const lng = data.longitude ?? null;
      update.approximate_location = lat != null && lng != null
        ? `POINT(${lng} ${lat})`
        : null;
    }
    if (data.event_date !== undefined || data.start_time !== undefined) {
      const existingParsed = existing.event_at ? fromTimestamptz(existing.event_at as string, tz) : null;
      const date = data.event_date || existingParsed?.date;
      const time = data.start_time || existingParsed?.time;
      if (date && time) {
        update.event_at = toTimestamptz(date, time, tz);
      }
    }
    if (data.end_time !== undefined) {
      if (data.end_time) {
        const existingParsed = existing.event_at ? fromTimestamptz(existing.event_at as string, tz) : null;
        const date = data.event_date || existingParsed?.date;
        if (date) {
          let endTimeTs = toTimestamptz(date, data.end_time, tz);
          // If end_time is before start_time, event spans midnight — use next day
          const eventAtRef = (update.event_at as string | undefined) || (existing.event_at as string);
          if (eventAtRef && new Date(endTimeTs) <= new Date(eventAtRef)) {
            const nextDay = new Date(date);
            nextDay.setDate(nextDay.getDate() + 1);
            const nextDateStr = nextDay.toISOString().split('T')[0]!;
            endTimeTs = toTimestamptz(nextDateStr, data.end_time, tz);
          }
          update.end_time = endTimeTs;
        }
      } else {
        update.end_time = null;
      }
    }
    if (data.event_timezone !== undefined) update.event_timezone = data.event_timezone;
    if (data.category !== undefined) {
      update.category = data.category;
      if (data.category !== 'other') update.custom_category = null;
    }
    if (data.custom_category !== undefined && data.category !== undefined && data.category === 'other') {
      update.custom_category = data.custom_category?.trim() || null;
    }
    if (data.recurrence !== undefined) update.recurrence = data.recurrence;
    if (data.description !== undefined) update.description = data.description || null;
    if (data.price !== undefined) update.price = data.price || null;
    if (data.ticket_url !== undefined) {
      update.link_url = data.ticket_url ? (checkApprovedDomain(data.ticket_url), sanitizeUrl(data.ticket_url)) : null;
    }
    if (data.image_focal_y !== undefined) update.event_image_focal_y = data.image_focal_y;
    if (data.open_window !== undefined) update.open_window = data.open_window;
    if (data.capacity !== undefined) update.capacity = data.capacity;
    if (data.rsvp !== undefined) update.rsvp = data.rsvp;

    if (Object.keys(update).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const { data: event, error } = await supabaseAdmin
      .from('events')
      .update(update)
      .eq('id', req.params.id)
      .in('source', [...MANAGED_SOURCES])
      .select(PORTAL_SELECT)
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Event update error:', error.message);
      throw createError('Failed to update event', 500, 'SERVER_ERROR');
    }

    // Fire-and-forget geocode if address changed and no coordinates
    if (data.address !== undefined) {
      void geocodeEventIfNeeded(event.id, event.venue_address as string | null, event.latitude as number | null, event.longitude as number | null, event.creator_account_id as string | null);
    }

    // Dispatch webhook (fire-and-forget)
    dispatchEventWebhookById('event.updated', event.id);

    res.json({ event: toPortalEvent(event) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /admin/events/series/:seriesId
 * Delete all events in a series.
 * NOTE: Must be defined before /events/:id to avoid route conflict.
 */
router.delete('/events/series/:seriesId', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.seriesId, 'series ID');
    const deleted = await deleteSeriesEvents(req.params.seriesId);
    if (deleted === 0) {
      throw createError('Series not found', 404, 'NOT_FOUND');
    }
    res.json({ success: true, deleted });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /admin/events/:id
 * Delete any event.
 */
router.delete('/events/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');

    const { error } = await supabaseAdmin
      .from('events')
      .delete()
      .eq('id', req.params.id)
      .in('source', [...MANAGED_SOURCES]);

    if (error) {
      console.error('[COMMONS-ADMIN] Event delete error:', error.message);
      throw createError('Failed to delete event', 500, 'SERVER_ERROR');
    }

    void dispatchWebhooks('event.deleted', req.params.id, {
      id: req.params.id, name: '', start: '', end: null, timezone: 'UTC', description: null,
      category: [], place_id: null,
      location: { name: '', address: null, lat: null, lng: null },
      url: null, images: [], event_image_focal_y: 0.5, organizer: { name: '', phone: null },
      cost: null, series_id: null, series_instance_number: null, series_instance_count: null, open_window: false, capacity: null, rsvp: null, tags: [], wheelchair_accessible: null,
      first_party: false, tmdb_id: null, recurrence: null,
      source: { publisher: 'neighborhood-commons', collected_at: new Date().toISOString(), method: 'portal', contributor: null, license: 'CC BY 4.0' },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// IMAGE UPLOAD (admin can upload for any portal event)
// =============================================================================

/**
 * POST /admin/events/:id/image
 * Admin uploads an event image (bypasses portal account ownership check).
 */
router.post('/events/:id/image', imageBodyLimit, writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const { image } = validateRequest(imageUploadSchema, req.body);

    // Verify event exists (admin — use supabaseAdmin, no RLS)
    const { data: event } = await supabaseAdmin
      .from('events')
      .select('id')
      .eq('id', req.params.id)
      .in('source', [...MANAGED_SOURCES])
      .maybeSingle();

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const imageUrl = await processAndUploadImage(req.params.id, image);

    const { error: updateError } = await supabaseAdmin
      .from('events')
      .update({ event_image_url: imageUrl })
      .eq('id', req.params.id)
      .in('source', [...MANAGED_SOURCES]);

    if (updateError) {
      console.error('[COMMONS-ADMIN] Image URL update error:', updateError.message);
      throw createError('Failed to save image reference', 500, 'SERVER_ERROR');
    }

    res.json({ image_url: imageUrl });
  } catch (err) {
    next(err);
  }
});


export default router;
