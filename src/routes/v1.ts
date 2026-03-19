/**
 * Public Events API — Neighborhood API v0.2
 *
 * Read-only public API for Neighborhood Commons events.
 * No authentication required. Rate-limited by IP (1000/hr).
 *
 * Reads directly from the events table (source='portal').
 *
 * Base: /api/v1/events
 * Spec: neighborhood-api-v0.2
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { EVENT_CATEGORIES } from '../lib/categories.js';
import { ALL_TAG_SLUGS } from '../lib/tags.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, validateUuidParam } from '../lib/helpers.js';
import { toNeighborhoodEvent, toRRule, type PortalEventRow } from '../lib/event-transform.js';
import { optionalApiKey } from '../middleware/api-key.js';

const router: ReturnType<typeof Router> = Router();

// Extract API key if present (for rate limit keying), but don't require it
router.use(optionalApiKey);

// 1000 requests/hr — keyed by API key if present, otherwise by IP
export const v1Limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.apiKeyInfo?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded (1000/hr). Register for an API key at /api/v1/developers for a dedicated limit bucket.' } },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.INTEGRATION_TEST === 'true',
});

// =============================================================================
// ROUTES
// =============================================================================

const listSchema = z.object({
  start_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  category: z.string().max(50).optional(),
  tag: z.union([z.string().max(50), z.array(z.string().max(50))]).optional(),
  q: z.string().max(200).optional(),
  near: z.string().regex(/^-?\d+\.?\d*,-?\d+\.?\d*$/).optional(),
  radius_km: z.coerce.number().min(0.1).max(100).optional(),
  collapse_series: z.enum(['true', 'false']).optional(),
  series_id: z.string().uuid().optional(),
  recurring: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

/**
 * GET /api/v1/events
 * List published events. Paginated, filtered.
 */
router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(listSchema, req.query);

    const today = new Date().toISOString();
    const collapseSeries = params.collapse_series === 'true';

    // When collapsing series, over-fetch to compensate for dedup reducing the result set.
    const fetchLimit = collapseSeries ? params.limit * 3 : params.limit;

    let query = supabaseAdmin
      .from('events')
      .select('id, content, description, place_name, venue_address, place_id, latitude, longitude, event_at, end_time, event_timezone, category, custom_category, recurrence, price, link_url, event_image_url, created_at, creator_account_id, series_id, series_instance_number, start_time_required, tags, wheelchair_accessible, runtime_minutes, content_rating, showtimes, source_method, source_publisher, portal_accounts!events_creator_account_id_fkey(business_name, wheelchair_accessible)', { count: 'exact' })
      .eq('status', 'published')
      // Visibility: include events still relevant to browse feeds.
      // start_time_required=true events are visible until start; =false until end_time.
      // We over-fetch here (event_at OR end_time >= now) and filter precisely below.
      .or(`event_at.gte.${today},end_time.gte.${today}`)
      .order('event_at', { ascending: true })
      .range(params.offset, params.offset + fetchLimit - 1);

    // Series filter: return only events from a specific series
    if (params.series_id) {
      query = query.eq('series_id', params.series_id);
    }

    // Recurring filter: recurring=true → only series events, false → only one-offs
    if (params.recurring === 'true') {
      query = query.neq('recurrence', 'none');
    } else if (params.recurring === 'false') {
      query = query.eq('recurrence', 'none');
    }

    // Date range filters (compare against event_at, using ET boundary)
    if (params.start_after) {
      query = query.gte('event_at', params.start_after + 'T00:00:00-05:00');
    }
    if (params.start_before) {
      query = query.lte('event_at', params.start_before + 'T23:59:59-05:00');
    }

    // Category filter (by slug)
    if (params.category) {
      const categoryKey = Object.entries(EVENT_CATEGORIES).find(
        ([key]) => key.replace(/_/g, '-') === params.category
      )?.[0];
      if (categoryKey) {
        query = query.eq('category', categoryKey);
      }
    }

    // Text search
    if (params.q) {
      const sanitized = params.q.replace(/[,.()"\\%_;:'`*]/g, ' ').trim();
      if (sanitized.length > 0) {
        query = query.or(`content.ilike.%${sanitized}%,description.ilike.%${sanitized}%`);
      }
    }

    // Geo filtering
    if (params.near) {
      const [lat, lng] = params.near.split(',').map(Number);
      if (lat !== undefined && lng !== undefined && !isNaN(lat) && !isNaN(lng)) {
        const radiusKm = params.radius_km || 10;
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

    // Tag filtering (AND semantics: event must have ALL specified tags)
    if (params.tag) {
      const tags = Array.isArray(params.tag) ? params.tag : [params.tag];
      const validTags = tags.filter((t) => (ALL_TAG_SLUGS as string[]).includes(t));
      if (validTags.length > 0) {
        query = query.contains('tags', validTags);
      }
    }

    const { data: events, count, error } = await query;

    if (error) {
      console.error('[V1] Events list error:', error.message);
      throw createError('Failed to fetch events', 500, 'SERVER_ERROR');
    }

    // Visibility filtering: respect start_time_required semantics
    // - start_time_required=true: visible until start time
    // - start_time_required=false: visible until end_time (or start + 3h if no end)
    const now = new Date(today);
    const visible = ((events || []) as unknown as Record<string, unknown>[]).filter((row) => {
      const startTimeRequired = (row.start_time_required as boolean) ?? true;
      const eventAt = new Date(row.event_at as string);
      if (startTimeRequired) {
        return eventAt >= now;
      }
      // Open-window event: visible until end_time, or start + 3h fallback
      if (row.end_time) {
        return new Date(row.end_time as string) >= now;
      }
      const fallback = new Date(eventAt.getTime() + 3 * 60 * 60 * 1000);
      return fallback >= now;
    });

    // Optionally deduplicate series: keep only the nearest upcoming instance per series_id.
    // Default returns all instances; consumers opt in with ?collapse_series=true for browse feeds.
    const results = collapseSeries ? deduplicateSeries(visible) : visible;
    const page = results.slice(0, params.limit);

    res.json({
      meta: {
        // When collapsing series, total is approximate (dedup reduces it unpredictably)
        total: collapseSeries ? results.length : (count || 0),
        limit: params.limit,
        offset: params.offset,
        spec: 'neighborhood-api-v0.2',
        license: 'CC-BY-4.0',
      },
      events: page.map((e) => toNeighborhoodEvent(e as unknown as PortalEventRow)),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/terms', (_req, res) => {
  res.json({
    version: '2.0',
    summary: 'Neighborhood event data, free to use under CC BY 4.0.',
    license: {
      name: 'Creative Commons Attribution 4.0 International',
      spdx: 'CC-BY-4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/',
    },
    guidelines: [
      'Attribution: Credit "Neighborhood Commons" or link to this API.',
      'No surveillance: Don\'t use this data for ad targeting, behavioral profiling, or user tracking.',
      'Building products with this data is encouraged.',
    ],
    rate_limit: '1000 requests/hour per IP. Use X-API-Key header for a dedicated rate limit bucket.',
    contact: 'hello@joinfiber.app',
  });
});

/**
 * GET /api/v1/events/:id
 * Single event in Neighborhood API format.
 */
router.get('/:id', async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const id = req.params.id;

    const { data: event, error } = await supabaseAdmin
      .from('events')
      .select('id, content, description, place_name, venue_address, place_id, latitude, longitude, event_at, end_time, event_timezone, category, custom_category, recurrence, price, link_url, event_image_url, created_at, creator_account_id, series_id, series_instance_number, start_time_required, tags, wheelchair_accessible, runtime_minutes, content_rating, showtimes, source_method, source_publisher, portal_accounts!events_creator_account_id_fkey(business_name, wheelchair_accessible)')
      .eq('id', id)
      .eq('status', 'published')
      .maybeSingle();

    if (error) {
      console.error('[V1] Event fetch error:', error.message);
      throw createError('Failed to fetch event', 500, 'SERVER_ERROR');
    }

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const transformed = toNeighborhoodEvent(event as unknown as PortalEventRow);

    // For series events, look up the instance count to produce a bounded RRULE
    const row = event as unknown as Record<string, unknown>;
    if (row.series_id && transformed.recurrence) {
      const { count: instanceCount } = await supabaseAdmin
        .from('events')
        .select('id', { count: 'exact', head: true })
        .eq('series_id', row.series_id as string);
      if (instanceCount && instanceCount > 0) {
        transformed.series_instance_count = instanceCount;
        const rrule = toRRule(row.recurrence as string, instanceCount);
        if (rrule) transformed.recurrence = { rrule };
      }
    }

    res.json({ event: transformed });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// ICAL + RSS FEED HANDLERS
// =============================================================================

/** Format event_at as iCal datetime in the given timezone: 20260314T190000 */
function toICalDate(eventAt: string, timezone: string): string {
  const d = new Date(eventAt);
  const dateStr = d.toLocaleDateString('en-CA', { timeZone: timezone }).replace(/-/g, '');
  const timeStr = d.toLocaleTimeString('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/:/g, '');
  return `${dateStr}T${timeStr}`;
}

/**
 * Build a VTIMEZONE block for an IANA timezone by probing the Intl API for
 * UTC offset transitions within a given year. If the timezone observes DST,
 * emits both STANDARD and DAYLIGHT sub-components with the transition dates.
 * If no transitions are found (e.g., America/Phoenix), emits STANDARD only.
 */
function buildVTimezone(tzid: string, year: number): string[] {
  // Probe the 1st and 15th of each month to find offset transitions
  type OffsetInfo = { offset: number; abbr: string; date: Date };
  const probes: OffsetInfo[] = [];
  for (let m = 0; m < 12; m++) {
    for (const day of [1, 15]) {
      const d = new Date(Date.UTC(year, m, day, 12, 0, 0));
      probes.push({ offset: getUtcOffset(d, tzid), abbr: getOffsetAbbr(d, tzid), date: d });
    }
  }

  // Find transitions: where offset changes between consecutive probes
  const transitions: { from: OffsetInfo; to: OffsetInfo }[] = [];
  for (let i = 1; i < probes.length; i++) {
    if ((probes[i] as OffsetInfo).offset !== (probes[i - 1] as OffsetInfo).offset) {
      transitions.push({ from: probes[i - 1] as OffsetInfo, to: probes[i] as OffsetInfo });
    }
  }

  const lines: string[] = ['BEGIN:VTIMEZONE', `TZID:${tzid}`];

  if (transitions.length === 0) {
    // No DST — emit a single STANDARD component
    const info = probes[0] as OffsetInfo;
    lines.push('BEGIN:STANDARD');
    lines.push(`DTSTART:${year}0101T000000`);
    lines.push(`TZOFFSETFROM:${formatICalOffset(info.offset)}`);
    lines.push(`TZOFFSETTO:${formatICalOffset(info.offset)}`);
    lines.push(`TZNAME:${info.abbr}`);
    lines.push('END:STANDARD');
  } else {
    // Binary-search for the exact transition date between each pair
    for (const { from, to } of transitions) {
      const transDate = findTransitionDate(from.date, to.date, tzid);
      const isDaylight = to.offset > from.offset;
      const component = isDaylight ? 'DAYLIGHT' : 'STANDARD';
      lines.push(`BEGIN:${component}`);
      lines.push(`DTSTART:${formatICalLocalDate(transDate, tzid)}`);
      lines.push(`TZOFFSETFROM:${formatICalOffset(from.offset)}`);
      lines.push(`TZOFFSETTO:${formatICalOffset(to.offset)}`);
      lines.push(`TZNAME:${to.abbr}`);
      lines.push(`END:${component}`);
    }
  }

  lines.push('END:VTIMEZONE');
  return lines;
}

/** Get UTC offset in minutes for a Date in a given timezone */
function getUtcOffset(date: Date, timezone: string): number {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone: timezone });
  return (new Date(tzStr).getTime() - new Date(utcStr).getTime()) / 60000;
}

/** Get short timezone abbreviation (e.g., EST, EDT) */
function getOffsetAbbr(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' }).formatToParts(date);
  return parts.find(p => p.type === 'timeZoneName')?.value || timezone;
}

/** Binary-search for the exact hour a timezone transition occurs */
function findTransitionDate(before: Date, after: Date, timezone: string): Date {
  let lo = before.getTime();
  let hi = after.getTime();
  const targetOffset = getUtcOffset(after, timezone);
  // Narrow to within 1 hour
  while (hi - lo > 3600000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const midDate = new Date(mid);
    if (getUtcOffset(midDate, timezone) === targetOffset) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return new Date(hi);
}

/** Format offset in minutes as iCal offset string: +0500, -0430 */
function formatICalOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60).toString().padStart(2, '0');
  const m = (abs % 60).toString().padStart(2, '0');
  return `${sign}${h}${m}`;
}

/** Format a Date as iCal local datetime in a given timezone: 20260309T020000 */
function formatICalLocalDate(date: Date, timezone: string): string {
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: timezone }).replace(/-/g, '');
  const timeStr = date.toLocaleTimeString('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).replace(/:/g, '');
  return `${dateStr}T${timeStr}`;
}

/** Escape special characters for iCal text values */
function escapeICalText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** Escape special characters for XML/RSS */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const EVENTS_SELECT = 'id, content, description, place_name, venue_address, place_id, latitude, longitude, event_at, end_time, event_timezone, category, custom_category, recurrence, price, link_url, event_image_url, created_at, creator_account_id, series_id, series_instance_number, start_time_required, tags, wheelchair_accessible, runtime_minutes, content_rating, showtimes, source_method, source_publisher, portal_accounts!events_creator_account_id_fkey(business_name, wheelchair_accessible)';

/** Deduplicate series events: keep only the nearest upcoming instance per series_id. */
function deduplicateSeries(events: Record<string, unknown>[]): Record<string, unknown>[] {
  const seenSeries = new Set<string>();
  const deduped: Record<string, unknown>[] = [];
  for (const row of events) {
    const seriesId = row.series_id as string | null;
    if (seriesId) {
      if (seenSeries.has(seriesId)) continue;
      seenSeries.add(seriesId);
    }
    deduped.push(row);
  }
  return deduped;
}

/**
 * GET /api/v1/events.ics
 * iCalendar feed of upcoming events.
 */
export async function icsHandler(_req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): Promise<void> {
  try {
    const { data: events, error } = await supabaseAdmin
      .from('events')
      .select(EVENTS_SELECT)
      .eq('status', 'published')
      .gte('event_at', new Date().toISOString())
      .order('event_at', { ascending: true })
      .limit(200);

    if (error) throw createError('Failed to fetch events', 500, 'SERVER_ERROR');

    const deduped = deduplicateSeries((events || []) as unknown as Record<string, unknown>[]);

    // Collect unique timezones to emit VTIMEZONE blocks (RFC 5545 §3.6.5)
    const timezones = new Set<string>();
    for (const row of deduped) {
      timezones.add((row.event_timezone as string) || 'America/New_York');
    }

    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Neighborhood Commons//Events//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Neighborhood Commons Events',
    ];

    // Emit VTIMEZONE for each referenced timezone
    const year = new Date().getFullYear();
    for (const tz of timezones) {
      lines.push(...buildVTimezone(tz, year));
    }

    for (const row of deduped) {
      const tz = (row.event_timezone as string) || 'America/New_York';
      const dtStart = toICalDate(row.event_at as string, tz);
      const dtEnd = row.end_time ? toICalDate(row.end_time as string, tz) : null;

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${row.id}@commons.joinfiber.app`);
      lines.push(`DTSTART;TZID=${tz}:${dtStart}`);
      if (dtEnd) lines.push(`DTEND;TZID=${tz}:${dtEnd}`);
      lines.push(`SUMMARY:${escapeICalText(row.content as string)}`);
      if (row.description) lines.push(`DESCRIPTION:${escapeICalText(row.description as string)}`);
      if (row.place_name) {
        const location = (row.place_name as string) + ((row.venue_address as string | null) ? ', ' + row.venue_address : '');
        lines.push(`LOCATION:${escapeICalText(location)}`);
      }
      if (row.link_url) lines.push(`URL:${row.link_url}`);
      if (row.latitude != null && row.longitude != null) {
        lines.push(`GEO:${row.latitude};${row.longitude}`);
      }
      const rrule = toRRule((row.recurrence as string) || 'none');
      if (rrule) lines.push(`RRULE:${rrule}`);
      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="neighborhood-commons-events.ics"');
    res.send(lines.join('\r\n'));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/events.rss
 * RSS 2.0 feed of upcoming events.
 */
export async function rssHandler(_req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): Promise<void> {
  try {
    const { data: events, error } = await supabaseAdmin
      .from('events')
      .select(EVENTS_SELECT)
      .eq('status', 'published')
      .gte('event_at', new Date().toISOString())
      .order('event_at', { ascending: true })
      .limit(50);

    if (error) throw createError('Failed to fetch events', 500, 'SERVER_ERROR');

    const deduped = deduplicateSeries((events || []) as unknown as Record<string, unknown>[]);
    const baseUrl = 'https://commons.joinfiber.app';

    const items = deduped.map((row) => {
      const ev = toNeighborhoodEvent(row as unknown as PortalEventRow);
      return `    <item>
      <title>${escapeXml(ev.name)}</title>
      <description><![CDATA[${(ev.description || '').replace(/]]>/g, ']]]]><![CDATA[>')}]]></description>
      <link>${baseUrl}/api/v1/events/${ev.id}</link>
      <guid isPermaLink="false">${ev.id}</guid>
      <pubDate>${new Date(ev.start).toUTCString()}</pubDate>
      <category>${escapeXml(ev.category.join(', '))}</category>
    </item>`;
    }).join('\n');

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Neighborhood Commons Events</title>
    <link>${baseUrl}/api/v1/events</link>
    <description>Open neighborhood event data. CC BY 4.0.</description>
    <language>en-us</language>
    <atom:link href="${baseUrl}/api/v1/events.rss" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;

    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(rss);
  } catch (err) {
    next(err);
  }
}

export default router;
