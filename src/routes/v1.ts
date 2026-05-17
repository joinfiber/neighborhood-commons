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
import { validateRequest, validateUuidParam, sanitizeSearchInput } from '../lib/helpers.js';
import { toNeighborhoodEvent, toRRule, type PortalEventRow } from '../lib/event-transform.js';
import { hydrateVerificationsFor } from '../lib/verification-hydrate.js';
import { optionalApiKey } from '../middleware/api-key.js';
import { icsEscape, icsSafeUrl } from '../lib/ical.js';

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
  group_id: z.string().uuid().optional(),
  recurring: z.enum(['true', 'false']).optional(),
  contributor: z.string().max(200).optional(),
  tmdb_id: z.string().max(50).optional(),
  // first_party=true   → only events posted by the verified business itself
  // first_party=false  → only events aggregated from public sources (scrapers, feeds)
  // (omitted)          → both tiers, no filter applied
  first_party: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

// v2: organizer derives from the organizations join via organizer_org_id.
// The nested portal_accounts (via organizations.owner_account_id) is for the
// suspended-status visibility check; it's not exposed in the public response.
const EVENTS_SELECT = 'id, content, description, place_name, venue_address, place_id, latitude, longitude, event_at, end_time, event_timezone, category, custom_category, recurrence, price, link_url, event_image_url, event_image_focal_y, created_at, creator_account_id, series_id, series_instance_number, open_window, capacity, rsvp, tags, wheelchair_accessible, first_party, source_method, source_publisher, source_contributor_name, source_contributor_url, tmdb_id, organizer_org_id, organizations!events_organizer_org_id_fkey(id, slug, name, portal_accounts!organizations_owner_account_id_fkey(status))';

// =============================================================================
// SHARED QUERY BUILDING
// =============================================================================

type ListParams = z.infer<typeof listSchema>;

/**
 * Resolve a contributor slug to account ID(s). Returns null if no match.
 * Looks up portal_accounts by slug (exact match, case-insensitive).
 */
async function resolveContributorAccountIds(slug: string): Promise<string[] | null> {
  const { data } = await supabaseAdmin
    .from('portal_accounts')
    .select('id')
    .eq('slug', slug.toLowerCase())
    .eq('status', 'active');
  if (!data || data.length === 0) return null;
  return data.map((r: { id: string }) => r.id);
}

/**
 * Build and execute an event query with all standard filters applied.
 * Shared across JSON, iCal, and RSS endpoints.
 */
async function queryFilteredEvents(params: ListParams, opts?: {
  /** Skip the 3h lookback and visibility filter (for feeds with explicit date windows) */
  skipVisibility?: boolean;
  /** Override the default cutoff for event_at (ISO string) */
  cutoffOverride?: string;
  /** Include total count in response */
  includeCount?: boolean;
  /** Override fetch limit (e.g., for series dedup over-fetch) */
  fetchLimit?: number;
}): Promise<{ events: Record<string, unknown>[]; count: number | null }> {
  const includeCount = opts?.includeCount ?? false;
  const fetchLimit = opts?.fetchLimit ?? params.limit;

  // Default cutoff: 3h lookback for open-window events
  const lookbackMs = 3 * 60 * 60 * 1000;
  const defaultCutoff = new Date(Date.now() - lookbackMs).toISOString();
  const cutoff = opts?.cutoffOverride ?? defaultCutoff;

  // Contributor filter: resolve slug → account IDs before building query
  let contributorAccountIds: string[] | null = null;
  if (params.contributor) {
    contributorAccountIds = await resolveContributorAccountIds(params.contributor);
    if (!contributorAccountIds) {
      // No matching account — return empty result
      return { events: [], count: 0 };
    }
  }

  let query = supabaseAdmin
    .from('events')
    .select(EVENTS_SELECT, includeCount ? { count: 'exact' } : undefined)
    .eq('status', 'published')
    .gte('event_at', cutoff)
    .order('event_at', { ascending: true })
    .range(params.offset, params.offset + fetchLimit - 1);

  // Contributor filter
  if (contributorAccountIds) {
    if (contributorAccountIds.length === 1) {
      query = query.eq('creator_account_id', contributorAccountIds[0] as string);
    } else {
      query = query.in('creator_account_id', contributorAccountIds);
    }
  }

  // Series filter
  if (params.series_id) {
    query = query.eq('series_id', params.series_id);
  }

  // Group filter
  if (params.group_id) {
    query = query.eq('group_id', params.group_id);
  }

  // Recurring filter
  if (params.recurring === 'true') {
    query = query.neq('recurrence', 'none');
  } else if (params.recurring === 'false') {
    query = query.eq('recurrence', 'none');
  }

  // TMDB film filter (cluster all showings of a single film across theaters/dates)
  if (params.tmdb_id) {
    query = query.eq('tmdb_id', params.tmdb_id);
  }

  // First-party filter — distinguishes information posted BY the business
  // itself (after they verified) from public-facts information aggregated
  // about them by scrapers, feeds, and ingestion pipelines. SQL-level so
  // meta.total reflects the filtered count.
  if (params.first_party === 'true') {
    query = query.eq('first_party', true);
  } else if (params.first_party === 'false') {
    query = query.eq('first_party', false);
  }

  // Date range filters
  if (params.start_after) {
    query = query.gte('event_at', params.start_after + 'T00:00:00Z');
  }
  if (params.start_before) {
    query = query.lte('event_at', params.start_before + 'T23:59:59Z');
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
    const sanitized = sanitizeSearchInput(params.q);
    if (sanitized) {
      query = query.or(`content.ilike.%${sanitized}%,description.ilike.%${sanitized}%`);
    }
  }

  // Geo filtering (bounding-box approximation)
  if (params.near) {
    const [lat, lng] = params.near.split(',').map(Number);
    if (lat !== undefined && lng !== undefined && !isNaN(lat) && !isNaN(lng)) {
      const radiusKm = params.radius_km || 10;
      const KM_PER_DEGREE_LATITUDE = 111;
      const latDelta = radiusKm / KM_PER_DEGREE_LATITUDE;
      const lngDelta = radiusKm / (KM_PER_DEGREE_LATITUDE * Math.cos(lat * Math.PI / 180));

      query = query
        .not('latitude', 'is', null)
        .gte('latitude', lat - latDelta)
        .lte('latitude', lat + latDelta)
        .gte('longitude', lng - lngDelta)
        .lte('longitude', lng + lngDelta);
    }
  }

  // Tag filtering (AND semantics)
  if (params.tag) {
    const tags = Array.isArray(params.tag) ? params.tag : [params.tag];
    const validTags = tags.filter((t) => (ALL_TAG_SLUGS as string[]).includes(t));
    if (validTags.length > 0) {
      query = query.contains('tags', validTags);
    }
  }

  const { data: events, count, error } = await query;

  if (error) {
    console.error('[V1] Events query error:', error.message);
    throw createError('Failed to fetch events', 500, 'SERVER_ERROR');
  }

  const rows = (events || []) as unknown as Record<string, unknown>[];

  // Visibility filtering (unless explicitly skipped)
  if (opts?.skipVisibility) {
    // Still filter out suspended accounts (via organizations.owner_account_id chain)
    const active = rows.filter((row) => {
      const org = row.organizations as Record<string, unknown> | null;
      const account = org?.portal_accounts as Record<string, unknown> | null;
      return !account || account.status !== 'suspended';
    });
    return { events: active, count: count ?? null };
  }

  const OPEN_WINDOW_DEFAULT_HOURS = 3;
  const now = new Date();
  const visible = rows.filter((row) => {
    // v2: suspended-status check traverses organizations.owner_account_id → portal_accounts.status.
    // Organizations with no owning portal account (e.g., admin-created via Studio) skip the check.
    const org = row.organizations as Record<string, unknown> | null;
    const account = org?.portal_accounts as Record<string, unknown> | null;
    if (account && account.status === 'suspended') return false;

    const openWindow = (row.open_window as boolean) ?? false;
    const eventAt = new Date(row.event_at as string);
    if (!openWindow) {
      return eventAt >= now;
    }
    if (row.end_time) {
      return new Date(row.end_time as string) >= now;
    }
    const fallback = new Date(eventAt.getTime() + OPEN_WINDOW_DEFAULT_HOURS * 60 * 60 * 1000);
    return fallback >= now;
  });

  return { events: visible, count: count ?? null };
}

/** Build a human-readable feed title from active filters */
function buildFeedTitle(params: ListParams): string {
  const parts: string[] = [];
  if (params.contributor) parts.push(`by ${params.contributor}`);
  if (params.category) parts.push(params.category.replace(/-/g, ' '));
  if (params.tag) {
    const tags = Array.isArray(params.tag) ? params.tag : [params.tag];
    parts.push(tags.join(', '));
  }
  if (params.q) parts.push(`"${params.q}"`);
  if (parts.length === 0) return 'Neighborhood Commons Events';
  return `Neighborhood Commons: ${parts.join(' · ')}`;
}

/**
 * GET /api/v1/events
 * List published events. Paginated, filtered.
 */
router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(listSchema, req.query);
    const collapseSeries = params.collapse_series === 'true';

    // When collapsing series, over-fetch to compensate for dedup reducing the result set.
    const fetchLimit = collapseSeries ? params.limit * 5 : params.limit;

    const { events: visible, count } = await queryFilteredEvents(params, {
      includeCount: true,
      fetchLimit,
    });

    // Optionally deduplicate series: keep only the nearest upcoming instance per series_id.
    const results = collapseSeries ? deduplicateSeries(visible) : visible;
    const page = results.slice(0, params.limit);

    // Hydrate series_instance_count: one grouped count query for all series_ids
    // in this page, rather than N per-event lookups or always-null.
    const seriesIds = Array.from(new Set(
      page.map((e) => (e as unknown as { series_id?: string | null }).series_id).filter(Boolean) as string[],
    ));
    const seriesCounts = new Map<string, number>();
    if (seriesIds.length > 0) {
      const { data: counts } = await supabaseAdmin
        .from('events')
        .select('series_id')
        .in('series_id', seriesIds);
      for (const row of counts || []) {
        const sid = (row as { series_id: string }).series_id;
        seriesCounts.set(sid, (seriesCounts.get(sid) || 0) + 1);
      }
    }

    // v2: hydrate verifications for the organizer organizations in one query
    // so the response includes organizer.verified for each event.
    const organizerOrgIds = Array.from(new Set(
      page.map((e) => (e as unknown as PortalEventRow).organizer_org_id).filter(Boolean) as string[]
    ));
    const verifications = await hydrateVerificationsFor(organizerOrgIds);
    const verifiedOrgIds = new Set(verifications.keys());

    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      meta: {
        // When collapsing series, total is unknown (dedup happens post-fetch)
        total: collapseSeries ? null : (count || 0),
        limit: params.limit,
        offset: params.offset,
        spec: 'neighborhood-api-v0.2',
        license: 'CC-BY-4.0',
      },
      events: page.map((e) => {
        const transformed = toNeighborhoodEvent(e as unknown as PortalEventRow, verifiedOrgIds);
        const row = e as unknown as { series_id?: string | null; recurrence?: string | null };
        if (row.series_id && transformed.recurrence) {
          const ic = seriesCounts.get(row.series_id);
          if (ic && ic > 0) {
            transformed.series_instance_count = ic;
            const rrule = toRRule(row.recurrence as string, ic);
            if (rrule) transformed.recurrence = { rrule };
          }
        }
        return transformed;
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/terms', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
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
    contact: 'hi@neighborhood-commons.org',
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
      .select(EVENTS_SELECT)
      .eq('id', id)
      .eq('status', 'published')
      .maybeSingle();

    if (error) {
      console.error('[V1] Event fetch error:', error.message);
      throw createError('Failed to fetch event', 500, 'SERVER_ERROR');
    }

    // Exclude events from suspended accounts — don't leak existence
    // (suspended status lives on portal_accounts via organizations.owner_account_id)
    const orgRow = (event as unknown as Record<string, unknown>)?.organizations as Record<string, unknown> | null;
    const account = orgRow?.portal_accounts as Record<string, unknown> | null;
    if (!event || (account && account.status === 'suspended')) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    // v2: hydrate verification for this organizer (one lookup; cheap)
    const eventRow = event as unknown as PortalEventRow;
    const orgId = eventRow.organizer_org_id;
    const verifications = orgId ? await hydrateVerificationsFor([orgId]) : new Map();
    const verifiedOrgIds = new Set(verifications.keys());

    const transformed = toNeighborhoodEvent(eventRow, verifiedOrgIds);

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

    res.set('Cache-Control', 'public, max-age=60');
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

// escapeICalText moved to src/lib/ical.ts (icsEscape) so all three ICS output
// sites share one escape policy. Kept as a local alias for diff readability.
const escapeICalText = icsEscape;

/** Escape special characters for XML/RSS */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

// Schema for feed endpoints: same filters as list, but different defaults.
// iCal defaults to a 30-day lookback and 90-day lookahead window.
// RSS defaults to 50 items with standard pagination.
const feedSchema = listSchema.extend({
  limit: z.coerce.number().min(1).max(500).default(200),
});

/**
 * GET /api/v1/events.ics
 * iCalendar feed of upcoming events. Accepts the same query filters as the
 * JSON events endpoint: contributor, category, tag, q, near, series_id, etc.
 *
 * Default window: 30 days ago through 90 days ahead. Override with start_after/start_before.
 * Always deduplicates series (one VEVENT with RRULE per series).
 */
export async function icsHandler(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): Promise<void> {
  try {
    const params = validateRequest(feedSchema, req.query);

    // Default time window for iCal: -30 days to +90 days (keeps file size manageable)
    const now = new Date();
    if (!params.start_after) {
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      params.start_after = thirtyDaysAgo.toISOString().slice(0, 10);
    }
    if (!params.start_before) {
      const ninetyDaysAhead = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      params.start_before = ninetyDaysAhead.toISOString().slice(0, 10);
    }

    // Use the start_after as cutoff instead of the default 3h lookback
    const cutoff = params.start_after + 'T00:00:00Z';

    const { events } = await queryFilteredEvents(params, {
      cutoffOverride: cutoff,
      fetchLimit: params.limit,
    });

    const deduped = deduplicateSeries(events);

    // Collect unique timezones to emit VTIMEZONE blocks (RFC 5545 §3.6.5)
    const timezones = new Set<string>();
    for (const row of deduped) {
      timezones.add((row.event_timezone as string) || 'America/New_York');
    }

    const feedTitle = buildFeedTitle(params);
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Neighborhood Commons//Events//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeICalText(feedTitle)}`,
    ];

    // Emit VTIMEZONE for each referenced timezone
    const year = now.getFullYear();
    for (const tz of timezones) {
      lines.push(...buildVTimezone(tz, year));
    }

    for (const row of deduped) {
      const tz = (row.event_timezone as string) || 'America/New_York';
      const dtStart = toICalDate(row.event_at as string, tz);
      const dtEnd = row.end_time ? toICalDate(row.end_time as string, tz) : null;

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${row.id}@neighborhood-commons.org`);
      lines.push(`DTSTAMP:${toICalDate(row.created_at as string || now.toISOString(), 'UTC')}Z`);
      lines.push(`DTSTART;TZID=${tz}:${dtStart}`);
      if (dtEnd) lines.push(`DTEND;TZID=${tz}:${dtEnd}`);
      lines.push(`SUMMARY:${escapeICalText(row.content as string)}`);
      if (row.description) lines.push(`DESCRIPTION:${escapeICalText(row.description as string)}`);
      if (row.place_name) {
        const location = (row.place_name as string) + ((row.venue_address as string | null) ? ', ' + row.venue_address : '');
        lines.push(`LOCATION:${escapeICalText(location)}`);
      }
      const safeUrl = icsSafeUrl(row.link_url as string | null);
      if (safeUrl) lines.push(`URL:${safeUrl}`);
      if (row.latitude != null && row.longitude != null) {
        lines.push(`GEO:${row.latitude};${row.longitude}`);
      }
      const rrule = toRRule((row.recurrence as string) || 'none');
      if (rrule) lines.push(`RRULE:${rrule}`);
      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');

    // Stable filename reflecting the filter scope
    const fileSlug = params.contributor || params.category || 'neighborhood-commons';
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileSlug}-events.ics"`);
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.send(lines.join('\r\n'));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/events.rss
 * RSS 2.0 feed of upcoming events. Accepts the same query filters as the
 * JSON events endpoint: contributor, category, tag, q, near, series_id, etc.
 *
 * Supports pagination via limit/offset. Default limit: 50.
 * Always deduplicates series.
 */
export async function rssHandler(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): Promise<void> {
  try {
    const params = validateRequest(listSchema, req.query);

    const { events: visible } = await queryFilteredEvents(params, {
      // Over-fetch to compensate for series dedup
      fetchLimit: params.limit * 3,
    });

    const deduped = deduplicateSeries(visible);
    const page = deduped.slice(0, params.limit);
    const baseUrl = 'https://neighborhood-commons.org';
    const feedTitle = buildFeedTitle(params);

    // Build the self-referencing URL with query params preserved
    const selfQuery = new URLSearchParams();
    if (params.contributor) selfQuery.set('contributor', params.contributor);
    if (params.category) selfQuery.set('category', params.category);
    if (params.tag) {
      const tags = Array.isArray(params.tag) ? params.tag : [params.tag];
      for (const t of tags) selfQuery.set('tag', t);
    }
    if (params.q) selfQuery.set('q', params.q);
    if (params.near) selfQuery.set('near', params.near);
    if (params.group_id) selfQuery.set('group_id', params.group_id);
    const selfUrl = `${baseUrl}/api/v1/events.rss${selfQuery.toString() ? '?' + selfQuery.toString() : ''}`;

    const items = page.map((row) => {
      const ev = toNeighborhoodEvent(row as unknown as PortalEventRow);
      const locationText = ev.location?.name
        ? (ev.location.address ? `${ev.location.name}, ${ev.location.address}` : ev.location.name)
        : '';
      return `    <item>
      <title>${escapeXml(ev.name)}</title>
      <description><![CDATA[${formatRssDescription(ev, locationText)}]]></description>
      <link>${baseUrl}/api/v1/events/${ev.id}</link>
      <guid isPermaLink="false">${ev.id}</guid>
      <pubDate>${new Date(ev.start).toUTCString()}</pubDate>
      <category>${escapeXml(ev.category.join(', '))}</category>
    </item>`;
    }).join('\n');

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(feedTitle)}</title>
    <link>${baseUrl}/api/v1/events</link>
    <description>Open neighborhood event data. CC BY 4.0.</description>
    <language>en-us</language>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;

    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.send(rss);
  } catch (err) {
    next(err);
  }
}

/** Format a richer RSS description with location and time context */
function formatRssDescription(ev: ReturnType<typeof toNeighborhoodEvent>, locationText: string): string {
  const parts: string[] = [];
  if (locationText) parts.push(locationText);
  if (ev.cost) parts.push(ev.cost);
  if (ev.description) parts.push(ev.description);
  const text = parts.join(' — ');
  // Escape CDATA end sequence
  return text.replace(/]]>/g, ']]]]><![CDATA[>');
}

export default router;
