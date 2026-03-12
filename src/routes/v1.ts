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
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest } from '../lib/helpers.js';
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
  message: { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded (1000/hr). Contact hello@joinfiber.app if you need more.' } },
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
  q: z.string().max(200).optional(),
  near: z.string().regex(/^-?\d+\.?\d*,-?\d+\.?\d*$/).optional(),
  radius_km: z.coerce.number().min(0.1).max(100).optional(),
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

    // Over-fetch to compensate for series dedup reducing the result set.
    // Series events sharing the same series_id collapse to one entry.
    const fetchLimit = params.limit * 3;

    let query = supabaseAdmin
      .from('events')
      .select('id, content, description, place_name, venue_address, place_id, latitude, longitude, event_at, end_time, event_timezone, category, custom_category, recurrence, price, link_url, event_image_url, created_at, creator_account_id, series_id, portal_accounts!events_creator_account_id_fkey(business_name), event_series!events_series_id_fkey(recurrence)', { count: 'exact' })
      .eq('source', 'portal')
      .eq('status', 'published')
      .gte('event_at', today) // Only future/today events
      .order('event_at', { ascending: true })
      .range(params.offset, params.offset + fetchLimit - 1);

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
      const sanitized = params.q.replace(/[,.()"\\%_]/g, ' ').trim();
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

    const { data: events, count, error } = await query;

    if (error) {
      console.error('[V1] Events list error:', error.message);
      throw createError('Failed to fetch events', 500, 'SERVER_ERROR');
    }

    // Deduplicate series: keep only the nearest upcoming instance per series_id
    const deduped = deduplicateSeries((events || []) as unknown as Record<string, unknown>[]);
    const page = deduped.slice(0, params.limit);

    res.json({
      meta: {
        total: count || 0,
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
    const id = req.params.id;

    const { data: event, error } = await supabaseAdmin
      .from('events')
      .select('id, content, description, place_name, venue_address, place_id, latitude, longitude, event_at, end_time, event_timezone, category, custom_category, recurrence, price, link_url, event_image_url, created_at, creator_account_id, portal_accounts!events_creator_account_id_fkey(business_name)')
      .eq('id', id)
      .eq('source', 'portal')
      .eq('status', 'published')
      .maybeSingle();

    if (error) {
      console.error('[V1] Event fetch error:', error.message);
      throw createError('Failed to fetch event', 500, 'SERVER_ERROR');
    }

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    res.json({ event: toNeighborhoodEvent(event as unknown as PortalEventRow) });
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

/** Escape special characters for iCal text values */
function escapeICalText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** Escape special characters for XML/RSS */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const EVENTS_SELECT = 'id, content, description, place_name, venue_address, place_id, latitude, longitude, event_at, end_time, event_timezone, category, custom_category, recurrence, price, link_url, event_image_url, created_at, creator_account_id, series_id, portal_accounts!events_creator_account_id_fkey(business_name), event_series!events_series_id_fkey(recurrence)';

/** Deduplicate series events: keep only the nearest upcoming instance per series_id.
 *  Carries the series recurrence pattern onto the kept instance. */
function deduplicateSeries(events: Record<string, unknown>[]): Record<string, unknown>[] {
  const seenSeries = new Set<string>();
  const deduped: Record<string, unknown>[] = [];
  for (const row of events) {
    const seriesId = row.series_id as string | null;
    if (seriesId) {
      if (seenSeries.has(seriesId)) continue;
      seenSeries.add(seriesId);
      const seriesData = row.event_series as Record<string, unknown> | null;
      if (seriesData?.recurrence && seriesData.recurrence !== 'none') {
        row.recurrence = seriesData.recurrence;
      }
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
      .eq('source', 'portal')
      .eq('status', 'published')
      .gte('event_at', new Date().toISOString())
      .order('event_at', { ascending: true })
      .limit(200);

    if (error) throw createError('Failed to fetch events', 500, 'SERVER_ERROR');

    const deduped = deduplicateSeries((events || []) as unknown as Record<string, unknown>[]);

    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Neighborhood Commons//Events//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Neighborhood Commons Events',
    ];

    for (const row of deduped) {
      const tz = (row.event_timezone as string) || 'America/New_York';
      const dtStart = toICalDate(row.event_at as string, tz);
      const dtEnd = row.end_time ? toICalDate(row.end_time as string, tz) : null;

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${row.id}@neighborhoodcommons.org`);
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
      .eq('source', 'portal')
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
      <description>${escapeXml(ev.description || '')}</description>
      <link>${baseUrl}/api/v1/events/${ev.id}</link>
      <guid isPermaLink="false">${ev.id}</guid>
      <pubDate>${new Date(ev.start).toUTCString()}</pubDate>
      <category>${ev.category.join(', ')}</category>
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
