/**
 * Event Series Operations — Neighborhood Commons
 *
 * Series lifecycle: create recurring event instances, edit series identity
 * and template, delete series, and dispatch webhooks for series events.
 *
 * Identity vs template (see docs/series-as-first-class.md):
 *   - Identity edits (updateSeriesIdentity) never propagate to past or
 *     future instance titles — renames are forward-only for discovery.
 *   - Template edits (updateSeriesFutureInstances) propagate to future
 *     instances and to base_event_data for the auto-extend cron.
 */

import { supabaseAdmin } from './supabase.js';
import {
  dispatchWebhooks,
  dispatchSeriesCreatedWebhook,
  dispatchSeriesUpdatedWebhook,
  dispatchSeriesDeletedWebhook,
  type SeriesProfile,
} from './webhook-delivery.js';
import { toNeighborhoodEvent, toRRule, type PortalEventRow } from './event-transform.js';
import { createError } from '../middleware/error-handler.js';
import {
  toTimestamptz, fromTimestamptz, generateInstanceDates, formatDateStr,
  getAdminUserId, PORTAL_SELECT, MANAGED_SOURCES,
} from './event-operations.js';

// =============================================================================
// SERIES IDENTITY — name, slug, description, cover_image_url
// =============================================================================

export interface SeriesIdentity {
  /** Public display name of the series. Required. */
  name: string;
  /** Organization that runs the series. Required for the authority check. */
  organizer_org_id: string;
  /** URL slug. Server derives from name if absent. Globally unique. */
  slug?: string;
  /** Optional publisher-authored description. */
  description?: string;
  /** Optional R2-hosted cover image URL. */
  cover_image_url?: string;
}

/**
 * Slug-base regex per migration 089 + the contributor_profiles convention:
 * lowercase alphanumeric + hyphens, must start with alphanumeric, max 100 chars.
 */
const SERIES_SLUG_FORMAT = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MAX_SLUG_LENGTH = 100;

/** Lowercase, strip apostrophe variants, non-alnum → hyphen, trim, cap 100. */
function baseSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/['‘’‛`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

/**
 * Find an unused series slug derived from `name`. Suffixes `-2`, `-3`, ...
 * on collision. Single SELECT for all candidates avoids N round-trips.
 *
 * Race: DB UNIQUE constraint is the actual guard; this reduces collision
 * likelihood. Caller should handle the resulting 23505 by surfacing 409.
 */
export async function deriveUniqueSeriesSlug(name: string): Promise<string> {
  const base = baseSlug(name);
  if (!base) {
    throw createError(
      `Cannot derive a slug from series name "${name}". Provide an explicit slug or use English letters and numbers in the name.`,
      400, 'VALIDATION_ERROR',
    );
  }

  const { data: existing } = await supabaseAdmin
    .from('event_series')
    .select('slug')
    .or(`slug.eq.${base},slug.like.${base}-%`);

  const taken = new Set((existing || []).map((r) => r.slug as string));
  if (!taken.has(base)) return base;

  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}-${n}`.slice(0, MAX_SLUG_LENGTH);
    if (!taken.has(candidate)) return candidate;
  }
  throw createError(
    `Could not derive a unique slug from "${name}" within 10000 attempts. Try a more distinctive name or provide an explicit slug.`,
    409, 'CONFLICT',
  );
}

/** Validate a publisher-provided slug against the format constraint. */
export function validateSeriesSlug(slug: string): void {
  if (!SERIES_SLUG_FORMAT.test(slug)) {
    throw createError(
      `Invalid series slug "${slug}". Must be lowercase alphanumeric + hyphens, start with alphanumeric, max 100 chars.`,
      400, 'VALIDATION_ERROR',
    );
  }
}

/**
 * Create a recurring event series directly in the events table.
 * Returns the created events (with portal-friendly format).
 *
 * `identity` carries the series-level public identity (name, slug, description,
 * cover image). This is distinct from `templateData`, which is the per-instance
 * snapshot used to materialize event rows. See docs/series-as-first-class.md.
 */
export async function createEventSeries(
  templateData: Record<string, unknown>,
  identity: SeriesIdentity,
  recurrence: string,
  startDate: string,
  startTime: string,
  endTime: string | null | undefined,
  timezone: string,
  instanceCount?: number,
): Promise<{ seriesId: string; instances: Array<{ id: string; event_date: string }> }> {
  // Identity validation
  const trimmedName = identity.name?.trim() ?? '';
  if (!trimmedName) {
    throw createError('Series name is required', 400, 'VALIDATION_ERROR');
  }
  if (!identity.organizer_org_id) {
    throw createError('Series organizer_org_id is required', 400, 'VALIDATION_ERROR');
  }

  let slug: string;
  if (identity.slug) {
    validateSeriesSlug(identity.slug);
    slug = identity.slug;
  } else {
    slug = await deriveUniqueSeriesSlug(trimmedName);
  }

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
    'link_url', 'event_image_focal_y', 'open_window', 'tags',
    'wheelchair_accessible', 'capacity', 'rsvp',
    // Contributor override (migration 062) must propagate to all future
    // instances — the auto-extend cron reads base_event_data to regenerate
    // them weeks later.
    'source_contributor_name', 'source_contributor_url',
    // Registered-profile link (migration 086). Keep it on auto-extended
    // instances so the "via <app>" attribution card persists on instances the
    // cron materializes weeks later. Initial instances already inherit it via
    // the templateData spread below.
    'contributor_profile_id',
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
      organizer_org_id: identity.organizer_org_id,
      name: trimmedName,
      slug,
      description: identity.description ?? null,
      cover_image_url: identity.cover_image_url ?? null,
      recurrence,
      recurrence_rule: recurrenceRule,
      base_event_data: baseEventData,
    })
    .select('id')
    .single();

  if (seriesErr || !series) {
    // 23505 = unique_violation on slug — surface as 409
    if (seriesErr?.code === '23505') {
      throw createError(`Series slug "${slug}" is already in use`, 409, 'CONFLICT');
    }
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
        .select(`${PORTAL_SELECT}, organizations!events_organizer_org_id_fkey(id, slug, name)`)
        .eq('id', publishedEvents[0]!.id)
        .maybeSingle();
      if (templateRow) {
        const tpl = templateRow as unknown as Record<string, unknown>;
        tpl.recurrence = recurrence; // Ensure template carries the series recurrence
        const template = toNeighborhoodEvent(tpl as unknown as PortalEventRow);
        const profile: SeriesProfile = {
          id: series.id,
          slug,
          name: trimmedName,
          description: identity.description ?? null,
          cover_image_url: identity.cover_image_url ?? null,
          organizer_org_id: identity.organizer_org_id,
        };
        void dispatchSeriesCreatedWebhook(profile, template, instances, rrule);
      }
    }
  }

  const results = (events || []).map((e) => {
    const { date } = fromTimestamptz(e.event_at, e.event_timezone || timezone);
    return { id: e.id, event_date: date };
  });

  console.log(`[SERIES] Created: ${results.length} instances (series ${series.id}, slug "${slug}")`);
  return { seriesId: series.id, instances: results };
}

/**
 * Delete all events in a series.
 */
export async function deleteSeriesEvents(seriesId: string): Promise<number> {
  // Snapshot the series identity BEFORE deletion so the series.deleted webhook
  // payload can carry name/slug for cache invalidation.
  const { data: seriesRow } = await supabaseAdmin
    .from('event_series')
    .select('id, slug, name')
    .eq('id', seriesId)
    .maybeSingle();

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
      url: null, images: [], event_image_focal_y: 0.5,
      organizer: { id: '', slug: '', name: '', verified: false, phone: null },
      cost: null, series_id: null, series_instance_number: null, series_instance_count: null, open_window: false, capacity: null, rsvp: null, tags: [], wheelchair_accessible: null,
      first_party: false, tmdb_id: null, recurrence: null,
      source: { method: 'self_asserted', url: null, contributor: null, collected_at: new Date().toISOString(), license: 'CC BY 4.0' },
    });
  }

  // Series-level signal (complements the per-instance event.deleted events above).
  if (seriesRow) {
    void dispatchSeriesDeletedWebhook(
      { id: seriesRow.id as string, slug: seriesRow.slug as string, name: seriesRow.name as string },
      ids,
    );
  }

  // Clean up the event_series row (no more events reference it)
  await supabaseAdmin.from('event_series').delete().eq('id', seriesId);

  console.log(`[PORTAL] Series ${seriesId} deleted: ${events.length} events`);
  return events.length;
}

// =============================================================================
// SERIES IDENTITY UPDATE — name/slug/description/cover only
//
// Identity edits are forward-looking: they change how the series is presented
// from now on, but NEVER rewrite past instance titles. Past events.content
// retains whatever it was at the time the instance was materialized. This
// keeps the historical record accurate while letting the series evolve.
//
// Distinct from updateSeriesFutureInstances (below), which patches the
// per-instance template and propagates field changes into future instance
// rows + base_event_data for the auto-extend cron.
// =============================================================================

export interface SeriesIdentityUpdate {
  name?: string;
  slug?: string;
  description?: string | null;
  cover_image_url?: string | null;
}

export interface SeriesIdentityResult {
  seriesId: string;
  changed: Array<'name' | 'slug' | 'description' | 'cover_image_url'>;
}

/**
 * Update identity fields on an event_series row. Fires series.updated webhook.
 * Does NOT touch any event row. Slug uniqueness enforced by the DB index;
 * collision surfaces as 409.
 */
export async function updateSeriesIdentity(
  seriesId: string,
  update: SeriesIdentityUpdate,
): Promise<SeriesIdentityResult> {
  const { data: existing } = await supabaseAdmin
    .from('event_series')
    .select('id, slug, name, description, cover_image_url, organizer_org_id')
    .eq('id', seriesId)
    .maybeSingle();

  if (!existing) throw createError('Series not found', 404, 'NOT_FOUND');

  const patch: Record<string, unknown> = {};
  const changed: Array<'name' | 'slug' | 'description' | 'cover_image_url'> = [];

  if (update.name !== undefined) {
    const trimmed = update.name.trim();
    if (!trimmed) throw createError('Series name cannot be empty', 400, 'VALIDATION_ERROR');
    if (trimmed !== existing.name) {
      patch.name = trimmed;
      changed.push('name');
    }
  }
  if (update.slug !== undefined) {
    validateSeriesSlug(update.slug);
    if (update.slug !== existing.slug) {
      patch.slug = update.slug;
      changed.push('slug');
    }
  }
  if (update.description !== undefined && update.description !== existing.description) {
    patch.description = update.description;
    changed.push('description');
  }
  if (update.cover_image_url !== undefined && update.cover_image_url !== existing.cover_image_url) {
    patch.cover_image_url = update.cover_image_url;
    changed.push('cover_image_url');
  }

  if (changed.length === 0) {
    return { seriesId, changed: [] };
  }

  const { error } = await supabaseAdmin
    .from('event_series')
    .update(patch)
    .eq('id', seriesId);

  if (error) {
    if (error.code === '23505') {
      throw createError(`Series slug "${update.slug}" is already in use`, 409, 'CONFLICT');
    }
    console.error('[SERIES] Identity update failed:', error.message);
    throw createError('Failed to update series identity', 500, 'SERVER_ERROR');
  }

  const profile: SeriesProfile = {
    id: seriesId,
    slug: (patch.slug ?? existing.slug) as string,
    name: (patch.name ?? existing.name) as string,
    description: (patch.description ?? existing.description ?? null) as string | null,
    cover_image_url: (patch.cover_image_url ?? existing.cover_image_url ?? null) as string | null,
    organizer_org_id: (existing.organizer_org_id ?? null) as string | null,
  };
  void dispatchSeriesUpdatedWebhook(profile, changed);

  console.log(`[SERIES] Identity updated for ${seriesId}: ${changed.join(', ')}`);
  return { seriesId, changed };
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
  open_window: 'open_window', tags: 'tags',
  wheelchair_accessible: 'wheelchair_accessible', capacity: 'capacity', rsvp: 'rsvp',
  event_image_focal_y: 'event_image_focal_y',
  source_contributor_name: 'source_contributor_name',
  source_contributor_url: 'source_contributor_url',
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

// =============================================================================
// AUTO-EXTEND — cron job to maintain the 6-week rolling horizon
// =============================================================================

/** How far into the future the horizon should extend (milliseconds) */
const HORIZON_MS = 6 * 7 * 24 * 60 * 60 * 1000; // 6 weeks
/** Refill when the last instance is within this threshold (milliseconds) */
const REFILL_THRESHOLD_MS = 3 * 7 * 24 * 60 * 60 * 1000; // 3 weeks

/**
 * Auto-extend all active series to maintain the 6-week rolling horizon.
 * For each active series whose last future instance is within 3 weeks of now,
 * generates new instances to push the horizon back out to 6 weeks.
 */
export async function autoExtendSeries(): Promise<{
  extended: number;
  instancesCreated: number;
  errors: number;
}> {
  // Fetch all active series (ongoing or bounded with future end)
  const { data: allSeries } = await supabaseAdmin
    .from('event_series')
    .select('id, recurrence, base_event_data, creator_account_id, ends_at')
    .or('ends_at.is.null,ends_at.gt.' + new Date().toISOString());

  if (!allSeries || allSeries.length === 0) {
    return { extended: 0, instancesCreated: 0, errors: 0 };
  }

  const now = Date.now();
  const horizon = new Date(now + HORIZON_MS);
  const refillThreshold = new Date(now + REFILL_THRESHOLD_MS);
  let extended = 0;
  let instancesCreated = 0;
  let errors = 0;

  for (const series of allSeries) {
    try {
      const recurrence = series.recurrence as string;
      if (!recurrence || recurrence === 'none') continue;

      const baseData = (series.base_event_data as Record<string, unknown>) || {};
      const startTime = baseData.start_time as string;
      const endTime = (baseData.end_time as string) || null;
      const tz = (baseData.event_timezone as string) || 'America/New_York';

      // Skip if base_event_data doesn't have time info (pre-migration series)
      if (!startTime) {
        console.log(`[CRON] Skipping series ${series.id} — no start_time in base_event_data`);
        continue;
      }

      // Find the last future instance
      const { data: lastEvent } = await supabaseAdmin
        .from('events')
        .select('event_at, event_timezone, series_instance_number')
        .eq('series_id', series.id)
        .gte('event_at', new Date().toISOString())
        .order('event_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!lastEvent) {
        // No future instances — generate from tomorrow
        const tomorrow = new Date(now + 24 * 60 * 60 * 1000);
        const startDate = formatDateStr(tomorrow);
        const dates = generateInstanceDates(startDate, recurrence);

        // Respect ends_at boundary
        const endsAt = series.ends_at ? new Date(series.ends_at as string) : null;
        const filtered = endsAt
          ? dates.filter(d => new Date(d + 'T23:59:59') <= endsAt)
          : dates.filter(d => new Date(d + 'T12:00:00') <= horizon);

        if (filtered.length === 0) continue;

        const adminUserId = getAdminUserId();
        const rows = filtered.map((date, i) => {
          const eventAt = toTimestamptz(date, startTime, tz);
          let endTimeTs: string | null = null;
          if (endTime) {
            endTimeTs = toTimestamptz(date, endTime, tz);
            if (new Date(endTimeTs) <= new Date(eventAt)) {
              const nextDay = new Date(date);
              nextDay.setDate(nextDay.getDate() + 1);
              endTimeTs = toTimestamptz(nextDay.toISOString().split('T')[0]!, endTime, tz);
            }
          }
          // Strip template-only time metadata before spreading into event row
          const { start_time: _st, end_time: _et, event_timezone: _etz, ...eventFields } = baseData;
          return {
            ...eventFields,
            creator_account_id: series.creator_account_id,
            user_id: adminUserId,
            source: 'portal', visibility: 'public', status: 'published',
            region_id: null,
            event_timezone: tz,
            event_at: eventAt, end_time: endTimeTs,
            recurrence, series_id: series.id,
            series_instance_number: i + 1,
          };
        });

        const { data: created, error: insertErr } = await supabaseAdmin
          .from('events')
          .insert(rows)
          .select('id');

        if (insertErr) {
          console.error(`[CRON] extend-series: insert failed for ${series.id}:`, insertErr.message);
          errors++;
        } else {
          const count = created?.length || 0;
          instancesCreated += count;
          extended++;
          console.log(`[CRON] extend-series: ${series.id} regenerated ${count} instances (no future events existed)`);
        }
        continue;
      }

      // Check if the last instance is within the refill threshold
      const lastEventDate = new Date(lastEvent.event_at as string);
      if (lastEventDate > refillThreshold) continue; // Still has enough runway

      // Generate new dates from day after last instance to horizon
      const lastTz = (lastEvent.event_timezone as string) || tz;
      const lastParsed = fromTimestamptz(lastEvent.event_at as string, lastTz);
      const lastNum = (lastEvent.series_instance_number as number) || 0;

      const lastDate = new Date(lastParsed.date + 'T12:00:00');
      lastDate.setDate(lastDate.getDate() + 1);
      const newStartDate = formatDateStr(lastDate);

      const newDates = generateInstanceDates(newStartDate, recurrence);

      // Respect ends_at and horizon boundaries
      const endsAt = series.ends_at ? new Date(series.ends_at as string) : null;
      const boundary = endsAt && endsAt < horizon ? endsAt : horizon;
      const filtered = newDates.filter(d => new Date(d + 'T12:00:00') <= boundary);

      if (filtered.length === 0) continue;

      const adminUserId = getAdminUserId();
      const rows = filtered.map((date, i) => {
        const eventAt = toTimestamptz(date, startTime, tz);
        let endTimeTs: string | null = null;
        if (endTime) {
          endTimeTs = toTimestamptz(date, endTime, tz);
          if (new Date(endTimeTs) <= new Date(eventAt)) {
            const nextDay = new Date(date);
            nextDay.setDate(nextDay.getDate() + 1);
            endTimeTs = toTimestamptz(nextDay.toISOString().split('T')[0]!, endTime, tz);
          }
        }
        const { start_time: _st2, end_time: _et2, event_timezone: _etz2, ...evFields } = baseData;
        return {
          ...evFields,
          creator_account_id: series.creator_account_id,
          user_id: adminUserId,
          source: 'portal', visibility: 'public', status: 'published',
          region_id: null,
          event_timezone: tz,
          event_at: eventAt, end_time: endTimeTs,
          recurrence, series_id: series.id,
          series_instance_number: lastNum + i + 1,
        };
      });

      const { data: created, error: insertErr } = await supabaseAdmin
        .from('events')
        .insert(rows)
        .select('id');

      if (insertErr) {
        console.error(`[CRON] extend-series: insert failed for ${series.id}:`, insertErr.message);
        errors++;
      } else {
        const count = created?.length || 0;
        instancesCreated += count;
        extended++;
        // Dispatch webhooks for new published instances
        if (count > 0) void dispatchSeriesWebhooks(created!);
        console.log(`[CRON] extend-series: ${series.id} +${count} instances (last was ${lastParsed.date})`);
      }
    } catch (err) {
      console.error(`[CRON] extend-series: error for ${series.id}:`, err instanceof Error ? err.message : err);
      errors++;
    }
  }

  return { extended, instancesCreated, errors };
}

/** Fire-and-forget webhook dispatch for newly created series events */
export async function dispatchSeriesWebhooks(events: Array<{ id: string }>): Promise<void> {
  for (const e of events) {
    try {
      const { data: row } = await supabaseAdmin
        .from('events')
        .select(`${PORTAL_SELECT}, organizations!events_organizer_org_id_fkey(id, slug, name)`)
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
