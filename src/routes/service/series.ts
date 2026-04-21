/**
 * Service API — Series operations
 *
 * Bulk operations across a recurring event series: PATCH applies a template
 * edit to every future instance (and to base_event_data so the auto-extend
 * cron inherits it); DELETE removes every instance in the series.
 *
 * Shares updateEventSchema with service/events.ts. Sits in its own file
 * because the handlers have substantive logic around series templates and
 * past-vs-future instance semantics.
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest, validateUuidParam } from '../../lib/helpers.js';
import { validateTags } from '../../lib/tags.js';
import { dispatchEventWebhookById } from '../../lib/webhook-delivery.js';
import { serviceLimiter } from '../../middleware/rate-limit.js';
import { fromTimestamptz } from '../../lib/event-operations.js';
import { deleteSeriesEvents, updateSeriesFutureInstances } from '../../lib/event-series.js';
import { assertLinkedAccount, assertLinkedEvent } from './helpers.js';
import { updateEventSchema } from './events.js';

const router: ReturnType<typeof Router> = Router();

/**
 * PATCH /service/events/series/:seriesId — Update all future instances of a series (scoped).
 *
 * Template-first: the edit is applied unconditionally to every future instance
 * AND to base_event_data so newly-materialized instances (from the auto-extend
 * cron) also inherit it. Past instances are preserved.
 */
router.patch('/events/series/:seriesId', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.seriesId, 'series ID');
    const data = validateRequest(updateEventSchema.extend({
      instance_count: z.number().int().min(0).max(52).optional(),
    }), req.body);

    // Ownership: non-admin keys must be linked to the creator_account_id of the series.
    const { data: sample } = await supabaseAdmin
      .from('events')
      .select('id, creator_account_id, event_timezone')
      .eq('series_id', req.params.seriesId)
      .limit(1)
      .maybeSingle();
    if (!sample) throw createError('Series not found', 404, 'NOT_FOUND');
    if (!req.apiKeyInfo?.isAdmin) {
      if (!sample.creator_account_id) throw createError('Series has no owner; admin access required', 403, 'FORBIDDEN');
      await assertLinkedAccount(req, sample.creator_account_id);
    }

    const tz = data.timezone || (sample.event_timezone as string) || 'America/New_York';

    const templateUpdate: Record<string, unknown> = {};
    if (data.name !== undefined) templateUpdate.content = data.name;
    if (data.location?.name !== undefined) templateUpdate.place_name = data.location.name;
    if (data.location?.address !== undefined) templateUpdate.venue_address = data.location.address;
    if (data.location?.place_id !== undefined) templateUpdate.place_id = data.location.place_id;
    if (data.location?.lat !== undefined) templateUpdate.latitude = data.location.lat;
    if (data.location?.lng !== undefined) templateUpdate.longitude = data.location.lng;
    if (data.location?.lat !== undefined || data.location?.lng !== undefined) {
      const lat = data.location?.lat ?? null;
      const lng = data.location?.lng ?? null;
      templateUpdate.approximate_location = lat != null && lng != null ? `POINT(${lng} ${lat})` : null;
    }
    if (data.description !== undefined) templateUpdate.description = data.description;
    if (data.cost !== undefined) templateUpdate.price = data.cost;
    if (data.url !== undefined) templateUpdate.link_url = data.url || null;
    if (data.category !== undefined) templateUpdate.category = data.category;
    if (data.custom_category !== undefined) templateUpdate.custom_category = data.custom_category;
    if (data.timezone !== undefined) templateUpdate.event_timezone = data.timezone;
    if (data.wheelchair_accessible !== undefined) templateUpdate.wheelchair_accessible = data.wheelchair_accessible;
    if (data.capacity !== undefined) templateUpdate.capacity = data.capacity;
    if (data.rsvp !== undefined) templateUpdate.rsvp = data.rsvp;
    if (data.open_window !== undefined) templateUpdate.open_window = data.open_window;
    if (data.image_focal_y !== undefined) templateUpdate.event_image_focal_y = data.image_focal_y;
    if (data.tags !== undefined) {
      const cat = data.category || 'community';
      templateUpdate.tags = validateTags(data.tags, cat);
    }

    // Decompose start/end (ISO 8601) into HH:MM in the series timezone for createEventSeries helpers.
    const newStartTime = data.start ? fromTimestamptz(data.start, tz).time : undefined;
    const newEndTime = data.end === null ? null
      : data.end ? fromTimestamptz(data.end, tz).time
      : undefined;
    const hasTimeChange = newStartTime !== undefined || newEndTime !== undefined;
    const timeChange = hasTimeChange
      ? { startTime: newStartTime, endTime: newEndTime ?? null }
      : undefined;
    const hasInstanceCountChange = data.instance_count !== undefined;

    if (Object.keys(templateUpdate).length === 0 && !hasTimeChange && !hasInstanceCountChange) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const result = await updateSeriesFutureInstances({
      seriesId: req.params.seriesId,
      updates: templateUpdate,
      timeChange,
      instanceCountChange: hasInstanceCountChange ? data.instance_count : undefined,
      timezone: tz,
    });

    for (const id of result.updatedIds) {
      dispatchEventWebhookById('event.updated', id, { onlyPublished: true });
    }

    console.log(`[SERVICE] Series ${req.params.seriesId} updated: ${result.updatedCount} future instances`);
    res.json({
      series_id: req.params.seriesId,
      updated: result.updatedCount,
      total: result.totalAfter,
      added: result.instancesAdded,
      removed: result.instancesRemoved,
    });
  } catch (err) {
    next(err);
  }
});

/** DELETE /service/events/series/:seriesId — Delete all events in a series (scoped) */
router.delete('/events/series/:seriesId', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.seriesId, 'series ID');
    // Verify ownership via any event in the series
    if (!req.apiKeyInfo?.isAdmin) {
      const { data: sample } = await supabaseAdmin
        .from('events')
        .select('id')
        .eq('series_id', req.params.seriesId)
        .limit(1)
        .maybeSingle();
      if (sample) await assertLinkedEvent(req, sample.id);
    }
    const deleted = await deleteSeriesEvents(req.params.seriesId);
    res.json({ deleted: true, series_id: req.params.seriesId, count: deleted });
  } catch (err) {
    next(err);
  }
});

export default router;
