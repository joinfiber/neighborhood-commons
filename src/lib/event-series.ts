/**
 * Event Series Operations — Neighborhood Commons
 *
 * Series lifecycle: create recurring event instances, delete series,
 * and dispatch webhooks for series events. Used by portal and admin routes.
 */

import { supabaseAdmin } from './supabase.js';
import { dispatchWebhooks, dispatchSeriesCreatedWebhook } from './webhook-delivery.js';
import { toNeighborhoodEvent, toRRule, type PortalEventRow } from './event-transform.js';
import { createError } from '../middleware/error-handler.js';
import {
  toTimestamptz, fromTimestamptz, generateInstanceDates, formatDateStr,
  getAdminUserId, PORTAL_SELECT, MANAGED_SOURCES,
} from './event-operations.js';

/**
 * Create a recurring event series directly in the events table.
 * Returns the created events (with portal-friendly format).
 */
export async function createEventSeries(
  templateData: Record<string, unknown>,
  recurrence: string,
  startDate: string,
  startTime: string,
  endTime: string | null | undefined,
  timezone: string,
  instanceCount?: number,
): Promise<Array<{ id: string; event_date: string }>> {
  const dates = generateInstanceDates(startDate, recurrence, instanceCount);
  if (dates.length <= 1) {
    throw createError(
      `Recurrence pattern "${recurrence}" generated ${dates.length} date(s) from ${startDate} — a series requires at least 2 instances`,
      400, 'VALIDATION_ERROR',
    );
  }

  const adminUserId = getAdminUserId();

  // Snapshot the template fields for future instance generation (auto-extend cron)
  // and template-first editing (bulk-update futures from this snapshot)
  const baseEventData: Record<string, unknown> = {};
  const templateKeys = [
    'content', 'description', 'place_name', 'venue_address', 'place_id',
    'latitude', 'longitude', 'category', 'custom_category', 'price',
    'link_url', 'event_image_focal_y', 'start_time_required', 'tags',
    'wheelchair_accessible', 'rsvp_limit',
  ];
  for (const key of templateKeys) {
    if (key in templateData) baseEventData[key] = templateData[key];
  }
  // Store time info so auto-extend cron can generate instances without fetching existing events
  baseEventData.start_time = startTime;
  baseEventData.end_time = endTime || null;
  baseEventData.event_timezone = timezone;

  // Create an event_series row
  const recurrenceRule = { frequency: recurrence, count: dates.length };
  const { data: series, error: seriesErr } = await supabaseAdmin
    .from('event_series')
    .insert({
      creator_account_id: templateData.creator_account_id as string,
      user_id: adminUserId,
      recurrence,
      recurrence_rule: recurrenceRule,
      base_event_data: baseEventData,
    })
    .select('id')
    .single();

  if (seriesErr || !series) {
    console.error('[SERIES] Series row insert failed:', seriesErr?.message);
    throw createError('Failed to create event series', 500, 'SERVER_ERROR');
  }

  // Build event rows
  const rows = dates.map((date, i) => {
    const eventAt = toTimestamptz(date, startTime, timezone);
    let endTimeTs: string | null = null;
    if (endTime) {
      endTimeTs = toTimestamptz(date, endTime, timezone);
      // If end_time is before start_time, the event spans midnight — use next day
      if (new Date(endTimeTs) <= new Date(eventAt)) {
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDateStr = nextDay.toISOString().split('T')[0]!;
        endTimeTs = toTimestamptz(nextDateStr, endTime, timezone);
      }
    }

    return {
      ...templateData,
      event_at: eventAt,
      end_time: endTimeTs,
      recurrence,
      series_id: series.id,
      series_instance_number: i + 1,
    };
  });

  const { data: events, error } = await supabaseAdmin
    .from('events')
    .insert(rows)
    .select('id, event_at, event_timezone, status')
    .order('event_at', { ascending: true });

  if (error) {
    console.error('[SERIES] Event instances insert failed:', error.message);
    // Clean up the orphaned series row
    await supabaseAdmin.from('event_series').delete().eq('id', series.id);
    throw createError('Failed to create event instances', 500, 'SERVER_ERROR');
  }

  // Dispatch webhooks only for published events (skip pending_review)
  const publishedEvents = (events || []).filter((e) => e.status === 'published');
  if (publishedEvents.length > 0) {
    void dispatchSeriesWebhooks(publishedEvents);

    // Consolidated series webhook — one event instead of N individual event.created webhooks.
    // Consumers who subscribe to event.series_created can use this instead.
    const rrule = toRRule(recurrence);
    if (rrule) {
      const instances = publishedEvents.map((e, i) => ({
        id: e.id,
        start: e.event_at,
        series_instance_number: i + 1,
      }));
      // Build template from first instance
      const { data: templateRow } = await supabaseAdmin
        .from('events')
        .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
        .eq('id', publishedEvents[0]!.id)
        .maybeSingle();
      if (templateRow) {
        const tpl = templateRow as unknown as Record<string, unknown>;
        tpl.recurrence = recurrence; // Ensure template carries the series recurrence
        const template = toNeighborhoodEvent(tpl as unknown as PortalEventRow);
        void dispatchSeriesCreatedWebhook(series.id, template, instances, rrule);
      }
    }
  }

  const results = (events || []).map((e) => {
    const { date } = fromTimestamptz(e.event_at, e.event_timezone || timezone);
    return { id: e.id, event_date: date };
  });

  console.log(`[SERIES] Created: ${results.length} instances (series ${series.id})`);
  return results;
}

/**
 * Delete all events in a series.
 */
export async function deleteSeriesEvents(seriesId: string): Promise<number> {
  const { data: events } = await supabaseAdmin
    .from('events')
    .select('id')
    .eq('series_id', seriesId)
    .in('source', [...MANAGED_SOURCES])
    .limit(5000);

  if (!events || events.length === 0) return 0;

  const ids = events.map((e) => e.id);

  const { error } = await supabaseAdmin
    .from('events')
    .delete()
    .in('id', ids);

  if (error) {
    console.error('[PORTAL] Series delete failed:', error.message);
    return 0;
  }

  // Dispatch webhooks for each deleted event
  for (const e of events) {
    void dispatchWebhooks('event.deleted', e.id, {
      id: e.id, name: '', start: '', end: null, timezone: 'UTC', description: null,
      category: [], place_id: null,
      location: { name: '', address: null, lat: null, lng: null },
      url: null, images: [], event_image_focal_y: 0.5, organizer: { name: '', phone: null },
      cost: null, series_id: null, series_instance_number: null, series_instance_count: null, start_time_required: true, tags: [], wheelchair_accessible: null,
      runtime_minutes: null, content_rating: null, showtimes: null, recurrence: null,
      source: { publisher: 'neighborhood-commons', collected_at: new Date().toISOString(), method: 'portal', contributor: null, license: 'CC BY 4.0' },
    });
  }

  // Clean up the event_series row (no more events reference it)
  await supabaseAdmin.from('event_series').delete().eq('id', seriesId);

  console.log(`[PORTAL] Series ${seriesId} deleted: ${events.length} events`);
  return events.length;
}

// =============================================================================
// SERIES UPDATE — shared by portal and admin
// =============================================================================

export interface SeriesUpdateInput {
  seriesId: string;
  /** DB-column-keyed template field updates (e.g., { content: 'New Title', price: '$5' }) */
  updates: Record<string, unknown>;
  /** Per-instance time changes — preserves each instance's date */
  timeChange?: { startTime?: string; endTime?: string | null };
  /** Change the number of future instances */
  instanceCountChange?: number;
  /** Timezone for time composition */
  timezone: string;
}

export interface SeriesUpdateResult {
  updatedCount: number;
  totalAfter: number;
  instancesAdded: number;
  instancesRemoved: number;
  updatedIds: string[];
}

/** Map from DB column names to base_event_data keys — used when updating the template snapshot */
const COLUMN_TO_BASE_KEY: Record<string, string> = {
  content: 'content', place_name: 'place_name', venue_address: 'venue_address',
  place_id: 'place_id', latitude: 'latitude', longitude: 'longitude',
  category: 'category', custom_category: 'custom_category',
  description: 'description', price: 'price', link_url: 'link_url',
  start_time_required: 'start_time_required', tags: 'tags',
  wheelchair_accessible: 'wheelchair_accessible', rsvp_limit: 'rsvp_limit',
  event_image_focal_y: 'event_image_focal_y',
};

/**
 * Update all future instances of a series from the template.
 * Template-first: all future instances get the update unconditionally.
 * No per-instance customization detection — the operator edits "the thing."
 */
export async function updateSeriesFutureInstances(input: SeriesUpdateInput): Promise<SeriesUpdateResult> {
  const { seriesId, updates, timeChange, instanceCountChange, timezone: tz } = input;

  // Fetch series metadata
  const { data: series } = await supabaseAdmin
    .from('event_series')
    .select('id, recurrence, base_event_data, creator_account_id')
    .eq('id', seriesId)
    .maybeSingle();

  if (!series) throw createError('Series not found', 404, 'NOT_FOUND');

  const baseData = (series.base_event_data as Record<string, unknown>) || {};

  // Fetch all future instances
  const now = new Date().toISOString();
  const { data: futureEvents, error: fetchErr } = await supabaseAdmin
    .from('events')
    .select('id, event_at, end_time, event_timezone, series_instance_number')
    .eq('series_id', seriesId)
    .in('source', [...MANAGED_SOURCES])
    .gte('event_at', now)
    .order('event_at', { ascending: true });

  if (fetchErr) throw createError('Failed to fetch series events', 500, 'SERVER_ERROR');
  if (!futureEvents || futureEvents.length === 0) {
    throw createError('No upcoming events in this series', 404, 'NOT_FOUND');
  }

  let updatedCount = 0;
  const updatedIds: string[] = [];
  const hasTimeChange = timeChange && (timeChange.startTime !== undefined || timeChange.endTime !== undefined);

  if (Object.keys(updates).length > 0 || hasTimeChange) {
    if (hasTimeChange) {
      // Time changes need per-instance handling (each instance has its own date)
      for (const ev of futureEvents) {
        const instanceUpdate: Record<string, unknown> = { ...updates };
        const instanceTz = (ev.event_timezone as string) || tz;
        const parsed = ev.event_at ? fromTimestamptz(ev.event_at as string, instanceTz) : null;
        const instanceDate = parsed?.date;

        if (instanceDate) {
          if (timeChange!.startTime !== undefined) {
            const newTime = timeChange!.startTime || parsed?.time;
            if (newTime) instanceUpdate.event_at = toTimestamptz(instanceDate, newTime, instanceTz);
          }
          if (timeChange!.endTime !== undefined) {
            if (timeChange!.endTime) {
              const eventAtRef = (instanceUpdate.event_at as string) || (ev.event_at as string);
              let endTimeTs = toTimestamptz(instanceDate, timeChange!.endTime, instanceTz);
              if (eventAtRef && new Date(endTimeTs) <= new Date(eventAtRef)) {
                const nextDay = new Date(instanceDate);
                nextDay.setDate(nextDay.getDate() + 1);
                endTimeTs = toTimestamptz(nextDay.toISOString().split('T')[0]!, timeChange!.endTime, instanceTz);
              }
              instanceUpdate.end_time = endTimeTs;
            } else {
              instanceUpdate.end_time = null;
            }
          }
        }

        if (Object.keys(instanceUpdate).length === 0) continue;

        const { error: updateErr } = await supabaseAdmin
          .from('events')
          .update(instanceUpdate)
          .eq('id', ev.id as string);

        if (!updateErr) {
          updatedCount++;
          updatedIds.push(ev.id as string);
        }
      }
    } else {
      // No time change — batch update all future instances at once
      const ids = futureEvents.map(e => e.id as string);
      const { error: updateErr } = await supabaseAdmin
        .from('events')
        .update(updates)
        .in('id', ids);

      if (!updateErr) {
        updatedCount = ids.length;
        updatedIds.push(...ids);
      }
    }
  }

  // Update base_event_data on the series row
  const newBase = { ...baseData };
  for (const [col, baseKey] of Object.entries(COLUMN_TO_BASE_KEY)) {
    if (col in updates) newBase[baseKey] = updates[col];
  }
  if (hasTimeChange) {
    if (timeChange!.startTime !== undefined) newBase.start_time = timeChange!.startTime;
    if (timeChange!.endTime !== undefined) newBase.end_time = timeChange!.endTime || null;
  }
  await supabaseAdmin
    .from('event_series')
    .update({ base_event_data: newBase })
    .eq('id', seriesId);

  // Handle instance_count changes
  let instancesAdded = 0;
  let instancesRemoved = 0;

  if (instanceCountChange !== undefined) {
    const seriesRecurrence = series.recurrence as string;
    if (seriesRecurrence && seriesRecurrence !== 'none') {
      const desiredCount = generateInstanceDates('2025-01-01', seriesRecurrence, instanceCountChange).length;

      // Re-fetch future instances (may have changed from template updates)
      const { data: allFuture } = await supabaseAdmin
        .from('events')
        .select('id, event_at, event_timezone, end_time, series_instance_number')
        .eq('series_id', seriesId)
        .in('source', [...MANAGED_SOURCES])
        .gte('event_at', now)
        .order('event_at', { ascending: true });

      const currentFutureCount = allFuture?.length || 0;

      if (desiredCount > currentFutureCount && allFuture && allFuture.length > 0) {
        // Extend: generate new instances from day after last existing one
        const lastFuture = allFuture[allFuture.length - 1]!;
        const lastTz = (lastFuture.event_timezone as string) || tz;
        const lastParsed = fromTimestamptz(lastFuture.event_at as string, lastTz);
        const lastNum = (lastFuture.series_instance_number as number) || allFuture.length;

        const startTime = (newBase.start_time as string) || lastParsed.time;
        let endTime: string | null = (newBase.end_time as string) || null;
        if (!endTime && lastFuture.end_time) {
          endTime = fromTimestamptz(lastFuture.end_time as string, lastTz).time;
        }

        const lastDate = new Date(lastParsed.date + 'T12:00:00');
        lastDate.setDate(lastDate.getDate() + 1);
        const newStartDate = formatDateStr(lastDate);

        const needed = desiredCount - currentFutureCount;
        const newDates = generateInstanceDates(newStartDate, seriesRecurrence, needed);

        if (newDates.length > 0) {
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
              source: 'portal',
              visibility: 'public',
              status: 'published',
              is_business: true,
              region_id: null,
              event_timezone: lastTz,
              event_at: eventAt,
              end_time: endTimeTs,
              recurrence: seriesRecurrence,
              series_id: seriesId,
              series_instance_number: lastNum + i + 1,
            };
          });

          const { data: created, error: insertErr } = await supabaseAdmin
            .from('events')
            .insert(rows)
            .select('id');

          if (!insertErr) instancesAdded = created?.length || 0;
        }
      } else if (desiredCount < currentFutureCount && allFuture) {
        // Shrink: remove the furthest-out instances
        const toRemove = allFuture.slice(desiredCount);
        const removeIds = toRemove.map(e => e.id as string);
        if (removeIds.length > 0) {
          const { error: delErr } = await supabaseAdmin
            .from('events')
            .delete()
            .in('id', removeIds);
          if (!delErr) instancesRemoved = removeIds.length;
        }
      }

      // Update recurrence_rule count
      const finalCount = currentFutureCount + instancesAdded - instancesRemoved;
      await supabaseAdmin
        .from('event_series')
        .update({ recurrence_rule: { frequency: seriesRecurrence, count: finalCount } })
        .eq('id', seriesId);
    }
  }

  const totalAfter = futureEvents.length + instancesAdded - instancesRemoved;
  return { updatedCount, totalAfter, instancesAdded, instancesRemoved, updatedIds };
}

/** Fire-and-forget webhook dispatch for newly created series events */
export async function dispatchSeriesWebhooks(events: Array<{ id: string }>): Promise<void> {
  for (const e of events) {
    try {
      const { data: row } = await supabaseAdmin
        .from('events')
        .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
        .eq('id', e.id)
        .maybeSingle();
      if (!row) continue;
      const eventData = toNeighborhoodEvent(row as unknown as PortalEventRow);
      void dispatchWebhooks('event.created', e.id, eventData);
    } catch (err) {
      console.error('[PORTAL] Webhook dispatch error:', err instanceof Error ? err.message : err);
    }
  }
}
