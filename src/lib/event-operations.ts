/**
 * Event Operations — Neighborhood Commons
 *
 * Shared business logic for event data transformations, timestamp handling,
 * and recurrence date generation. Used by portal routes, admin routes, and
 * any future user-type routes (curators, event apps, creator suite).
 *
 * This module is the single source of truth for:
 * - Portal ↔ database field mapping
 * - Timestamp composition and decomposition
 * - Recurrence pattern expansion into concrete dates
 */

import { config } from '../config.js';
import { resolveEventImageUrl } from './helpers.js';
import { sanitizeUrl, checkApprovedDomain } from './url-sanitizer.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Columns to select when reading portal events from the events table */
export const PORTAL_SELECT = 'id, user_id, content, description, place_name, place_id, approximate_location, event_at, end_time, event_image_url, event_image_focal_y, link_url, category, custom_category, event_timezone, venue_address, recurrence, price, latitude, longitude, creator_account_id, source, visibility, status, is_business, region_id, series_id, series_instance_number, start_time_required, tags, wheelchair_accessible, rsvp_limit, runtime_minutes, content_rating, showtimes, source_method, source_publisher, source_feed_url, created_at';

/** Sources that represent account-managed events (portal-created, imported, or API-submitted). */
export const MANAGED_SOURCES = ['portal', 'import', 'api'] as const;

export const PORTAL_ACCOUNT_SELECT = 'id, email, business_name, auth_user_id, status, default_venue_name, default_place_id, default_address, default_latitude, default_longitude, website, phone, wheelchair_accessible, operating_hours, last_login_at, created_at, updated_at';

// =============================================================================
// ADMIN HELPERS
// =============================================================================

export function getAdminUserId(): string {
  const id = config.admin.userIds[0];
  if (!id) throw new Error('No admin user ID configured (COMMONS_ADMIN_USER_IDS)');
  return id;
}

// =============================================================================
// FORMAT CONVERSION
// =============================================================================

/** Build a timestamptz string from date + time + timezone */
export function toTimestamptz(date: string, time: string, timezone: string): string {
  const normalized = time.length === 5 ? `${time}:00` : time;
  return `${date} ${normalized} ${timezone}`;
}

/** Extract date (YYYY-MM-DD) and time (HH:MM) from a timestamptz in a given timezone */
export function fromTimestamptz(ts: string, timezone: string): { date: string; time: string } {
  const dt = new Date(ts);
  const date = dt.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD
  const time = dt.toLocaleTimeString('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return { date, time };
}

// =============================================================================
// EVENT TRANSFORMS
// =============================================================================

/**
 * Convert an events table row to portal-friendly response shape.
 * Portal frontend expects: title, venue_name, event_date, start_time, etc.
 */
export function toPortalEvent(row: Record<string, unknown>): Record<string, unknown> {
  const tz = (row.event_timezone as string) || 'America/New_York';
  const eventAt = row.event_at as string | null;
  const endTime = row.end_time as string | null;

  let eventDate: string | null = null;
  let startTime: string | null = null;
  let endTimeStr: string | null = null;

  if (eventAt) {
    const parsed = fromTimestamptz(eventAt, tz);
    eventDate = parsed.date;
    startTime = parsed.time;
  }
  if (endTime) {
    endTimeStr = fromTimestamptz(endTime, tz).time;
  }

  return {
    id: row.id,
    portal_account_id: row.creator_account_id,
    title: row.content,
    description: row.description,
    venue_name: row.place_name,
    address: row.venue_address,
    place_id: row.place_id,
    latitude: row.latitude,
    longitude: row.longitude,
    event_date: eventDate,
    start_time: startTime,
    end_time: endTimeStr,
    event_timezone: tz,
    category: row.category,
    custom_category: row.custom_category,
    recurrence: row.recurrence,
    price: row.price,
    ticket_url: row.link_url,
    image_url: resolveEventImageUrl(row.event_image_url as string | null, config.apiBaseUrl),
    image_focal_y: (row.event_image_focal_y as number) ?? 0.5,
    start_time_required: (row.start_time_required as boolean) ?? true,
    tags: (row.tags as string[]) || [],
    wheelchair_accessible: row.wheelchair_accessible ?? null,
    rsvp_limit: row.rsvp_limit ?? null,
    status: row.status,
    series_id: row.series_id,
    series_instance_number: row.series_instance_number,
    source_publisher: row.source_publisher ?? null,
    source_feed_url: row.source_feed_url ?? null,
    created_at: row.created_at,
  };
}

/**
 * Convert portal input (event_date + start_time) to events table insert payload.
 */
export function portalInputToInsert(
  data: {
    title: string;
    venue_name: string;
    address?: string | null | undefined;
    place_id?: string | null | undefined;
    latitude?: number | null | undefined;
    longitude?: number | null | undefined;
    event_date: string;
    start_time: string;
    end_time?: string | null | undefined;
    event_timezone?: string | undefined;
    category: string;
    custom_category?: string | null | undefined;
    recurrence?: string | undefined;
    description?: string | null | undefined;
    price?: string | null | undefined;
    ticket_url?: string | null | undefined;
    start_time_required?: boolean | undefined;
    tags?: string[] | undefined;
    wheelchair_accessible?: boolean | null | undefined;
    rsvp_limit?: number | null | undefined;
    image_focal_y?: number | undefined;
  },
  accountId: string,
  adminUserId: string,
  accountStatus: string = 'active',
): Record<string, unknown> {
  const tz = data.event_timezone || 'America/New_York';
  const eventAt = toTimestamptz(data.event_date, data.start_time, tz);
  let endTime: string | null = null;
  if (data.end_time) {
    endTime = toTimestamptz(data.event_date, data.end_time, tz);
    // If end_time is before start_time, the event spans midnight — use next day
    if (new Date(endTime) <= new Date(eventAt)) {
      const nextDay = new Date(data.event_date);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDateStr = nextDay.toISOString().split('T')[0]!;
      endTime = toTimestamptz(nextDateStr, data.end_time, tz);
    }
  }

  return {
    user_id: adminUserId,
    content: data.title,
    description: data.description || null,
    place_name: data.venue_name,
    venue_address: data.address || null,
    place_id: data.place_id || null,
    approximate_location:
      data.latitude != null && data.longitude != null
        ? `POINT(${data.longitude} ${data.latitude})`
        : null,
    latitude: data.latitude ?? null,
    longitude: data.longitude ?? null,
    event_at: eventAt,
    end_time: endTime,
    event_timezone: tz,
    category: data.category,
    custom_category: data.category === 'other' ? data.custom_category?.trim() : null,
    recurrence: data.recurrence || 'none',
    price: data.price || null,
    link_url: data.ticket_url ? (checkApprovedDomain(data.ticket_url), sanitizeUrl(data.ticket_url)) : null,
    start_time_required: data.start_time_required ?? true,
    tags: data.tags || [],
    wheelchair_accessible: data.wheelchair_accessible ?? null,
    rsvp_limit: data.rsvp_limit ?? null,
    event_image_focal_y: data.image_focal_y ?? 0.5,
    creator_account_id: accountId,
    source: 'portal',
    visibility: 'public',
    status: accountStatus === 'active' ? 'published' : 'pending_review',
    is_business: true,
    region_id: config.defaultRegionId,
  };
}

// =============================================================================
// RECURRING EVENT HELPERS
// =============================================================================

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

const DEFAULT_LIMITS: Record<string, number> = {
  daily: 180, weekly: 26, biweekly: 12, monthly: 6,
};
const DEFAULT_ORDINAL_LIMIT = 6;
const DEFAULT_WEEKLY_DAYS_LIMIT = 26; // ~6 months of specific-day events
const ONGOING_LIMITS: Record<string, number> = {
  daily: 180, weekly: 26, biweekly: 12, monthly: 12,
};
const ONGOING_ORDINAL_LIMIT = 12;
const ONGOING_WEEKLY_DAYS_LIMIT = 26; // ~6 months of specific-day events

const DAY_ABBR_TO_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Parse a weekly_days:mon,tue,wed pattern. Returns sorted day indices or null. */
function parseWeeklyDays(recurrence: string): number[] | null {
  const m = recurrence.match(/^weekly_days:([a-z,]+)$/);
  if (!m || !m[1]) return null;
  const days = m[1].split(',');
  const indices: number[] = [];
  for (const d of days) {
    const idx = DAY_ABBR_TO_INDEX[d];
    if (idx === undefined) return null;
    indices.push(idx);
  }
  return indices.sort((a, b) => a - b);
}

function getNthWeekdayOfMonth(year: number, month: number, dayOfWeek: number, n: number): Date | null {
  const first = new Date(year, month, 1, 12, 0, 0);
  const firstDay = first.getDay();
  const dateOfFirst = 1 + ((dayOfWeek - firstDay + 7) % 7);
  const target = dateOfFirst + (n - 1) * 7;
  const result = new Date(year, month, target, 12, 0, 0);
  if (result.getMonth() !== month) return null;
  return result;
}

export function formatDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`;
}

export function generateInstanceDates(startDate: string, recurrence: string, instanceCount?: number): string[] {
  if (recurrence === 'none') return [startDate];

  const start = new Date(startDate + 'T12:00:00');
  if (isNaN(start.getTime())) return [startDate];

  const dates: string[] = [startDate];

  function resolveLimit(defaultLimit: number, ongoingLimit: number): number {
    if (instanceCount !== undefined && instanceCount > 0) return instanceCount;
    if (instanceCount === 0) return ongoingLimit;
    return defaultLimit;
  }

  // weekly_days pattern: generate dates for specific days of the week
  // instanceCount means "weeks" for this pattern — multiply by days per week
  const weeklyDays = parseWeeklyDays(recurrence);
  if (weeklyDays) {
    const weeks = resolveLimit(DEFAULT_WEEKLY_DAYS_LIMIT, ONGOING_WEEKLY_DAYS_LIMIT);
    const totalEvents = weeks * weeklyDays.length;
    // Walk forward day by day, collecting dates that match the target days
    const cursor = new Date(start);
    cursor.setDate(cursor.getDate() + 1); // start from next day (startDate already included)
    const maxDays = weeks * 7 + 7; // safety bound
    let walked = 0;
    while (dates.length < totalEvents && walked < maxDays) {
      if (weeklyDays.includes(cursor.getDay())) {
        dates.push(formatDateStr(cursor));
      }
      cursor.setDate(cursor.getDate() + 1);
      walked++;
    }
    return dates;
  }

  const ordMatch = recurrence.match(/^ordinal_weekday:([1-5]):(\w+)$/);
  if (ordMatch && ordMatch[1] && ordMatch[2]) {
    const ordinal = parseInt(ordMatch[1], 10);
    const dayIdx = DAY_NAMES.indexOf(ordMatch[2] as typeof DAY_NAMES[number]);
    if (dayIdx < 0) return [startDate];

    const total = resolveLimit(DEFAULT_ORDINAL_LIMIT, ONGOING_ORDINAL_LIMIT);
    let month = start.getMonth();
    let year = start.getFullYear();

    for (let i = 0; i < total - 1; i++) {
      month++;
      if (month > 11) { month = 0; year++; }
      const d = getNthWeekdayOfMonth(year, month, dayIdx, ordinal);
      if (d) dates.push(formatDateStr(d));
    }
    return dates;
  }

  const total = resolveLimit(DEFAULT_LIMITS[recurrence] || 4, ONGOING_LIMITS[recurrence] || 12);
  const limit = total - 1;
  for (let i = 1; i <= limit; i++) {
    const d = new Date(start);
    switch (recurrence) {
      case 'daily':
        d.setDate(d.getDate() + i);
        break;
      case 'weekly':
        d.setDate(d.getDate() + i * 7);
        break;
      case 'biweekly':
        d.setDate(d.getDate() + i * 14);
        break;
      case 'monthly': {
        // Clamp to last day of target month to avoid overflow
        // (e.g., Jan 31 + 1 month → Feb 28, not March 3)
        const targetMonth = start.getMonth() + i;
        d.setDate(1); // avoid overflow during setMonth
        d.setMonth(targetMonth);
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(start.getDate(), lastDay));
        break;
      }
      default:
        return dates;
    }
    dates.push(formatDateStr(d));
  }
  return dates;
}
