/**
 * Portal Routes — Neighborhood Commons
 *
 * Business event portal CRUD — powers the portal React SPA.
 * Businesses authenticate via Supabase email OTP and manage events here.
 *
 * Auth model: Businesses self-register (status='pending', verified by admin)
 * or are admin-seeded (status='active'). When a business logs in,
 * /account/claim links their Supabase auth user to the portal account.
 * Events created by pending accounts have status='pending_review' and are
 * excluded from public feeds until the admin approves the account.
 *
 * Events write directly to the `events` table (source='portal').
 * No sync bridge — portal events ARE events.
 */

import { Router, json as expressJson } from 'express';
import { z } from 'zod';
import sharp from 'sharp';
import { EVENT_CATEGORY_KEYS } from '../lib/categories.js';
import { validateTags } from '../lib/tags.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { requirePortalAuth } from '../middleware/auth.js';
import { validateRequest, validateUuidParam, resolveEventImageUrl } from '../lib/helpers.js';
import { uploadToR2, getFromR2 } from '../lib/cloudflare.js';
import { config } from '../config.js';
import { verifyTurnstile } from '../lib/captcha.js';
import { dispatchWebhooks, dispatchSeriesCreatedWebhook } from '../lib/webhook-delivery.js';
import { auditPortalAction } from '../lib/audit.js';
import { toNeighborhoodEvent, toRRule, type PortalEventRow } from '../lib/event-transform.js';
import { sanitizeUrl, checkApprovedDomain } from '../lib/url-sanitizer.js';
import { geocodeEventIfNeeded, geocodeSeriesEvents } from '../lib/geocoding.js';
import { writeLimiter, enumerationLimiter, portalLimiter } from '../middleware/rate-limit.js';
import { blockDatacenterIps } from '../middleware/ip-filter.js';

const PORTAL_ACCOUNT_SELECT = 'id, email, business_name, auth_user_id, status, default_venue_name, default_place_id, default_address, default_latitude, default_longitude, website, phone, wheelchair_accessible, last_login_at, created_at, updated_at';

/** IANA timezone set — built once at module load for Zod validation */
const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

// =============================================================================
// FORMAT CONVERSION HELPERS
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

/** Columns to select when reading portal events from the events table */
export const PORTAL_SELECT = 'id, user_id, content, description, place_name, place_id, approximate_location, event_at, end_time, event_image_url, event_image_focal_y, link_url, category, custom_category, event_timezone, venue_address, recurrence, price, latitude, longitude, creator_account_id, source, visibility, status, is_business, region_id, series_id, series_instance_number, start_time_required, tags, wheelchair_accessible, rsvp_limit, created_at';

export function getAdminUserId(): string {
  const id = config.admin.userIds[0];
  if (!id) throw new Error('No admin user ID configured (COMMONS_ADMIN_USER_IDS)');
  return id;
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

function formatDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`;
}

function generateInstanceDates(startDate: string, recurrence: string, instanceCount?: number): string[] {
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
    .eq('source', 'portal');

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
      cost: null, series_id: null, series_instance_number: null, series_instance_count: null, start_time_required: true, tags: [], wheelchair_accessible: null, recurrence: null,
      source: { publisher: 'fiber', collected_at: new Date().toISOString(), method: 'portal', license: 'CC BY 4.0' },
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

// =============================================================================
// ADMIN DETECTION
// =============================================================================

/**
 * Check if the authenticated user is a portal admin (by user ID).
 * Commons uses COMMONS_ADMIN_USER_IDS instead of email-based detection.
 */
function isPortalAdmin(req: import('express').Request): boolean {
  const userId = req.user?.id;
  return !!userId && config.admin.userIds.includes(userId);
}

/**
 * Get the user-context Supabase client from the request.
 * Set by requirePortalAuth middleware. Throws if missing.
 */
function getUserClient(req: import('express').Request) {
  if (!req.supabaseClient) {
    throw createError('Authentication required', 401, 'UNAUTHORIZED');
  }
  return req.supabaseClient;
}

const router: ReturnType<typeof Router> = Router();

// =============================================================================
// PRE-AUTH: Email check (public, rate-limited)
// =============================================================================

const checkEmailSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
});

/**
 * POST /api/portal/auth/check-email
 * Check if an email has a portal account (public, rate-limited).
 */
router.post('/auth/check-email', blockDatacenterIps, enumerationLimiter, async (req, res, next) => {
  try {
    const { email } = validateRequest(checkEmailSchema, req.body);

    // Check admin by looking up user by email
    // Commons doesn't have admin.emails, so we check if the email matches
    // a known admin portal_accounts entry or skip this check
    const { data: adminUser } = await supabaseAdmin.auth.admin.listUsers();
    const matchedAdmin = adminUser?.users?.find((u) => u.email?.toLowerCase() === email);
    if (matchedAdmin && config.admin.userIds.includes(matchedAdmin.id)) {
      res.json({ allowed: true, role: 'admin' });
      return;
    }

    // Check for existing portal account
    const { data } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, status')
      .ilike('email', email)
      .maybeSingle();

    if (data) {
      if (data.status === 'active' || data.status === 'pending') {
        res.json({ allowed: true, role: 'business' });
        return;
      }
      // suspended or rejected
      res.status(401).json({
        error: { code: 'ACCOUNT_DISABLED', message: 'This account has been disabled' },
      });
      return;
    }

    // Unknown email — allow self-signup
    res.json({ allowed: false, canSignUp: true });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// PRE-AUTH: Self-registration (public, rate-limited)
// =============================================================================

const registerSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
  business_name: z.string().min(1, 'Business name is required').max(200),
  captchaToken: z.string().min(1, 'Captcha is required'),
});

/**
 * POST /api/portal/auth/register
 * Self-register a new business account (status='pending').
 * Account must be approved by admin before events become visible.
 */
router.post('/auth/register', blockDatacenterIps, enumerationLimiter, async (req, res, next) => {
  try {
    const { email, business_name, captchaToken } = validateRequest(registerSchema, req.body);

    // Verify Turnstile token server-side
    const captchaValid = await verifyTurnstile(captchaToken, req.ip);
    if (!captchaValid) {
      throw createError('Captcha verification failed', 400, 'CAPTCHA_FAILED');
    }

    // Check email not already taken
    const { data: existing } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, status')
      .ilike('email', email)
      .maybeSingle();

    if (existing) {
      if (existing.status === 'rejected') {
        // Allow re-registration of rejected accounts
        const { error: updateErr } = await supabaseAdmin
          .from('portal_accounts')
          .update({ status: 'pending', business_name, auth_user_id: null, claimed_at: null })
          .eq('id', existing.id);
        if (updateErr) {
          console.error('[PORTAL] Re-register error:', updateErr.message);
          throw createError('Failed to register', 500, 'SERVER_ERROR');
        }
        console.log(`[PORTAL] Account re-registered: ${business_name} (${email.substring(0, 3)}***)`);
        await supabaseAdmin.auth.signInWithOtp({ email }).catch((e) =>
          console.error('[PORTAL] OTP send failed after re-register:', e.message));
        res.status(201).json({ success: true });
        return;
      }
      throw createError('An account with this email already exists', 409, 'CONFLICT');
    }

    // Create pending account
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('portal_accounts')
      .insert({
        email,
        business_name,
        status: 'pending',
      })
      .select('id, email')
      .single();

    if (insertErr) {
      if (insertErr.code === '23505') {
        throw createError('An account with this email already exists', 409, 'CONFLICT');
      }
      console.error('[PORTAL] Register insert error:', insertErr.message, insertErr.code);
      throw createError('Failed to register', 500, 'SERVER_ERROR');
    }
    console.log(`[PORTAL] Account row created: id=${inserted?.id}, email=${email.substring(0, 3)}***`);

    // Send OTP from server side — supabaseAdmin uses service_role key
    // which bypasses Turnstile captcha requirement on GoTrue
    const { error: otpErr } = await supabaseAdmin.auth.signInWithOtp({ email });
    if (otpErr) {
      // Account was created but OTP failed — not fatal, user can retry from login
      console.error('[PORTAL] OTP send failed after register:', otpErr.message);
    }

    console.log(`[PORTAL] Account registered (pending): ${business_name} (${email.substring(0, 3)}***)`);
    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// PUBLIC: Image serving (no auth — business events are public)
// =============================================================================

/**
 * GET /api/portal/events/:id/image
 * Serve a portal event image from R2. No auth required.
 */
router.get('/events/:id/image', async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const r2Key = `portal-events/${req.params.id}/image`;
    const { data, contentType, error } = await getFromR2(r2Key);

    if (error || !data) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Image not found' } });
      return;
    }

    res.set('Content-Type', contentType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(data));
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// AUTHENTICATED ROUTES
// =============================================================================

router.use(requirePortalAuth);

// =============================================================================
// WHOAMI (role detection)
// =============================================================================

router.get('/whoami', portalLimiter, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const email = req.user?.email;
    if (!userId || !email) throw createError('Unauthorized', 401, 'UNAUTHORIZED');

    if (isPortalAdmin(req)) {
      res.json({ role: 'admin', email });
      return;
    }

    const { data: account, error: whoamiErr } = await supabaseAdmin
      .from('portal_accounts')
      .select(PORTAL_ACCOUNT_SELECT)
      .eq('auth_user_id', userId)
      .in('status', ['active', 'pending'])
      .maybeSingle();

    if (whoamiErr) {
      console.error('[PORTAL] Whoami lookup error:', whoamiErr.message);
    }

    if (account) {
      void (async () => {
        try {
          await supabaseAdmin
            .from('portal_accounts')
            .update({ last_login_at: new Date().toISOString() })
            .eq('id', account.id);
        } catch (err) {
          console.error('[PORTAL] last_login_at update failed:', err);
        }
      })();

      res.json({ role: 'business', account });
      return;
    }

    throw createError('No portal account found', 404, 'NOT_FOUND');
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// ACCOUNT
// =============================================================================

router.post('/account/claim', writeLimiter, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const email = req.user?.email;
    if (!userId || !email) throw createError('Unauthorized', 401, 'UNAUTHORIZED');

    const normalizedEmail = email.toLowerCase().trim();
    console.log(`[PORTAL] Claim attempt: email=${normalizedEmail.substring(0, 3)}***, userId=${userId.substring(0, 8)}...`);

    const { data: account, error: lookupError } = await supabaseAdmin
      .from('portal_accounts')
      .select(PORTAL_ACCOUNT_SELECT)
      .ilike('email', normalizedEmail)
      .in('status', ['active', 'pending'])
      .maybeSingle();

    if (lookupError) {
      console.error('[PORTAL] Account claim lookup error:', lookupError.message, lookupError.code);
      throw createError('Failed to look up account', 500, 'SERVER_ERROR');
    }

    if (!account) {
      console.warn(`[PORTAL] Claim failed: no portal_accounts row for email=${normalizedEmail.substring(0, 3)}***`);
      throw createError('No portal account found for this email', 404, 'NOT_FOUND');
    }

    if (account.auth_user_id === userId) {
      res.json({ account });
      return;
    }

    if (account.auth_user_id && account.auth_user_id !== userId) {
      throw createError('This account has already been claimed', 409, 'CONFLICT');
    }

    // SAFETY: .is('auth_user_id', null) makes this atomic at the DB level.
    // If a concurrent request claims this account between our SELECT and this
    // UPDATE, the WHERE condition fails and PostgREST returns zero rows —
    // preventing a double-claim race. The SELECT above is for user-facing
    // error messages only; this UPDATE is the source of truth.
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from('portal_accounts')
      .update({ auth_user_id: userId, claimed_at: new Date().toISOString() })
      .eq('id', account.id)
      .is('auth_user_id', null)
      .select()
      .single();

    if (claimError || !claimed) {
      console.error('[PORTAL] Claim error:', claimError?.message);
      throw createError('Failed to claim account', 500, 'SERVER_ERROR');
    }

    console.log(`[PORTAL] Account claimed: ${claimed.business_name} (${claimed.id})`);
    res.json({ account: claimed });
  } catch (err) {
    next(err);
  }
});

router.get('/account', portalLimiter, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw createError('Unauthorized', 401, 'UNAUTHORIZED');

    const { data: account, error } = await getUserClient(req)
      .from('portal_accounts')
      .select(PORTAL_ACCOUNT_SELECT)
      .eq('auth_user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('[PORTAL] Account fetch error:', error.message);
      throw createError('Failed to fetch account', 500, 'SERVER_ERROR');
    }

    if (!account) {
      throw createError('No portal account found', 404, 'NOT_FOUND');
    }

    // Sync email: if the auth user verified a new email, update portal_accounts to match
    const authEmail = req.user?.email;
    if (authEmail && authEmail !== account.email) {
      await supabaseAdmin
        .from('portal_accounts')
        .update({ email: authEmail })
        .eq('id', account.id);
      account.email = authEmail;
    }

    res.json({ account });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// PROFILE (business self-service)
// =============================================================================

const updateProfileSchema = z.object({
  business_name: z.string().min(1).max(200).optional(),
  default_venue_name: z.string().max(200).optional(),
  default_place_id: z.string().max(500).optional(),
  default_address: z.string().max(500).optional(),
  default_latitude: z.number().min(-90).max(90).optional().nullable(),
  default_longitude: z.number().min(-180).max(180).optional().nullable(),
  website: z.string().url().max(500).optional().or(z.literal('')).nullable(),
  phone: z.string().max(50).optional().nullable(),
  wheelchair_accessible: z.boolean().nullable().optional(),
});

/**
 * PATCH /api/portal/account/profile
 * Update own business profile (venue address, website, phone).
 * Used during post-signup onboarding and later edits.
 */
router.patch('/account/profile', writeLimiter, async (req, res, next) => {
  try {
    const accountId = await getPortalAccountId(req);
    const data = validateRequest(updateProfileSchema, req.body);

    const update: Record<string, unknown> = {};
    if (data.business_name !== undefined) update.business_name = data.business_name;
    if (data.default_venue_name !== undefined) update.default_venue_name = data.default_venue_name || null;
    if (data.default_place_id !== undefined) update.default_place_id = data.default_place_id || null;
    if (data.default_address !== undefined) update.default_address = data.default_address || null;
    if (data.default_latitude !== undefined) update.default_latitude = data.default_latitude ?? null;
    if (data.default_longitude !== undefined) update.default_longitude = data.default_longitude ?? null;
    if (data.website !== undefined) update.website = data.website || null;
    if (data.phone !== undefined) update.phone = data.phone || null;
    if (data.wheelchair_accessible !== undefined) update.wheelchair_accessible = data.wheelchair_accessible;

    if (Object.keys(update).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    // SECURITY: Use user-context client so RLS enforces ownership
    const { data: account, error } = await getUserClient(req)
      .from('portal_accounts')
      .update(update)
      .eq('id', accountId)
      .select(PORTAL_ACCOUNT_SELECT)
      .single();

    if (error) {
      console.error('[PORTAL] Profile update error:', error.message);
      throw createError('Failed to update profile', 500, 'SERVER_ERROR');
    }

    res.json({ account });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// EVENTS (write to events table directly, source='portal')
// =============================================================================

const createEventSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  venue_name: z.string().min(1, 'Venue is required').max(200),
  address: z.string().max(500).optional(),
  place_id: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
    .refine((d) => {
      const date = new Date(d + 'T00:00:00');
      const max = new Date();
      max.setFullYear(max.getFullYear() + 2);
      return !isNaN(date.getTime()) && date <= max;
    }, { message: 'Event date cannot be more than 2 years in the future' }),
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
  event_timezone: z.string().max(50).refine(
    (tz) => VALID_TIMEZONES.has(tz),
    { message: 'Invalid timezone. Use IANA format (e.g., America/New_York)' },
  ).default('America/New_York'),
  description: z.string().max(2000).optional(),
  price: z.string().max(100).optional(),
  ticket_url: z.preprocess(
    (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    z.string().url().max(2000).optional().or(z.literal('')),
  ),
  start_time_required: z.boolean().default(true),
  tags: z.array(z.string().max(50)).max(15).default([]),
  wheelchair_accessible: z.boolean().nullable().default(null),
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
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
    .refine((d) => {
      const date = new Date(d + 'T00:00:00');
      const max = new Date();
      max.setFullYear(max.getFullYear() + 2);
      return !isNaN(date.getTime()) && date <= max;
    }, { message: 'Event date cannot be more than 2 years in the future' })
    .optional(),
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
  event_timezone: z.string().max(50).refine(
    (tz) => VALID_TIMEZONES.has(tz),
    { message: 'Invalid timezone. Use IANA format (e.g., America/New_York)' },
  ).optional(),
  description: z.string().max(2000).optional().nullable(),
  price: z.string().max(100).optional().nullable(),
  ticket_url: z.preprocess(
    (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    z.string().url().max(2000).optional().or(z.literal('')).nullable(),
  ),
  start_time_required: z.boolean().optional(),
  tags: z.array(z.string().max(50)).max(15).optional(),
  wheelchair_accessible: z.boolean().nullable().optional(),
  rsvp_limit: z.number().int().min(1).max(10000).nullable().optional(),
  image_focal_y: z.number().min(0).max(1).optional(),
  force: z.boolean().optional(),
});

async function getPortalAccount(req: import('express').Request): Promise<{ id: string; status: string }> {
  const userId = req.user?.id;
  if (!userId) throw createError('Unauthorized', 401, 'UNAUTHORIZED');

  const { data } = await getUserClient(req)
    .from('portal_accounts')
    .select('id, status')
    .eq('auth_user_id', userId)
    .in('status', ['active', 'pending'])
    .maybeSingle();

  if (!data) throw createError('No portal account found', 404, 'NOT_FOUND');
  return data;
}

/** Backward-compat wrapper — returns just the account ID */
async function getPortalAccountId(req: import('express').Request): Promise<string> {
  const account = await getPortalAccount(req);
  return account.id;
}

// =============================================================================
// EVENT CREATION RATE LIMITS (per account, DB-backed)
// =============================================================================

const CREATION_LIMITS = { hourly: 20, daily: 40 };

/**
 * Check if a portal account has exceeded event creation rate limits.
 * Counts creation actions (not individual instances — a series = 1 action).
 * Throws 429 if exceeded.
 */
async function checkPortalCreationRateLimit(accountId: string): Promise<void> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Count creation actions in past hour
  // series_instance_number IS NULL = single event, = 1 = first in series
  const { count: hourlyCount } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('creator_account_id', accountId)
    .eq('source', 'portal')
    .gte('created_at', oneHourAgo)
    .or('series_instance_number.is.null,series_instance_number.eq.1');

  if ((hourlyCount || 0) >= CREATION_LIMITS.hourly) {
    auditPortalAction('portal_creation_rate_limited', accountId, accountId,
      { window: 'hourly', count: hourlyCount || 0 }, '/api/portal/events');
    throw createError(
      `Creation limit reached (${CREATION_LIMITS.hourly}/hour). Try again later.`,
      429, 'RATE_LIMIT',
    );
  }

  // Count creation actions in past 24 hours
  const { count: dailyCount } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('creator_account_id', accountId)
    .eq('source', 'portal')
    .gte('created_at', oneDayAgo)
    .or('series_instance_number.is.null,series_instance_number.eq.1');

  if ((dailyCount || 0) >= CREATION_LIMITS.daily) {
    auditPortalAction('portal_creation_rate_limited', accountId, accountId,
      { window: 'daily', count: dailyCount || 0 }, '/api/portal/events');
    throw createError(
      `Creation limit reached (${CREATION_LIMITS.daily}/day). Try again later.`,
      429, 'RATE_LIMIT',
    );
  }
}

/**
 * GET /api/portal/events
 * List all events for the authenticated business.
 */
router.get('/events', portalLimiter, async (req, res, next) => {
  try {
    const accountId = await getPortalAccountId(req);

    // [RLS] portal_events_select_own policy enforces ownership via creator_account_id
    // Show all events owned by this account regardless of source (portal, import, api)
    const { data: events, error } = await getUserClient(req)
      .from('events')
      .select(PORTAL_SELECT)
      .eq('creator_account_id', accountId)
      .order('event_at', { ascending: false });

    if (error) {
      console.error('[PORTAL] Events fetch error:', error.message);
      throw createError('Failed to fetch events', 500, 'SERVER_ERROR');
    }

    res.json({ events: (events || []).map(toPortalEvent) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/portal/events
 * Create a new event.
 */
router.post('/events', writeLimiter, async (req, res, next) => {
  try {
    const account = await getPortalAccount(req);
    await checkPortalCreationRateLimit(account.id);
    const data = validateRequest(createEventSchema, req.body);
    const adminUserId = getAdminUserId();

    // Validate custom_category when category is 'other'
    if (data.category === 'other') {
      if (!data.custom_category || data.custom_category.trim().length === 0) {
        throw createError('Custom category is required when category is "other"', 400, 'VALIDATION_ERROR');
      }
      const wordCount = data.custom_category.trim().split(/\s+/).length;
      if (wordCount > 3) {
        throw createError('Custom category must be 1-3 words', 400, 'VALIDATION_ERROR');
      }
    }

    // Validate and sanitize tags against the selected category
    if (data.tags && data.tags.length > 0) {
      data.tags = validateTags(data.tags, data.category);
    }

    const insertData = portalInputToInsert(data, account.id, adminUserId, account.status);

    // Recurring events: expand into individual instance rows
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

      console.log(`[PORTAL] Series created: "${data.title}" (${instances.length} instances)`);
      auditPortalAction('portal_event_created', account.id, instances[0]!.id,
        { title: data.title, recurrence: data.recurrence, series_count: instances.length });
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

    // Single event: insert directly
    const { data: event, error } = await supabaseAdmin
      .from('events')
      .insert(insertData)
      .select(PORTAL_SELECT)
      .single();

    if (error) {
      console.error('[PORTAL] Event create error:', error.message);
      throw createError('Failed to create event', 500, 'SERVER_ERROR');
    }

    console.log(`[PORTAL] Event created: "${data.title}" (${event.id}) [${account.status === 'active' ? 'published' : 'pending_review'}]`);
    auditPortalAction('portal_event_created', account.id, event.id, { title: data.title });

    // Fire-and-forget geocode if address present but no coordinates
    void geocodeEventIfNeeded(event.id, insertData.venue_address as string | null, insertData.latitude as number | null, insertData.longitude as number | null, account.id);

    // Dispatch webhook only for published events (skip pending_review)
    if (account.status === 'active') {
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
          console.error('[PORTAL] Webhook dispatch error:', err instanceof Error ? err.message : err);
        }
      })();
    }

    res.status(201).json({ event: toPortalEvent(event) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/portal/events/:id
 * Get a single event.
 */
router.get('/events/:id', portalLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    await getPortalAccountId(req);

    // [RLS] portal_events_select_own policy — works for portal, import, and api sources
    const { data: event, error } = await getUserClient(req)
      .from('events')
      .select(PORTAL_SELECT)
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) {
      console.error('[PORTAL] Event fetch error:', error.message);
      throw createError('Failed to fetch event', 500, 'SERVER_ERROR');
    }

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    res.json({ event: toPortalEvent(event) });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/portal/events/series/:seriesId
 * Update all future instances of a series.
 * Compares each instance against base_event_data to detect customizations;
 * customized fields are preserved unless the caller sends force=true.
 * NOTE: Must be defined before /events/:id to avoid route conflict.
 */
router.patch('/events/series/:seriesId', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.seriesId, 'series ID');
    const accountId = await getPortalAccountId(req);
    const data = validateRequest(updateEventSchema, req.body);
    const force = data.force === true;

    // Verify ownership: at least one event in the series belongs to this account
    const { data: check } = await getUserClient(req)
      .from('events')
      .select('id')
      .eq('series_id', req.params.seriesId)
      .eq('creator_account_id', accountId)
      .eq('source', 'portal')
      .limit(1)
      .maybeSingle();

    if (!check) {
      throw createError('Series not found', 404, 'NOT_FOUND');
    }

    // Fetch the series base_event_data for customization detection
    const { data: series } = await supabaseAdmin
      .from('event_series')
      .select('base_event_data')
      .eq('id', req.params.seriesId)
      .maybeSingle();

    const baseData = (series?.base_event_data as Record<string, unknown>) || {};

    // Fetch all future instances in the series
    const now = new Date().toISOString();
    const { data: futureEvents, error: fetchErr } = await supabaseAdmin
      .from('events')
      .select(PORTAL_SELECT)
      .eq('series_id', req.params.seriesId)
      .eq('source', 'portal')
      .gte('event_at', now)
      .order('event_at', { ascending: true });

    if (fetchErr) {
      console.error('[PORTAL] Series fetch error:', fetchErr.message);
      throw createError('Failed to fetch series events', 500, 'SERVER_ERROR');
    }

    if (!futureEvents || futureEvents.length === 0) {
      throw createError('No upcoming events in this series', 404, 'NOT_FOUND');
    }

    // Build the update payload from the request (same logic as single-event PATCH)
    // We use the first future event's timezone as reference
    const refEvent = futureEvents[0]!;
    const tz = data.event_timezone || (refEvent.event_timezone as string) || 'America/New_York';

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
    if (data.start_time_required !== undefined) templateUpdate.start_time_required = data.start_time_required;
    if (data.tags !== undefined) {
      const category = data.category || (templateUpdate.category as string | undefined);
      templateUpdate.tags = category ? validateTags(data.tags, category) : data.tags;
    }
    if (data.wheelchair_accessible !== undefined) templateUpdate.wheelchair_accessible = data.wheelchair_accessible;
    if (data.rsvp_limit !== undefined) templateUpdate.rsvp_limit = data.rsvp_limit;
    if (data.image_focal_y !== undefined) templateUpdate.event_image_focal_y = data.image_focal_y;

    // Time changes: apply to each instance relative to its own date
    const hasTimeChange = data.start_time !== undefined || data.end_time !== undefined;

    if (Object.keys(templateUpdate).length === 0 && !hasTimeChange) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    // Map DB column names back to base_event_data keys for comparison
    const columnToBaseKey: Record<string, string> = {
      content: 'content', place_name: 'place_name', venue_address: 'venue_address',
      place_id: 'place_id', latitude: 'latitude', longitude: 'longitude',
      category: 'category', custom_category: 'custom_category',
      description: 'description', price: 'price', link_url: 'link_url', start_time_required: 'start_time_required',
      tags: 'tags', wheelchair_accessible: 'wheelchair_accessible', rsvp_limit: 'rsvp_limit', event_image_focal_y: 'event_image_focal_y',
    };

    let updatedCount = 0;

    for (const ev of futureEvents) {
      // Per-instance update: start with template, then filter out customized fields
      const instanceUpdate: Record<string, unknown> = { ...templateUpdate };

      if (!force) {
        // Check each field: if the instance value differs from base_event_data,
        // that field was customized — skip it
        for (const [col, baseKey] of Object.entries(columnToBaseKey)) {
          if (!(col in instanceUpdate)) continue;
          const baseVal = baseData[baseKey];
          const instanceVal = (ev as Record<string, unknown>)[col];
          // If instance differs from base template, it's been customized — preserve it
          if (baseVal !== undefined && instanceVal !== baseVal) {
            delete instanceUpdate[col];
          }
        }
      }

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
        console.error(`[PORTAL] Series instance update error (${(ev as Record<string, unknown>).id}):`, updateErr.message);
      } else {
        updatedCount++;
      }
    }

    // Update base_event_data on the series row so future comparisons reflect the new template
    const newBase = { ...baseData };
    for (const [col, baseKey] of Object.entries(columnToBaseKey)) {
      if (col in templateUpdate) {
        newBase[baseKey] = templateUpdate[col];
      }
    }
    await supabaseAdmin
      .from('event_series')
      .update({ base_event_data: newBase })
      .eq('id', req.params.seriesId);

    console.log(`[PORTAL] Series ${req.params.seriesId} updated: ${updatedCount}/${futureEvents.length} future instances`);
    auditPortalAction('portal_event_updated', accountId, req.params.seriesId,
      { series: true, updated: updatedCount, total: futureEvents.length });

    // Dispatch webhooks for updated events (fire-and-forget)
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
        console.error('[PORTAL] Series webhook dispatch error:', err instanceof Error ? err.message : err);
      }
    })();

    res.json({ updated: updatedCount, total: futureEvents.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/portal/events/series/:seriesId/extend
 * Extend (renew) a series by generating additional instances from the day after
 * the current last instance. Uses the series base_event_data as the template.
 * Returns the count of new instances created.
 */
router.post('/events/series/:seriesId/extend', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.seriesId, 'series ID');
    const accountId = await getPortalAccountId(req);

    // Verify ownership
    const { data: check } = await getUserClient(req)
      .from('events')
      .select('id')
      .eq('series_id', req.params.seriesId)
      .eq('creator_account_id', accountId)
      .eq('source', 'portal')
      .limit(1)
      .maybeSingle();

    if (!check) {
      throw createError('Series not found', 404, 'NOT_FOUND');
    }

    // Fetch the series metadata
    const { data: series } = await supabaseAdmin
      .from('event_series')
      .select('id, recurrence, base_event_data, creator_account_id')
      .eq('id', req.params.seriesId)
      .single();

    if (!series) throw createError('Series not found', 404, 'NOT_FOUND');

    const recurrence = series.recurrence as string;
    if (recurrence === 'none') throw createError('Cannot extend a non-recurring series', 400, 'VALIDATION_ERROR');

    const baseData = (series.base_event_data as Record<string, unknown>) || {};

    // Find the last instance to determine where to continue from
    const { data: lastEvent } = await supabaseAdmin
      .from('events')
      .select('event_at, event_timezone, end_time, series_instance_number')
      .eq('series_id', req.params.seriesId)
      .order('event_at', { ascending: false })
      .limit(1)
      .single();

    if (!lastEvent) throw createError('No existing events in series', 404, 'NOT_FOUND');

    const tz = (lastEvent.event_timezone as string) || 'America/New_York';
    const lastParsed = fromTimestamptz(lastEvent.event_at as string, tz);
    const lastInstanceNum = (lastEvent.series_instance_number as number) || 0;

    // Extract start_time and end_time from the last instance
    const startTime = lastParsed.time;
    let endTime: string | null = null;
    if (lastEvent.end_time) {
      endTime = fromTimestamptz(lastEvent.end_time as string, tz).time;
    }

    // Generate new dates starting the day after the last instance
    const lastDate = new Date(lastParsed.date + 'T12:00:00');
    lastDate.setDate(lastDate.getDate() + 1);
    const newStartDate = formatDateStr(lastDate);

    const newDates = generateInstanceDates(newStartDate, recurrence);
    if (newDates.length === 0) {
      throw createError('No new dates generated', 400, 'VALIDATION_ERROR');
    }

    // Fetch one existing event for template fields not in base_event_data
    const { data: templateEvent } = await supabaseAdmin
      .from('events')
      .select('creator_account_id, source, visibility, status, is_business, region_id, event_timezone, event_image_url, event_image_focal_y')
      .eq('series_id', req.params.seriesId)
      .limit(1)
      .single();

    if (!templateEvent) throw createError('Series events not found', 404, 'NOT_FOUND');

    const adminUserId = getAdminUserId();

    // Build rows for new instances
    const rows = newDates.map((date, i) => {
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

      return {
        ...baseData,
        creator_account_id: series.creator_account_id,
        user_id: adminUserId,
        source: templateEvent.source,
        visibility: templateEvent.visibility,
        status: templateEvent.status,
        is_business: templateEvent.is_business,
        region_id: templateEvent.region_id,
        event_timezone: tz,
        event_image_url: templateEvent.event_image_url,
        event_image_focal_y: templateEvent.event_image_focal_y,
        event_at: eventAt,
        end_time: endTimeTs,
        recurrence,
        series_id: series.id,
        series_instance_number: lastInstanceNum + i + 1,
      };
    });

    const { data: created, error: insertErr } = await supabaseAdmin
      .from('events')
      .insert(rows)
      .select('id, event_at')
      .order('event_at', { ascending: true });

    if (insertErr) {
      console.error('[PORTAL] Series extend insert failed:', insertErr.message);
      throw createError('Failed to create new instances', 500, 'SERVER_ERROR');
    }

    const count = created?.length || 0;

    // Update series recurrence_rule count
    const updatedRule = { frequency: recurrence, count: lastInstanceNum + count };
    await supabaseAdmin
      .from('event_series')
      .update({ recurrence_rule: updatedRule })
      .eq('id', series.id);

    console.log(`[PORTAL] Series ${series.id} extended: +${count} instances (total ${lastInstanceNum + count})`);
    auditPortalAction('portal_event_updated', accountId, series.id,
      { series_extend: true, added: count, total: lastInstanceNum + count });

    res.json({ added: count, total: lastInstanceNum + count });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/portal/events/batch
 * Bulk-update multiple events owned by the authenticated user.
 * Accepts an array of event IDs and a partial update payload.
 * Only fields safe for bulk edit are accepted (no date/time/recurrence —
 * those are per-event and should be edited individually).
 *
 * NOTE: Must be defined before /events/:id to avoid route conflict.
 */
const batchUpdateSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(50),
  updates: z.object({
    category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
    custom_category: z.string().max(30).optional().nullable(),
    tags: z.array(z.string().max(50)).max(15).optional(),
    wheelchair_accessible: z.boolean().nullable().optional(),
    rsvp_limit: z.number().int().min(1).max(10000).nullable().optional(),
    start_time_required: z.boolean().optional(),
    description: z.string().max(2000).optional().nullable(),
    price: z.string().max(100).optional().nullable(),
  }).refine((u) => Object.keys(u).length > 0, { message: 'No fields to update' }),
});

router.patch('/events/batch', writeLimiter, async (req, res, next) => {
  try {
    const accountId = await getPortalAccountId(req);
    const { ids, updates } = validateRequest(batchUpdateSchema, req.body);

    if (updates.category === 'other') {
      if (!updates.custom_category || updates.custom_category.trim().length === 0) {
        throw createError('Custom category is required when category is "other"', 400, 'VALIDATION_ERROR');
      }
      const wordCount = updates.custom_category.trim().split(/\s+/).length;
      if (wordCount > 3) {
        throw createError('Custom category must be 1-3 words', 400, 'VALIDATION_ERROR');
      }
    }

    // Build DB update payload
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
    if (updates.rsvp_limit !== undefined) dbUpdate.rsvp_limit = updates.rsvp_limit;
    if (updates.start_time_required !== undefined) dbUpdate.start_time_required = updates.start_time_required;
    if (updates.description !== undefined) dbUpdate.description = updates.description || null;
    if (updates.price !== undefined) dbUpdate.price = updates.price || null;

    // [RLS] portal_events_update_own policy — only updates events owned by this user
    const { data: updated, error } = await getUserClient(req)
      .from('events')
      .update(dbUpdate)
      .in('id', ids)
      .select('id');

    if (error) {
      console.error('[PORTAL] Batch update error:', error.message);
      throw createError('Failed to update events', 500, 'SERVER_ERROR');
    }

    const updatedIds = (updated || []).map((e: { id: string }) => e.id);

    for (const id of updatedIds) {
      auditPortalAction('portal_event_updated', accountId, id, undefined, '/api/portal/events/batch');
    }

    // Dispatch webhooks (fire-and-forget)
    void (async () => {
      try {
        for (const id of updatedIds) {
          const { data: row } = await supabaseAdmin
            .from('events')
            .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
            .eq('id', id)
            .maybeSingle();
          if (row) {
            void dispatchWebhooks('event.updated', id, toNeighborhoodEvent(row as unknown as PortalEventRow));
          }
        }
      } catch (err) {
        console.error('[PORTAL] Batch webhook dispatch error:', err instanceof Error ? err.message : err);
      }
    })();

    res.json({ updated: updatedIds.length, ids: updatedIds });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/portal/events/:id
 * Update an event.
 */
router.patch('/events/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    await getPortalAccountId(req);
    const data = validateRequest(updateEventSchema, req.body);

    if (data.category === 'other') {
      if (!data.custom_category || data.custom_category.trim().length === 0) {
        throw createError('Custom category is required when category is "other"', 400, 'VALIDATION_ERROR');
      }
      const wordCount = data.custom_category.trim().split(/\s+/).length;
      if (wordCount > 3) {
        throw createError('Custom category must be 1-3 words', 400, 'VALIDATION_ERROR');
      }
    }

    // Fetch existing event to get timezone for time conversion
    const { data: existing } = await getUserClient(req)
      .from('events')
      .select('event_timezone, event_at')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!existing) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const tz = data.event_timezone || (existing.event_timezone as string) || 'America/New_York';

    // Build update payload
    const update: Record<string, unknown> = {};
    if (data.title !== undefined) update.content = data.title;
    if (data.venue_name !== undefined) update.place_name = data.venue_name;
    if (data.address !== undefined) update.venue_address = data.address || null;
    if (data.place_id !== undefined) update.place_id = data.place_id || null;
    if (data.latitude !== undefined) {
      update.latitude = data.latitude ?? null;
    }
    if (data.longitude !== undefined) {
      update.longitude = data.longitude ?? null;
    }
    if (data.latitude !== undefined || data.longitude !== undefined) {
      const lat = data.latitude ?? null;
      const lng = data.longitude ?? null;
      update.approximate_location = lat != null && lng != null
        ? `POINT(${lng} ${lat})`
        : null;
    }
    if (data.event_date !== undefined || data.start_time !== undefined) {
      // Need both date and time to recompute event_at
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
    if (data.start_time_required !== undefined) update.start_time_required = data.start_time_required;
    if (data.tags !== undefined) {
      const category = data.category || (update.category as string | undefined);
      update.tags = category ? validateTags(data.tags, category) : data.tags;
    }
    if (data.wheelchair_accessible !== undefined) update.wheelchair_accessible = data.wheelchair_accessible;
    if (data.rsvp_limit !== undefined) update.rsvp_limit = data.rsvp_limit;
    if (data.image_focal_y !== undefined) update.event_image_focal_y = data.image_focal_y;

    if (Object.keys(update).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    // [RLS] portal_events_update_own policy — works for portal, import, and api sources
    const { data: event, error } = await getUserClient(req)
      .from('events')
      .update(update)
      .eq('id', req.params.id)
      .select(PORTAL_SELECT)
      .single();

    if (error) {
      console.error('[PORTAL] Event update error:', error.message);
      throw createError('Failed to update event', 500, 'SERVER_ERROR');
    }

    auditPortalAction('portal_event_updated', event.creator_account_id as string, req.params.id,
      undefined, '/api/portal/events/:id');

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
        console.error('[PORTAL] Webhook dispatch error:', err instanceof Error ? err.message : err);
      }
    })();

    res.json({ event: toPortalEvent(event) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/portal/events/series/:seriesId
 * Delete all events in a series.
 * NOTE: Must be defined before /events/:id to avoid route conflict.
 */
router.delete('/events/series/:seriesId', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.seriesId, 'series ID');
    const accountId = await getPortalAccountId(req);

    // Verify at least one event in the series belongs to this account
    const { data: check } = await getUserClient(req)
      .from('events')
      .select('id')
      .eq('series_id', req.params.seriesId)
      .eq('creator_account_id', accountId)
      .eq('source', 'portal')
      .limit(1)
      .maybeSingle();

    if (!check) {
      throw createError('Series not found', 404, 'NOT_FOUND');
    }

    const deleted = await deleteSeriesEvents(req.params.seriesId);
    res.json({ success: true, deleted });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/portal/events/:id
 * Delete an event.
 */
router.delete('/events/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const accountId = await getPortalAccountId(req);

    // [RLS] portal_events_delete_own policy — works for portal, import, and api sources
    const { error } = await getUserClient(req)
      .from('events')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      console.error('[PORTAL] Event delete error:', error.message);
      throw createError('Failed to delete event', 500, 'SERVER_ERROR');
    }

    auditPortalAction('portal_event_deleted', accountId, req.params.id);

    // Dispatch webhook (fire-and-forget)
    void dispatchWebhooks('event.deleted', req.params.id, {
      id: req.params.id, name: '', start: '', end: null, timezone: 'UTC', description: null,
      category: [], place_id: null,
      location: { name: '', address: null, lat: null, lng: null },
      url: null, images: [], organizer: { name: '', phone: null },
      cost: null, series_id: null, series_instance_number: null, series_instance_count: null, start_time_required: true, tags: [], wheelchair_accessible: null, recurrence: null,
      source: { publisher: 'fiber', collected_at: new Date().toISOString(), method: 'portal', license: 'CC BY 4.0' },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// IMAGE UPLOAD
// =============================================================================

const SUPPORTED_MAGIC_BYTES: Record<string, string> = {
  'ffd8ff': 'image/jpeg',
  '89504e47': 'image/png',
  '52494646': 'image/webp',
};

const imageUploadSchema = z.object({
  image: z.string().min(1).max(14_000_000),
});

/** Per-route body limit override for image uploads (12MB vs global 5MB) */
const imageBodyLimit = expressJson({ limit: '12mb' });

/**
 * Validate magic bytes, re-encode through sharp (strips metadata, kills polyglots),
 * upload to R2, and return the public serving URL.
 */
async function processAndUploadImage(eventId: string, base64: string): Promise<string> {
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length < 8) {
    throw createError('Invalid image data', 400, 'VALIDATION_ERROR');
  }

  const hex = buffer.subarray(0, 4).toString('hex').toLowerCase();
  let valid = false;
  for (const magic of Object.keys(SUPPORTED_MAGIC_BYTES)) {
    if (hex.startsWith(magic)) { valid = true; break; }
  }
  if (!valid) {
    throw createError('Unsupported image format (JPEG, PNG, WebP only)', 400, 'VALIDATION_ERROR');
  }

  // Re-encode through sharp: strips ALL metadata (EXIF, GPS, XMP, ICC),
  // kills polyglot payloads, normalizes orientation, enforces max dimensions
  const processed = await sharp(buffer)
    .rotate()
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const r2Key = `portal-events/${eventId}/image`;
  const result = await uploadToR2(r2Key, new Uint8Array(processed), 'image/jpeg');
  if (!result.success) {
    throw createError('Failed to upload image', 500, 'SERVER_ERROR');
  }

  return `${config.apiBaseUrl}/api/portal/events/${eventId}/image`;
}

/**
 * POST /api/portal/events/:id/image
 * Upload an event image (base64 -> sharp re-encode -> R2).
 */
router.post('/events/:id/image', imageBodyLimit, writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    await getPortalAccountId(req);
    const { image } = validateRequest(imageUploadSchema, req.body);

    // Verify event exists and is owned by this user [RLS]
    const { data: event } = await getUserClient(req)
      .from('events')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const imageUrl = await processAndUploadImage(req.params.id, image);

    // Update event with full serving URL [RLS]
    const { error: updateError } = await getUserClient(req)
      .from('events')
      .update({ event_image_url: imageUrl })
      .eq('id', req.params.id);

    if (updateError) {
      console.error('[PORTAL] Image URL update error:', updateError.message);
      throw createError('Failed to save image reference', 500, 'SERVER_ERROR');
    }

    res.json({ image_url: imageUrl });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// IMPORT — iCal + Eventbrite feed ingestion
// =============================================================================

import { parseIcalFeed, parseEventbritePage, detectFormat, type ImportedEvent } from '../lib/import-parsers.js';
import { validateFeedUrl } from '../lib/url-validation.js';

const IMPORT_RATE_LIMIT = 5; // per hour per account

const importPreviewSchema = z.object({
  url: z.string().url().max(2000),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]),
  event_timezone: z.string().max(50).refine(
    (tz) => VALID_TIMEZONES.has(tz),
    { message: 'Invalid timezone' },
  ).default('America/New_York'),
});

const importConfirmSchema = z.object({
  url: z.string().url().max(2000),
  source_type: z.enum(['ical', 'eventbrite']),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]),
  event_timezone: z.string().max(50).refine(
    (tz) => VALID_TIMEZONES.has(tz),
    { message: 'Invalid timezone' },
  ).default('America/New_York'),
  events: z.array(z.number().int().min(0)).min(1).max(100),
  overrides: z.record(z.string(), z.object({
    venue_name: z.string().min(1).max(200).optional(),
    category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
    description: z.string().max(2000).optional(),
    image_focal_y: z.number().min(0).max(1).optional(),
  })).default({}),
});

/** SSRF-protected fetch with size and timeout limits */
async function safeFetchFeed(url: string): Promise<{ body: string; contentType: string }> {
  // SSRF protection: validate URL resolves to a public IP (allows HTTP — many iCal feeds are HTTP-only)
  await validateFeedUrl(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'NeighborhoodCommons/1.0 (event-import)' },
    });

    if (!resp.ok) {
      throw createError(`Feed returned HTTP ${resp.status}`, 400, 'IMPORT_FETCH_ERROR');
    }

    const contentType = resp.headers.get('content-type') || '';
    const MAX_BYTES = 5 * 1024 * 1024;

    // Early reject if Content-Length header exceeds limit
    const contentLength = resp.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_BYTES) {
      throw createError('Feed too large (max 5MB)', 400, 'IMPORT_TOO_LARGE');
    }

    // Stream body with incremental byte counting — never buffer more than MAX_BYTES
    if (!resp.body) {
      throw createError('Empty response body', 400, 'IMPORT_FETCH_ERROR');
    }
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BYTES) {
        reader.cancel();
        throw createError('Feed too large (max 5MB)', 400, 'IMPORT_TOO_LARGE');
      }
      chunks.push(value);
    }

    const body = new TextDecoder().decode(Buffer.concat(chunks));
    return { body, contentType };
  } finally {
    clearTimeout(timeout);
  }
}

/** Check import rate limit (DB-backed, per account) */
async function checkImportRateLimit(accountId: string): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('creator_account_id', accountId)
    .eq('source_method', 'import')
    .gte('created_at', oneHourAgo)
    .or('series_instance_number.is.null,series_instance_number.eq.1');

  if ((count || 0) >= IMPORT_RATE_LIMIT) {
    throw createError(`Import limit reached (${IMPORT_RATE_LIMIT}/hour). Try again later.`, 429, 'RATE_LIMIT');
  }
}

/**
 * POST /api/portal/import/preview
 * Fetch a URL, parse events, return a structured preview. No DB writes.
 */
router.post('/import/preview', writeLimiter, async (req, res, next) => {
  try {
    await getPortalAccount(req); // Auth check — must be a portal user
    const data = validateRequest(importPreviewSchema, req.body);

    const { body, contentType } = await safeFetchFeed(data.url);
    const format = detectFormat(data.url, contentType, body);

    if (format === 'unknown') {
      throw createError('Could not detect feed format. Supported: iCal (.ics), Eventbrite pages.', 400, 'IMPORT_UNKNOWN_FORMAT');
    }

    let parsed: ImportedEvent[];
    if (format === 'ical') {
      parsed = parseIcalFeed(body, data.event_timezone);
    } else {
      parsed = parseEventbritePage(body, data.url, data.event_timezone);
    }

    if (parsed.length === 0) {
      throw createError('No events found in feed', 400, 'IMPORT_EMPTY');
    }

    // Check which events already exist (by external_id + source_feed_url)
    const externalIds = parsed.map(e => e.external_id).filter(Boolean) as string[];
    let existingIds = new Set<string>();
    if (externalIds.length > 0) {
      const { data: existing } = await supabaseAdmin
        .from('events')
        .select('external_id')
        .eq('source_feed_url', data.url)
        .in('external_id', externalIds);
      existingIds = new Set((existing || []).map(e => e.external_id));
    }

    const previewEvents = parsed.map((event, index) => ({
      index,
      name: event.name,
      start: event.start,
      end: event.end,
      timezone: event.timezone || data.event_timezone,
      venue_name: event.venue_name,
      address: event.address,
      description: event.description?.slice(0, 200) || null,
      cost: event.cost,
      external_id: event.external_id,
      already_exists: event.external_id ? existingIds.has(event.external_id) : false,
      recurrence: event.recurrence,
      image_url: event.image_url,
    }));

    // Count warnings
    const warnings: string[] = [];
    const existingCount = previewEvents.filter(e => e.already_exists).length;
    if (existingCount > 0) {
      warnings.push(`${existingCount} event(s) already imported from this feed`);
    }

    // Log URL without query params (may contain API keys/tokens)
    const safeUrl = (() => { try { const u = new URL(data.url); return u.origin + u.pathname; } catch { return '(invalid URL)'; } })();
    console.log(`[PORTAL] Import preview: ${parsed.length} events from ${format} feed (${safeUrl})`);

    res.json({
      source_type: format,
      source_url: data.url,
      events: previewEvents,
      warnings,
      total_parsed: parsed.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/portal/import/confirm
 * Re-fetch, re-parse, and save selected events from a previewed feed.
 * Stateless — no server-side preview cache. Re-fetch prevents TOCTOU issues.
 */
router.post('/import/confirm', writeLimiter, async (req, res, next) => {
  try {
    const account = await getPortalAccount(req);
    await checkImportRateLimit(account.id);
    const data = validateRequest(importConfirmSchema, req.body);
    const adminUserId = getAdminUserId();

    // Re-fetch and re-parse (stateless — prevents TOCTOU)
    const { body, contentType } = await safeFetchFeed(data.url);
    const format = detectFormat(data.url, contentType, body);
    if (format === 'unknown') {
      throw createError('Feed format changed since preview', 400, 'IMPORT_UNKNOWN_FORMAT');
    }

    let parsed: ImportedEvent[];
    if (format === 'ical') {
      parsed = parseIcalFeed(body, data.event_timezone);
    } else {
      parsed = parseEventbritePage(body, data.url, data.event_timezone);
    }

    // Select events by index
    const selectedIndices = new Set(data.events);
    const selected = parsed.filter((_, i) => selectedIndices.has(i));
    if (selected.length === 0) {
      throw createError('None of the selected events were found in the re-fetched feed', 400, 'IMPORT_MISMATCH');
    }

    const created: Array<{ id: string; name: string; status: string }> = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const event of selected) {
      const idx = parsed.indexOf(event);
      const override = data.overrides[String(idx)] || {};

      const tz = event.timezone || data.event_timezone;
      const category = override.category || data.category;
      const venueName = override.venue_name || event.venue_name || 'TBA';
      const description = override.description || event.description || null;

      // Parse start datetime
      const startDate = new Date(event.start);
      if (isNaN(startDate.getTime())) {
        skipped.push({ name: event.name, reason: 'Invalid start date' });
        continue;
      }

      const eventDateStr = startDate.toLocaleDateString('en-CA', { timeZone: tz });
      const eventTimeStr = startDate.toLocaleTimeString('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      });

      let endTimeStr: string | undefined;
      if (event.end) {
        const endDate = new Date(event.end);
        if (!isNaN(endDate.getTime())) {
          endTimeStr = endDate.toLocaleTimeString('en-GB', {
            timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
          });
        }
      }

      const eventAt = toTimestamptz(eventDateStr, eventTimeStr, tz);
      let endTime: string | null = null;
      if (endTimeStr) {
        endTime = toTimestamptz(eventDateStr, endTimeStr, tz);
        // If end_time is before start_time, the event spans midnight — use next day
        if (new Date(endTime) <= new Date(eventAt)) {
          const nextDay = new Date(eventDateStr);
          nextDay.setDate(nextDay.getDate() + 1);
          const nextDateStr = nextDay.toISOString().split('T')[0]!;
          endTime = toTimestamptz(nextDateStr, endTimeStr, tz);
        }
      }

      const insertData = {
        user_id: adminUserId,
        content: event.name.slice(0, 200),
        description,
        place_name: venueName.slice(0, 200),
        venue_address: event.address?.slice(0, 500) || null,
        place_id: null,
        approximate_location: null,
        latitude: null,
        longitude: null,
        event_at: eventAt,
        end_time: endTime,
        event_timezone: tz,
        category,
        custom_category: null,
        recurrence: 'none', // Import creates individual events (RRULE already expanded in preview if needed)
        price: event.cost?.slice(0, 100) || null,
        link_url: event.url?.slice(0, 2000) || null,
        start_time_required: true,
        tags: [],
        wheelchair_accessible: null,
        rsvp_limit: null,
        event_image_focal_y: override.image_focal_y ?? 0.5,
        event_image_url: event.image_url || null,
        creator_account_id: account.id,
        source: 'import',
        source_method: 'import',
        source_publisher: data.source_type === 'eventbrite' ? 'Eventbrite' : null,
        source_feed_url: data.url,
        external_id: event.external_id,
        visibility: 'public',
        status: account.status === 'active' ? 'published' : 'pending_review',
        is_business: true,
        region_id: config.defaultRegionId,
      };

      const { data: row, error } = await supabaseAdmin
        .from('events')
        .insert(insertData)
        .select('id, status')
        .single();

      if (error) {
        // Dedup constraint violation = already exists
        if (error.code === '23505') {
          skipped.push({ name: event.name, reason: 'Already imported' });
          continue;
        }
        console.error('[PORTAL] Import insert error:', error.message);
        skipped.push({ name: event.name, reason: 'Database error' });
        continue;
      }

      created.push({ id: row.id, name: event.name, status: row.status });

      // Dispatch webhook for published events
      if (row.status === 'published') {
        void dispatchWebhooks('event.created', row.id, { id: row.id, name: event.name, start: event.start } as unknown as import('../lib/event-transform.js').NeighborhoodEvent);
      }
    }

    const safeConfirmUrl = (() => { try { const u = new URL(data.url); return u.origin + u.pathname; } catch { return '(invalid URL)'; } })();
    console.log(`[PORTAL] Import confirmed: ${created.length} created, ${skipped.length} skipped from ${safeConfirmUrl}`);
    auditPortalAction('portal_import', account.id, account.id, {
      source_url: data.url,
      source_type: data.source_type,
      created: created.length,
      skipped: skipped.length,
    });

    res.status(201).json({
      created,
      skipped,
      total_created: created.length,
      total_skipped: skipped.length,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
