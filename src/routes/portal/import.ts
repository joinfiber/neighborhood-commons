/**
 * Portal Import Routes
 *
 * iCal and Eventbrite feed import: preview and confirm.
 */

import { Router } from "express";
import { z } from "zod";
import { EVENT_CATEGORY_KEYS } from "../../lib/categories.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { createError } from "../../middleware/error-handler.js";
import { validateRequest } from "../../lib/helpers.js";
import { config } from "../../config.js";
import { dispatchWebhooks } from "../../lib/webhook-delivery.js";
import { auditPortalAction } from "../../lib/audit.js";
import { writeLimiter } from "../../middleware/rate-limit.js";
import { parseIcalFeed, parseEventbritePage, detectFormat, type ImportedEvent } from "../../lib/import-parsers.js";
import { validateFeedUrl } from "../../lib/url-validation.js";
import { toTimestamptz, getAdminUserId } from "../../lib/event-operations.js";
import { getPortalAccount, getAuditActor } from "../../lib/portal-helpers.js";

const VALID_TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

const router: ReturnType<typeof Router> = Router();

// =============================================================================
// IMPORT — iCal + Eventbrite feed ingestion
// =============================================================================

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
        void dispatchWebhooks('event.created', row.id, { id: row.id, name: event.name, start: event.start } as unknown as import('../../lib/event-transform.js').NeighborhoodEvent);
      }
    }

    const safeConfirmUrl = (() => { try { const u = new URL(data.url); return u.origin + u.pathname; } catch { return '(invalid URL)'; } })();
    console.log(`[PORTAL] Import confirmed: ${created.length} created, ${skipped.length} skipped from ${safeConfirmUrl}`);
    const { actor: importActor, impersonationMeta: importMeta } = getAuditActor(req, account.id);
    auditPortalAction('portal_import', importActor, account.id, {
      source_url: data.url,
      source_type: data.source_type,
      created: created.length,
      skipped: skipped.length,
      ...importMeta,
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
