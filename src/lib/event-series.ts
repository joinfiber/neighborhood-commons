/**
 * Event Series Operations — Neighborhood Commons
 *
 * Series lifecycle: create recurring event instances, delete series,
 * and dispatch webhooks for series events. Used by portal and admin routes.
 */

import { supabaseAdmin } from './supabase.js';
import { dispatchWebhooks, dispatchSeriesCreatedWebhook } from './webhook-delivery.js';
import { toNeighborhoodEvent, toRRule, type PortalEventRow } from './event-transform.js';
import {
  toTimestamptz, fromTimestamptz, generateInstanceDates,
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
  if (dates.length <= 1) return [];

  const adminUserId = getAdminUserId();

  // Snapshot the template fields so we can detect per-instance customizations later
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
    console.error('[PORTAL] Event series create failed:', seriesErr?.message);
    return [];
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
    console.error('[PORTAL] Series insert failed:', error.message);
    return [];
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

  console.log(`[PORTAL] Series created: ${results.length} instances (series ${series.id})`);
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
    .in('source', [...MANAGED_SOURCES]);

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
      url: null, images: [], organizer: { name: '', phone: null },
      cost: null, series_id: null, series_instance_number: null, series_instance_count: null, start_time_required: true, tags: [], wheelchair_accessible: null,
      runtime_minutes: null, content_rating: null, showtimes: null, recurrence: null,
      source: { publisher: 'neighborhood-commons', collected_at: new Date().toISOString(), method: 'portal', license: 'CC BY 4.0' },
    });
  }

  // Clean up the event_series row (no more events reference it)
  await supabaseAdmin.from('event_series').delete().eq('id', seriesId);

  console.log(`[PORTAL] Series ${seriesId} deleted: ${events.length} events`);
  return events.length;
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
