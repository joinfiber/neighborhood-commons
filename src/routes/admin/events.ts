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
import { dispatchWebhooks } from "../../lib/webhook-delivery.js";
import { auditPortalAction } from "../../lib/audit.js";
import { toNeighborhoodEvent, type PortalEventRow } from "../../lib/event-transform.js";
import { sanitizeUrl, checkApprovedDomain } from "../../lib/url-sanitizer.js";
import { geocodeEventIfNeeded, geocodeSeriesEvents } from "../../lib/geocoding.js";
import { writeLimiter, portalLimiter } from "../../middleware/rate-limit.js";
import {
  PORTAL_SELECT, MANAGED_SOURCES, toPortalEvent, portalInputToInsert,
  toTimestamptz, fromTimestamptz, getAdminUserId,
  generateInstanceDates, formatDateStr,
} from "../../lib/event-operations.js";
import { createEventSeries, deleteSeriesEvents } from "../../lib/event-series.js";
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
  rsvp_limit: z.number().int().min(1).max(10000).nullable().default(null),
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
  rsvp_limit: z.number().int().min(1).max(10000).nullable().optional(),
  image_focal_y: z.number().min(0).max(1).optional(),
});

const imageUploadSchema = z.object({
  image: z.string().min(1).max(14_000_000),
});

/** Per-route body limit override for image uploads (12MB vs global 5MB) */
const imageBodyLimit = expressJson({ limit: '12mb' });


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
    void (async () => {
      try {
        const { data: row } = await supabaseAdmin
          .from('events')
          .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
          .eq('id', event.id)
          .maybeSingle();
        if (row) {
          void dispatchWebhooks('event.created', event.id, toNeighborhoodEvent(row as unknown as PortalEventRow));
        }
      } catch (err) {
        console.error('[COMMONS-ADMIN] Webhook dispatch error:', err instanceof Error ? err.message : err);
      }
    })();

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
    start_time_required: z.boolean().optional(),
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
    if (updates.start_time_required !== undefined) dbUpdate.start_time_required = updates.start_time_required;
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
    void (async () => {
      try {
        for (const row of updatedRows) {
          const { data: full } = await supabaseAdmin
            .from('events')
            .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
            .eq('id', row.id)
            .maybeSingle();
          if (full) {
            void dispatchWebhooks('event.updated', row.id, toNeighborhoodEvent(full as unknown as PortalEventRow));
          }
        }
      } catch (err) {
        console.error('[ADMIN] Batch webhook dispatch error:', err instanceof Error ? err.message : err);
      }
    })();

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

    // Fetch the series metadata
    const { data: series } = await supabaseAdmin
      .from('event_series')
      .select('id, recurrence, base_event_data, creator_account_id')
      .eq('id', req.params.seriesId)
      .maybeSingle();

    if (!series) throw createError('Series not found', 404, 'NOT_FOUND');

    const baseData = (series.base_event_data as Record<string, unknown>) || {};

    // Fetch all future instances
    const now = new Date().toISOString();
    const { data: futureEvents, error: fetchErr } = await supabaseAdmin
      .from('events')
      .select(PORTAL_SELECT)
      .eq('series_id', req.params.seriesId)
      .in('source', [...MANAGED_SOURCES])
      .gte('event_at', now)
      .order('event_at', { ascending: true });

    if (fetchErr) {
      console.error('[COMMONS-ADMIN] Series fetch error:', fetchErr.message);
      throw createError('Failed to fetch series events', 500, 'SERVER_ERROR');
    }

    if (!futureEvents || futureEvents.length === 0) {
      throw createError('No upcoming events in this series', 404, 'NOT_FOUND');
    }

    const refEvent = futureEvents[0]!;
    const tz = data.event_timezone || (refEvent.event_timezone as string) || 'America/New_York';

    // Build template update
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
        ? `POINT(${lng} ${lat})`
        : null;
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

    const hasTimeChange = data.start_time !== undefined || data.end_time !== undefined;
    const hasInstanceCountChange = data.instance_count !== undefined;

    if (Object.keys(templateUpdate).length === 0 && !hasTimeChange && !hasInstanceCountChange) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    // Update each future instance
    let updatedCount = 0;
    for (const ev of futureEvents) {
      const instanceUpdate: Record<string, unknown> = { ...templateUpdate };

      // Apply time changes per-instance (preserving each instance's date)
      if (hasTimeChange) {
        const instanceTz = (ev as Record<string, unknown>).event_timezone as string || tz;
        const parsed = ev.event_at ? fromTimestamptz(ev.event_at as string, instanceTz) : null;
        const instanceDate = parsed?.date;

        if (instanceDate) {
          if (data.start_time !== undefined) {
            const newTime = data.start_time || parsed?.time;
            if (newTime) {
              instanceUpdate.event_at = toTimestamptz(instanceDate, newTime, instanceTz);
            }
          }
          if (data.end_time !== undefined) {
            if (data.end_time) {
              const eventAtRef = (instanceUpdate.event_at as string | undefined) || (ev.event_at as string);
              let endTimeTs = toTimestamptz(instanceDate, data.end_time, instanceTz);
              if (eventAtRef && new Date(endTimeTs) <= new Date(eventAtRef)) {
                const nextDay = new Date(instanceDate);
                nextDay.setDate(nextDay.getDate() + 1);
                endTimeTs = toTimestamptz(nextDay.toISOString().split('T')[0]!, data.end_time, instanceTz);
              }
              instanceUpdate.end_time = endTimeTs;
            } else {
              instanceUpdate.end_time = null;
            }
          }
        }
      }

      if (Object.keys(instanceUpdate).length === 0) continue;

      const { error: updateErr } = await supabaseAdmin
        .from('events')
        .update(instanceUpdate)
        .eq('id', (ev as Record<string, unknown>).id as string);

      if (updateErr) {
        console.error(`[COMMONS-ADMIN] Series instance update error (${(ev as Record<string, unknown>).id}):`, updateErr.message);
      } else {
        updatedCount++;
      }
    }

    // Update base_event_data on the series row
    const newBase = { ...baseData };
    const columnToBaseKey: Record<string, string> = {
      content: 'content', place_name: 'place_name', venue_address: 'venue_address',
      place_id: 'place_id', latitude: 'latitude', longitude: 'longitude',
      category: 'category', custom_category: 'custom_category',
      description: 'description', price: 'price', link_url: 'link_url',
      event_image_focal_y: 'event_image_focal_y',
    };
    for (const [col, baseKey] of Object.entries(columnToBaseKey)) {
      if (col in templateUpdate) {
        newBase[baseKey] = templateUpdate[col];
      }
    }
    await supabaseAdmin
      .from('event_series')
      .update({ base_event_data: newBase })
      .eq('id', req.params.seriesId);

    // Handle instance_count changes
    let instancesAdded = 0;
    let instancesRemoved = 0;
    if (hasInstanceCountChange) {
      const seriesRecurrence = series.recurrence as string;
      if (seriesRecurrence && seriesRecurrence !== 'none') {
        const desiredCount = generateInstanceDates('2025-01-01', seriesRecurrence, data.instance_count).length;

        const { data: allFuture } = await supabaseAdmin
          .from('events')
          .select('id, event_at, event_timezone, end_time, series_instance_number')
          .eq('series_id', req.params.seriesId)
          .in('source', [...MANAGED_SOURCES])
          .gte('event_at', now)
          .order('event_at', { ascending: true });

        const currentFutureCount = allFuture?.length || 0;

        if (desiredCount > currentFutureCount && allFuture && allFuture.length > 0) {
          const lastFuture = allFuture[allFuture.length - 1]!;
          const lastTz = (lastFuture.event_timezone as string) || tz;
          const lastParsed = fromTimestamptz(lastFuture.event_at as string, lastTz);
          const lastNum = (lastFuture.series_instance_number as number) || allFuture.length;

          const startTime = lastParsed.time;
          let endTime: string | null = null;
          if (lastFuture.end_time) {
            endTime = fromTimestamptz(lastFuture.end_time as string, lastTz).time;
          }

          const lastDate = new Date(lastParsed.date + 'T12:00:00');
          lastDate.setDate(lastDate.getDate() + 1);
          const newStartDate = formatDateStr(lastDate);

          const needed = desiredCount - currentFutureCount;
          const newDates = generateInstanceDates(newStartDate, seriesRecurrence, needed);

          if (newDates.length > 0) {
            const { data: templateEvent } = await supabaseAdmin
              .from('events')
              .select('creator_account_id, source, visibility, status, is_business, region_id, event_timezone, event_image_url, event_image_focal_y')
              .eq('series_id', req.params.seriesId)
              .limit(1)
              .single();

            if (templateEvent) {
              const adminUserId = getAdminUserId();
              const rows = newDates.map((date, i) => {
                const eventAt = toTimestamptz(date, startTime, lastTz);
                let endTimeTs: string | null = null;
                if (endTime) {
                  endTimeTs = toTimestamptz(date, endTime, lastTz);
                  if (new Date(endTimeTs) <= new Date(eventAt)) {
                    const nextDay = new Date(date);
                    nextDay.setDate(nextDay.getDate() + 1);
                    endTimeTs = toTimestamptz(nextDay.toISOString().split('T')[0]!, endTime, lastTz);
                  }
                }
                return {
                  ...newBase,
                  creator_account_id: series.creator_account_id,
                  user_id: adminUserId,
                  source: templateEvent.source,
                  visibility: templateEvent.visibility,
                  status: templateEvent.status,
                  is_business: templateEvent.is_business,
                  region_id: templateEvent.region_id,
                  event_timezone: lastTz,
                  event_image_url: templateEvent.event_image_url,
                  event_image_focal_y: templateEvent.event_image_focal_y,
                  event_at: eventAt,
                  end_time: endTimeTs,
                  recurrence: seriesRecurrence,
                  series_id: series.id,
                  series_instance_number: lastNum + i + 1,
                };
              });

              const { data: created, error: insertErr } = await supabaseAdmin
                .from('events')
                .insert(rows)
                .select('id');

              if (insertErr) {
                console.error('[COMMONS-ADMIN] Series instance expansion error:', insertErr.message);
              } else {
                instancesAdded = created?.length || 0;
              }
            }
          }
        } else if (desiredCount < currentFutureCount && allFuture) {
          const toRemove = allFuture.slice(desiredCount);
          const removeIds = toRemove.map((e) => (e as Record<string, unknown>).id as string);
          if (removeIds.length > 0) {
            const { error: delErr } = await supabaseAdmin
              .from('events')
              .delete()
              .in('id', removeIds);

            if (delErr) {
              console.error('[COMMONS-ADMIN] Series instance removal error:', delErr.message);
            } else {
              instancesRemoved = removeIds.length;
            }
          }
        }

        const finalCount = (allFuture?.length || 0) + instancesAdded - instancesRemoved;
        const updatedRule = { frequency: seriesRecurrence, count: finalCount };
        await supabaseAdmin
          .from('event_series')
          .update({ recurrence_rule: updatedRule })
          .eq('id', series.id);
      }
    }

    const totalAfter = futureEvents.length + instancesAdded - instancesRemoved;
    console.log(`[COMMONS-ADMIN] Series ${req.params.seriesId} updated: ${updatedCount}/${futureEvents.length} instances` +
      (instancesAdded ? `, +${instancesAdded} added` : '') +
      (instancesRemoved ? `, -${instancesRemoved} removed` : ''));

    // Dispatch webhooks (fire-and-forget)
    void (async () => {
      try {
        for (const ev of futureEvents) {
          const { data: row } = await supabaseAdmin
            .from('events')
            .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
            .eq('id', (ev as Record<string, unknown>).id as string)
            .maybeSingle();
          if (row && (row as Record<string, unknown>).status === 'published') {
            void dispatchWebhooks('event.updated', (ev as Record<string, unknown>).id as string,
              toNeighborhoodEvent(row as unknown as PortalEventRow));
          }
        }
      } catch (err) {
        console.error('[COMMONS-ADMIN] Series webhook dispatch error:', err instanceof Error ? err.message : err);
      }
    })();

    res.json({ updated: updatedCount, total: totalAfter, added: instancesAdded, removed: instancesRemoved });
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
    void (async () => {
      try {
        const { data: row } = await supabaseAdmin
          .from('events')
          .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
          .eq('id', event.id)
          .maybeSingle();
        if (row) {
          void dispatchWebhooks('event.updated', event.id, toNeighborhoodEvent(row as unknown as PortalEventRow));
        }
      } catch (err) {
        console.error('[COMMONS-ADMIN] Webhook dispatch error:', err instanceof Error ? err.message : err);
      }
    })();

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
      url: null, images: [], organizer: { name: '', phone: null },
      cost: null, series_id: null, series_instance_number: null, series_instance_count: null, start_time_required: true, tags: [], wheelchair_accessible: null,
      runtime_minutes: null, content_rating: null, showtimes: null, recurrence: null,
      source: { publisher: 'neighborhood-commons', collected_at: new Date().toISOString(), method: 'portal', license: 'CC BY 4.0' },
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
