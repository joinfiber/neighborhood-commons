/**
 * Admin Routes — Neighborhood Commons
 *
 * Portal admin endpoints for managing business accounts, events,
 * and API keys. All routes require Commons Admin authentication
 * (JWT + admin user ID check via requireCommonsAdmin middleware).
 *
 * Extracted from portal.ts admin routes — uses the same data model
 * and format helpers, with admin-level access (no RLS, supabaseAdmin).
 */

import { Router, json as expressJson } from 'express';
import { z } from 'zod';
import sharp from 'sharp';
import { EVENT_CATEGORY_KEYS } from '../lib/categories.js';
import { validateTags } from '../lib/tags.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { requireCommonsAdmin } from '../middleware/auth.js';
import { writeLimiter, portalLimiter } from '../middleware/rate-limit.js';
import { validateRequest, validateUuidParam } from '../lib/helpers.js';
import { uploadToR2 } from '../lib/cloudflare.js';
import { config } from '../config.js';
import { dispatchWebhooks } from '../lib/webhook-delivery.js';
import { auditPortalAction, hashId } from '../lib/audit.js';
import { generateAndStoreKey } from '../lib/api-keys.js';
import { toNeighborhoodEvent, type PortalEventRow } from '../lib/event-transform.js';
import { sanitizeUrl, checkApprovedDomain } from '../lib/url-sanitizer.js';
import { geocodeEventIfNeeded, geocodeSeriesEvents } from '../lib/geocoding.js';
import { pollFeedSource } from '../lib/feed-polling.js';
import {
  toPortalEvent,
  portalInputToInsert,
  PORTAL_SELECT,
  MANAGED_SOURCES,
  toTimestamptz,
  fromTimestamptz,
  getAdminUserId,
  createEventSeries,
  deleteSeriesEvents,
  dispatchSeriesWebhooks,
  generateInstanceDates,
  formatDateStr,
} from './portal.js';

const router: ReturnType<typeof Router> = Router();

// All admin routes require Commons Admin auth
router.use(requireCommonsAdmin);

// =============================================================================
// SCHEMAS
// =============================================================================

const createEventSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  venue_name: z.string().min(1, 'Venue is required').max(200),
  address: z.string().max(500).optional(),
  place_id: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
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
  event_timezone: z.string().max(50).default('America/New_York'),
  description: z.string().max(2000).optional(),
  price: z.string().max(100).optional(),
  ticket_url: z.preprocess(
    (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    z.string().url().max(2000).optional().or(z.literal('')),
  ),
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
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
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
  event_timezone: z.string().max(50).optional(),
  description: z.string().max(2000).optional().nullable(),
  price: z.string().max(100).optional().nullable(),
  ticket_url: z.preprocess(
    (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    z.string().url().max(2000).optional().or(z.literal('')).nullable(),
  ),
  rsvp_limit: z.number().int().min(1).max(10000).nullable().optional(),
  image_focal_y: z.number().min(0).max(1).optional(),
});

const seedAccountSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
  business_name: z.string().min(1).max(200),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(500).optional().or(z.literal('')),
  default_venue_name: z.string().max(200).optional(),
  default_place_id: z.string().max(500).optional(),
  default_address: z.string().max(500).optional(),
  default_latitude: z.number().min(-90).max(90).optional(),
  default_longitude: z.number().min(-180).max(180).optional(),
});

const updateAccountSchema = z.object({
  business_name: z.string().min(1).max(200).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(500).optional().or(z.literal('')),
  default_venue_name: z.string().max(200).optional(),
  default_place_id: z.string().max(500).optional(),
  default_address: z.string().max(500).optional(),
  default_latitude: z.number().min(-90).max(90).optional(),
  default_longitude: z.number().min(-180).max(180).optional(),
  status: z.enum(['active', 'suspended', 'pending', 'rejected']).optional(),
});

const imageUploadSchema = z.object({
  image: z.string().min(1).max(14_000_000),
});

const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  contact_email: z.string().email().max(200),
});

const updateApiKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(['active', 'revoked']).optional(),
});

const SUPPORTED_MAGIC_BYTES: Record<string, string> = {
  'ffd8ff': 'image/jpeg',
  '89504e47': 'image/png',
  '52494646': 'image/webp',
};

/** Per-route body limit override for image uploads (12MB vs global 5MB) */
const imageBodyLimit = expressJson({ limit: '12mb' });

// =============================================================================
// IMAGE PROCESSING
// =============================================================================

/**
 * Validate magic bytes, re-encode through sharp (strips metadata, kills polyglots),
 * upload to R2, and return the public serving URL.
 */
/**
 * Download an image from a URL, re-encode through Sharp, upload to R2,
 * and set event_image_url. Used when approving newsletter candidates.
 */
async function downloadAndAttachImage(eventId: string, imageUrl: string): Promise<void> {
  const response = await fetch(imageUrl, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeighborhoodCommons/1.0)' },
    redirect: 'follow',
  });

  if (!response.ok) {
    console.log(`[COMMONS-ADMIN] Image download HTTP ${response.status} for ${imageUrl}`);
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 8) return;

  // Magic byte check
  const hex = buffer.subarray(0, 4).toString('hex').toLowerCase();
  let valid = false;
  for (const magic of Object.keys(SUPPORTED_MAGIC_BYTES)) {
    if (hex.startsWith(magic)) { valid = true; break; }
  }
  if (!valid) {
    console.log(`[COMMONS-ADMIN] Unsupported image format from ${imageUrl}`);
    return;
  }

  // Re-encode through Sharp (strips metadata, kills polyglot payloads)
  const processed = await sharp(buffer)
    .rotate()
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const r2Key = `portal-events/${eventId}/image`;
  const result = await uploadToR2(r2Key, new Uint8Array(processed), 'image/jpeg');
  if (!result.success) {
    console.error(`[COMMONS-ADMIN] R2 upload failed for candidate image on event ${eventId}`);
    return;
  }

  const finalUrl = `${config.apiBaseUrl}/api/portal/events/${eventId}/image`;
  await supabaseAdmin
    .from('events')
    .update({ event_image_url: finalUrl })
    .eq('id', eventId);

  console.log(`[COMMONS-ADMIN] Attached candidate image to event ${eventId}`);
}

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

// =============================================================================
// STATS
// =============================================================================

/**
 * GET /admin/stats
 * Platform statistics — total accounts, events, etc.
 */
router.get('/stats', portalLimiter, async (_req, res, next) => {
  try {
    const { data: accounts } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, claimed_at, status');

    const totalAccounts = accounts?.length || 0;
    const claimedAccounts = accounts?.filter((a) => a.claimed_at).length || 0;
    const pendingAccounts = accounts?.filter((a) => a.status === 'pending').length || 0;

    const { count: totalEvents } = await supabaseAdmin
      .from('events')
      .select('id', { count: 'exact', head: true })
      .in('source', [...MANAGED_SOURCES]);

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const { count: eventsThisWeek } = await supabaseAdmin
      .from('events')
      .select('id', { count: 'exact', head: true })
      .in('source', [...MANAGED_SOURCES])
      .gte('created_at', oneWeekAgo);

    res.json({
      stats: {
        total_accounts: totalAccounts,
        claimed_accounts: claimedAccounts,
        managed_accounts: totalAccounts - claimedAccounts,
        pending_accounts: pendingAccounts,
        total_events: totalEvents || 0,
        events_this_week: eventsThisWeek || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// ACCOUNTS — LIST / DETAIL / CREATE / UPDATE
// =============================================================================

/**
 * GET /admin/accounts
 * List all portal accounts with event counts.
 */
router.get('/accounts', portalLimiter, async (_req, res, next) => {
  try {
    const { data: accounts, error } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, email, business_name, auth_user_id, status, default_venue_name, default_place_id, default_address, default_latitude, default_longitude, website, phone, logo_url, description, last_login_at, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[COMMONS-ADMIN] Accounts fetch error:', error.message);
      throw createError('Failed to fetch accounts', 500, 'SERVER_ERROR');
    }

    // Count events per account
    const accountIds = (accounts || []).map((a: { id: string }) => a.id);
    let eventCounts: Record<string, number> = {};
    if (accountIds.length > 0) {
      const { data: counts } = await supabaseAdmin
        .from('events')
        .select('creator_account_id')
        .in('source', [...MANAGED_SOURCES])
        .in('creator_account_id', accountIds);

      if (counts) {
        eventCounts = counts.reduce((acc: Record<string, number>, row: { creator_account_id: string }) => {
          acc[row.creator_account_id] = (acc[row.creator_account_id] || 0) + 1;
          return acc;
        }, {});
      }
    }

    const result = (accounts || []).map((a: { id: string }) => ({
      ...a,
      event_count: eventCounts[a.id] || 0,
    }));

    res.json({ accounts: result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/accounts/:id
 * Single account detail with all its events.
 */
router.get('/accounts/:id', portalLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, email, business_name, auth_user_id, status, default_venue_name, default_place_id, default_address, default_latitude, default_longitude, website, phone, logo_url, description, last_login_at, claimed_at, created_at, updated_at')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error || !account) {
      throw createError('Account not found', 404, 'NOT_FOUND');
    }

    const { data: events, error: eventsErr } = await supabaseAdmin
      .from('events')
      .select(PORTAL_SELECT)
      .eq('creator_account_id', account.id)
      .in('source', [...MANAGED_SOURCES])
      .order('event_at', { ascending: false });

    if (eventsErr) {
      console.error('[COMMONS-ADMIN] Account events fetch error:', eventsErr.message, eventsErr.code);
    }

    res.json({ account, events: (events || []).map(toPortalEvent) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/accounts
 * Create/seed a new portal account (status='active' immediately).
 */
router.post('/accounts', writeLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(seedAccountSchema, req.body);

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .insert({
        email: data.email,
        business_name: data.business_name,
        phone: data.phone || null,
        website: data.website || null,
        default_venue_name: data.default_venue_name || null,
        default_place_id: data.default_place_id || null,
        default_address: data.default_address || null,
        default_latitude: data.default_latitude ?? null,
        default_longitude: data.default_longitude ?? null,
        status: 'active', // Admin-seeded accounts are active immediately
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw createError('An account with this email already exists', 409, 'CONFLICT');
      }
      console.error('[COMMONS-ADMIN] Seed account error:', error.message);
      throw createError('Failed to create account', 500, 'SERVER_ERROR');
    }

    console.log(`[COMMONS-ADMIN] Account seeded: ${account.business_name} (${account.email.substring(0, 3)}***)`);
    res.status(201).json({ account });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /admin/accounts/:id
 * Update any account field (business_name, phone, website, defaults, status).
 */
router.patch('/accounts/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    const data = validateRequest(updateAccountSchema, req.body);

    const update: Record<string, unknown> = {};
    if (data.business_name !== undefined) update.business_name = data.business_name;
    if (data.phone !== undefined) update.phone = data.phone || null;
    if (data.website !== undefined) update.website = data.website || null;
    if (data.default_venue_name !== undefined) update.default_venue_name = data.default_venue_name || null;
    if (data.default_place_id !== undefined) update.default_place_id = data.default_place_id || null;
    if (data.default_address !== undefined) update.default_address = data.default_address || null;
    if (data.default_latitude !== undefined) update.default_latitude = data.default_latitude ?? null;
    if (data.default_longitude !== undefined) update.default_longitude = data.default_longitude ?? null;
    if (data.status !== undefined) update.status = data.status;

    if (Object.keys(update).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .update(update)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Account update error:', error.message);
      throw createError('Failed to update account', 500, 'SERVER_ERROR');
    }

    res.json({ account });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// ACCOUNT VERIFICATION — APPROVE / REJECT
// =============================================================================

/**
 * POST /admin/accounts/:id/approve
 * Approve a pending account: status -> active, events -> published.
 */
router.post('/accounts/:id/approve', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');

    // Verify account exists and is pending
    const { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, status, business_name, email')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!account) throw createError('Account not found', 404, 'NOT_FOUND');
    if (account.status !== 'pending') {
      throw createError(`Account is ${account.status}, not pending`, 400, 'INVALID_STATE');
    }

    // Activate account
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('portal_accounts')
      .update({ status: 'active' })
      .eq('id', req.params.id)
      .select()
      .single();

    if (updateErr) {
      console.error('[COMMONS-ADMIN] Approve error:', updateErr.message);
      throw createError('Failed to approve account', 500, 'SERVER_ERROR');
    }

    // Publish all pending_review events
    const { data: publishedEvents } = await supabaseAdmin
      .from('events')
      .update({ status: 'published' })
      .eq('creator_account_id', req.params.id)
      .eq('status', 'pending_review')
      .select('id');

    const publishedCount = publishedEvents?.length || 0;

    // Dispatch webhooks for newly-published events (fire-and-forget)
    if (publishedEvents && publishedEvents.length > 0) {
      void dispatchSeriesWebhooks(publishedEvents);
    }

    auditPortalAction('portal_account_approved', req.user?.id || 'unknown', req.params.id,
      { events_published: publishedCount, business_name: account.business_name });
    console.log(`[COMMONS-ADMIN] Account approved: ${account.business_name} (${account.email.substring(0, 3)}***), ${publishedCount} events published`);
    res.json({ account: updated, events_published: publishedCount });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/accounts/:id/reject
 * Reject a pending account: delete pending events, status -> rejected.
 */
router.post('/accounts/:id/reject', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');

    const { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, status, business_name, email')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!account) throw createError('Account not found', 404, 'NOT_FOUND');
    if (account.status !== 'pending') {
      throw createError(`Account is ${account.status}, not pending`, 400, 'INVALID_STATE');
    }

    // Delete all pending_review events
    const { data: deletedEvents } = await supabaseAdmin
      .from('events')
      .delete()
      .eq('creator_account_id', req.params.id)
      .eq('status', 'pending_review')
      .select('id');

    const deletedCount = deletedEvents?.length || 0;

    // Reject account
    const { error: updateErr } = await supabaseAdmin
      .from('portal_accounts')
      .update({ status: 'rejected' })
      .eq('id', req.params.id);

    if (updateErr) {
      console.error('[COMMONS-ADMIN] Reject error:', updateErr.message);
      throw createError('Failed to reject account', 500, 'SERVER_ERROR');
    }

    auditPortalAction('portal_account_rejected', req.user?.id || 'unknown', req.params.id,
      { events_deleted: deletedCount, business_name: account.business_name });
    console.log(`[COMMONS-ADMIN] Account rejected: ${account.business_name} (${account.email.substring(0, 3)}***), ${deletedCount} events deleted`);
    res.json({ success: true, events_deleted: deletedCount });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// ACCOUNT SUSPEND / REACTIVATE
// =============================================================================

/**
 * POST /admin/accounts/:id/suspend
 * Freeze an active account: status -> suspended, events -> suspended.
 */
router.post('/accounts/:id/suspend', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');

    const { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, status, business_name, email')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!account) throw createError('Account not found', 404, 'NOT_FOUND');
    if (account.status !== 'active') {
      throw createError(`Account is ${account.status}, not active`, 400, 'INVALID_STATE');
    }

    const { data, error } = await supabaseAdmin.rpc('suspend_portal_account', {
      p_account_id: req.params.id,
    });

    if (error) {
      console.error('[COMMONS-ADMIN] Suspend error:', error.message);
      throw createError('Failed to suspend account', 500, 'SERVER_ERROR');
    }

    const eventsSuspended = Array.isArray(data) ? (data[0]?.events_suspended ?? 0) : 0;

    auditPortalAction('portal_account_suspended', req.user?.id || 'unknown', req.params.id,
      { events_suspended: eventsSuspended, business_name: account.business_name });
    console.log(`[COMMONS-ADMIN] Account suspended: ${account.business_name} (${account.email.substring(0, 3)}***), ${eventsSuspended} events suspended`);
    res.json({ success: true, events_suspended: eventsSuspended });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/accounts/:id/reactivate
 * Unfreeze a suspended account: status -> active, events -> published.
 */
router.post('/accounts/:id/reactivate', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');

    const { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, status, business_name, email')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!account) throw createError('Account not found', 404, 'NOT_FOUND');
    if (account.status !== 'suspended') {
      throw createError(`Account is ${account.status}, not suspended`, 400, 'INVALID_STATE');
    }

    const { data, error } = await supabaseAdmin.rpc('reactivate_portal_account', {
      p_account_id: req.params.id,
    });

    if (error) {
      console.error('[COMMONS-ADMIN] Reactivate error:', error.message);
      throw createError('Failed to reactivate account', 500, 'SERVER_ERROR');
    }

    const eventsReactivated = Array.isArray(data) ? (data[0]?.events_reactivated ?? 0) : 0;

    // Dispatch webhooks for re-published events (fire-and-forget)
    if (eventsReactivated > 0) {
      const { data: republished } = await supabaseAdmin
        .from('events')
        .select('id')
        .eq('creator_account_id', req.params.id)
        .eq('status', 'published')
        .in('source', [...MANAGED_SOURCES]);
      if (republished) void dispatchSeriesWebhooks(republished);
    }

    auditPortalAction('portal_account_reactivated', req.user?.id || 'unknown', req.params.id,
      { events_reactivated: eventsReactivated, business_name: account.business_name });
    console.log(`[COMMONS-ADMIN] Account reactivated: ${account.business_name} (${account.email.substring(0, 3)}***), ${eventsReactivated} events republished`);
    res.json({ success: true, events_reactivated: eventsReactivated });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// ACTIVITY LOG
// =============================================================================

/**
 * GET /admin/accounts/:id/activity
 * Fetch audit trail for a specific portal account.
 */
router.get('/accounts/:id/activity', portalLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');

    // Verify account exists
    const { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!account) throw createError('Account not found', 404, 'NOT_FOUND');

    // Hash the account ID to match audit_logs storage
    const accountHash = hashId(req.params.id);

    // Query audit logs where the account is actor OR resource
    const { data: logs, error } = await supabaseAdmin
      .from('audit_logs')
      .select('id, action, result, reason, endpoint, metadata, created_at')
      .or(`actor_hash.eq.${accountHash},resource_hash.eq.${accountHash}`)
      .like('action', 'portal_%')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[COMMONS-ADMIN] Activity log error:', error.message);
      throw createError('Failed to fetch activity log', 500, 'SERVER_ERROR');
    }

    res.json({ activity: logs || [] });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// EVENTS — CREATE ON BEHALF / LIST ALL / EDIT / DELETE
// =============================================================================

/**
 * POST /admin/accounts/:id/events
 * Create an event on behalf of a business.
 */
router.post('/accounts/:id/events', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    const data = validateRequest(createEventSchema, req.body);
    const adminUserId = getAdminUserId();

    const { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, business_name')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!account) {
      throw createError('Account not found', 404, 'NOT_FOUND');
    }

    if (data.category === 'other') {
      if (!data.custom_category || data.custom_category.trim().length === 0) {
        throw createError('Custom category is required when category is "other"', 400, 'VALIDATION_ERROR');
      }
      const wordCount = data.custom_category.trim().split(/\s+/).length;
      if (wordCount > 3) {
        throw createError('Custom category must be 1-3 words', 400, 'VALIDATION_ERROR');
      }
    }

    const insertData = portalInputToInsert(data, account.id, adminUserId);

    // Recurring events
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

      console.log(`[COMMONS-ADMIN] Series created for ${account.business_name}: "${data.title}" (${instances.length} instances)`);
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

    // Single event
    const { data: event, error } = await supabaseAdmin
      .from('events')
      .insert(insertData)
      .select(PORTAL_SELECT)
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Event create error:', error.message);
      throw createError('Failed to create event', 500, 'SERVER_ERROR');
    }

    console.log(`[COMMONS-ADMIN] Event created for ${account.business_name}: "${data.title}" (${event.id})`);

    // Fire-and-forget geocode if address present but no coordinates
    void geocodeEventIfNeeded(event.id, insertData.venue_address as string | null, insertData.latitude as number | null, insertData.longitude as number | null, account.id);

    // Dispatch webhook (fire-and-forget) — admin-created events are always published
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
        console.error('[COMMONS-ADMIN] Webhook dispatch error:', err instanceof Error ? err.message : err);
      }
    })();

    res.status(201).json({ event: toPortalEvent(event) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/events
 * All events across all accounts (with business info).
 */
router.get('/events', portalLimiter, async (_req, res, next) => {
  try {
    const { data: events, error } = await supabaseAdmin
      .from('events')
      .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name, email)`)
      .in('source', [...MANAGED_SOURCES])
      .order('event_at', { ascending: false })
      .limit(200);

    if (error) {
      console.error('[COMMONS-ADMIN] Events fetch error:', error.message);
      throw createError('Failed to fetch events', 500, 'SERVER_ERROR');
    }

    // Convert to portal format, preserving the portal_accounts join
    const result = (events || []).map((e) => {
      const pe = toPortalEvent(e);
      pe.portal_accounts = e.portal_accounts;
      return pe;
    });

    res.json({ events: result });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /admin/events/batch
 * Bulk-update multiple events (admin override, no RLS).
 * Same field set as portal batch — safe bulk fields only.
 *
 * NOTE: Must be defined before /events/:id to avoid route conflict.
 */
const adminBatchUpdateSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(50),
  updates: z.object({
    category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
    custom_category: z.string().max(30).optional().nullable(),
    tags: z.array(z.string().max(50)).max(15).optional(),
    wheelchair_accessible: z.boolean().nullable().optional(),
    start_time_required: z.boolean().optional(),
    description: z.string().max(2000).optional().nullable(),
    price: z.string().max(100).optional().nullable(),
  }).refine((u) => Object.keys(u).length > 0, { message: 'No fields to update' }),
});

router.patch('/events/batch', writeLimiter, async (req, res, next) => {
  try {
    const adminUserId = getAdminUserId();
    const { ids, updates } = validateRequest(adminBatchUpdateSchema, req.body);

    if (updates.category === 'other') {
      if (!updates.custom_category || updates.custom_category.trim().length === 0) {
        throw createError('Custom category is required when category is "other"', 400, 'VALIDATION_ERROR');
      }
    }

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
    if (updates.start_time_required !== undefined) dbUpdate.start_time_required = updates.start_time_required;
    if (updates.description !== undefined) dbUpdate.description = updates.description || null;
    if (updates.price !== undefined) dbUpdate.price = updates.price || null;

    const { data: updated, error } = await supabaseAdmin
      .from('events')
      .update(dbUpdate)
      .in('id', ids)
      .in('source', [...MANAGED_SOURCES])
      .select('id, creator_account_id');

    if (error) {
      console.error('[ADMIN] Batch update error:', error.message);
      throw createError('Failed to update events', 500, 'SERVER_ERROR');
    }

    const updatedRows = (updated || []) as { id: string; creator_account_id: string }[];

    for (const row of updatedRows) {
      auditPortalAction('portal_event_updated', adminUserId, row.id,
        undefined, '/api/portal/admin/events/batch');
    }

    // Dispatch webhooks (fire-and-forget)
    void (async () => {
      try {
        for (const row of updatedRows) {
          const { data: full } = await supabaseAdmin
            .from('events')
            .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
            .eq('id', row.id)
            .maybeSingle();
          if (full) {
            void dispatchWebhooks('event.updated', row.id, toNeighborhoodEvent(full as unknown as PortalEventRow));
          }
        }
      } catch (err) {
        console.error('[ADMIN] Batch webhook dispatch error:', err instanceof Error ? err.message : err);
      }
    })();

    res.json({ updated: updatedRows.length, ids: updatedRows.map((r) => r.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /admin/events/series/:seriesId
 * Update all future instances of a series (admin override, no RLS).
 * Handles field updates + instance count changes (add/remove instances).
 * NOTE: Must be defined before /events/:id to avoid route conflict.
 */
router.patch('/events/series/:seriesId', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.seriesId, 'series ID');
    const data = validateRequest(updateEventSchema, req.body);

    // Fetch the series metadata
    const { data: series } = await supabaseAdmin
      .from('event_series')
      .select('id, recurrence, base_event_data, creator_account_id')
      .eq('id', req.params.seriesId)
      .maybeSingle();

    if (!series) throw createError('Series not found', 404, 'NOT_FOUND');

    const baseData = (series.base_event_data as Record<string, unknown>) || {};

    // Fetch all future instances
    const now = new Date().toISOString();
    const { data: futureEvents, error: fetchErr } = await supabaseAdmin
      .from('events')
      .select(PORTAL_SELECT)
      .eq('series_id', req.params.seriesId)
      .in('source', [...MANAGED_SOURCES])
      .gte('event_at', now)
      .order('event_at', { ascending: true });

    if (fetchErr) {
      console.error('[COMMONS-ADMIN] Series fetch error:', fetchErr.message);
      throw createError('Failed to fetch series events', 500, 'SERVER_ERROR');
    }

    if (!futureEvents || futureEvents.length === 0) {
      throw createError('No upcoming events in this series', 404, 'NOT_FOUND');
    }

    const refEvent = futureEvents[0]!;
    const tz = data.event_timezone || (refEvent.event_timezone as string) || 'America/New_York';

    // Build template update
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
    if (data.recurrence !== undefined) templateUpdate.recurrence = data.recurrence;
    if (data.image_focal_y !== undefined) templateUpdate.event_image_focal_y = data.image_focal_y;

    const hasTimeChange = data.start_time !== undefined || data.end_time !== undefined;
    const hasInstanceCountChange = data.instance_count !== undefined;

    if (Object.keys(templateUpdate).length === 0 && !hasTimeChange && !hasInstanceCountChange) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    // Update each future instance
    let updatedCount = 0;
    for (const ev of futureEvents) {
      const instanceUpdate: Record<string, unknown> = { ...templateUpdate };

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
        console.error(`[COMMONS-ADMIN] Series instance update error (${(ev as Record<string, unknown>).id}):`, updateErr.message);
      } else {
        updatedCount++;
      }
    }

    // Update base_event_data on the series row
    const newBase = { ...baseData };
    const columnToBaseKey: Record<string, string> = {
      content: 'content', place_name: 'place_name', venue_address: 'venue_address',
      place_id: 'place_id', latitude: 'latitude', longitude: 'longitude',
      category: 'category', custom_category: 'custom_category',
      description: 'description', price: 'price', link_url: 'link_url',
      event_image_focal_y: 'event_image_focal_y',
    };
    for (const [col, baseKey] of Object.entries(columnToBaseKey)) {
      if (col in templateUpdate) {
        newBase[baseKey] = templateUpdate[col];
      }
    }
    await supabaseAdmin
      .from('event_series')
      .update({ base_event_data: newBase })
      .eq('id', req.params.seriesId);

    // Handle instance_count changes
    let instancesAdded = 0;
    let instancesRemoved = 0;
    if (hasInstanceCountChange) {
      const seriesRecurrence = series.recurrence as string;
      if (seriesRecurrence && seriesRecurrence !== 'none') {
        const desiredCount = generateInstanceDates('2025-01-01', seriesRecurrence, data.instance_count).length;

        const { data: allFuture } = await supabaseAdmin
          .from('events')
          .select('id, event_at, event_timezone, end_time, series_instance_number')
          .eq('series_id', req.params.seriesId)
          .in('source', [...MANAGED_SOURCES])
          .gte('event_at', now)
          .order('event_at', { ascending: true });

        const currentFutureCount = allFuture?.length || 0;

        if (desiredCount > currentFutureCount && allFuture && allFuture.length > 0) {
          const lastFuture = allFuture[allFuture.length - 1]!;
          const lastTz = (lastFuture.event_timezone as string) || tz;
          const lastParsed = fromTimestamptz(lastFuture.event_at as string, lastTz);
          const lastNum = (lastFuture.series_instance_number as number) || allFuture.length;

          const startTime = lastParsed.time;
          let endTime: string | null = null;
          if (lastFuture.end_time) {
            endTime = fromTimestamptz(lastFuture.end_time as string, lastTz).time;
          }

          const lastDate = new Date(lastParsed.date + 'T12:00:00');
          lastDate.setDate(lastDate.getDate() + 1);
          const newStartDate = formatDateStr(lastDate);

          const needed = desiredCount - currentFutureCount;
          const newDates = generateInstanceDates(newStartDate, seriesRecurrence, needed);

          if (newDates.length > 0) {
            const { data: templateEvent } = await supabaseAdmin
              .from('events')
              .select('creator_account_id, source, visibility, status, is_business, region_id, event_timezone, event_image_url, event_image_focal_y')
              .eq('series_id', req.params.seriesId)
              .limit(1)
              .single();

            if (templateEvent) {
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
                  source: templateEvent.source,
                  visibility: templateEvent.visibility,
                  status: templateEvent.status,
                  is_business: templateEvent.is_business,
                  region_id: templateEvent.region_id,
                  event_timezone: lastTz,
                  event_image_url: templateEvent.event_image_url,
                  event_image_focal_y: templateEvent.event_image_focal_y,
                  event_at: eventAt,
                  end_time: endTimeTs,
                  recurrence: seriesRecurrence,
                  series_id: series.id,
                  series_instance_number: lastNum + i + 1,
                };
              });

              const { data: created, error: insertErr } = await supabaseAdmin
                .from('events')
                .insert(rows)
                .select('id');

              if (insertErr) {
                console.error('[COMMONS-ADMIN] Series instance expansion error:', insertErr.message);
              } else {
                instancesAdded = created?.length || 0;
              }
            }
          }
        } else if (desiredCount < currentFutureCount && allFuture) {
          const toRemove = allFuture.slice(desiredCount);
          const removeIds = toRemove.map((e) => (e as Record<string, unknown>).id as string);
          if (removeIds.length > 0) {
            const { error: delErr } = await supabaseAdmin
              .from('events')
              .delete()
              .in('id', removeIds);

            if (delErr) {
              console.error('[COMMONS-ADMIN] Series instance removal error:', delErr.message);
            } else {
              instancesRemoved = removeIds.length;
            }
          }
        }

        const finalCount = (allFuture?.length || 0) + instancesAdded - instancesRemoved;
        const updatedRule = { frequency: seriesRecurrence, count: finalCount };
        await supabaseAdmin
          .from('event_series')
          .update({ recurrence_rule: updatedRule })
          .eq('id', series.id);
      }
    }

    const totalAfter = futureEvents.length + instancesAdded - instancesRemoved;
    console.log(`[COMMONS-ADMIN] Series ${req.params.seriesId} updated: ${updatedCount}/${futureEvents.length} instances` +
      (instancesAdded ? `, +${instancesAdded} added` : '') +
      (instancesRemoved ? `, -${instancesRemoved} removed` : ''));

    // Dispatch webhooks (fire-and-forget)
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
        console.error('[COMMONS-ADMIN] Series webhook dispatch error:', err instanceof Error ? err.message : err);
      }
    })();

    res.json({ updated: updatedCount, total: totalAfter, added: instancesAdded, removed: instancesRemoved });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /admin/events/:id
 * Edit any event (admin override, no RLS).
 */
router.patch('/events/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const data = validateRequest(updateEventSchema, req.body);

    if (data.category === 'other') {
      if (!data.custom_category || data.custom_category.trim().length === 0) {
        throw createError('Custom category is required when category is "other"', 400, 'VALIDATION_ERROR');
      }
    }

    // Fetch existing event to get timezone
    const { data: existing } = await supabaseAdmin
      .from('events')
      .select('event_timezone, event_at')
      .eq('id', req.params.id)
      .in('source', [...MANAGED_SOURCES])
      .maybeSingle();

    if (!existing) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const tz = data.event_timezone || (existing.event_timezone as string) || 'America/New_York';

    const update: Record<string, unknown> = {};
    if (data.title !== undefined) update.content = data.title;
    if (data.venue_name !== undefined) update.place_name = data.venue_name;
    if (data.address !== undefined) update.venue_address = data.address || null;
    if (data.place_id !== undefined) update.place_id = data.place_id || null;
    if (data.latitude !== undefined) update.latitude = data.latitude ?? null;
    if (data.longitude !== undefined) update.longitude = data.longitude ?? null;
    if (data.latitude !== undefined || data.longitude !== undefined) {
      const lat = data.latitude ?? null;
      const lng = data.longitude ?? null;
      update.approximate_location = lat != null && lng != null
        ? `POINT(${lng} ${lat})`
        : null;
    }
    if (data.event_date !== undefined || data.start_time !== undefined) {
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
    if (data.image_focal_y !== undefined) update.event_image_focal_y = data.image_focal_y;

    if (Object.keys(update).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const { data: event, error } = await supabaseAdmin
      .from('events')
      .update(update)
      .eq('id', req.params.id)
      .in('source', [...MANAGED_SOURCES])
      .select(PORTAL_SELECT)
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Event update error:', error.message);
      throw createError('Failed to update event', 500, 'SERVER_ERROR');
    }

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
        console.error('[COMMONS-ADMIN] Webhook dispatch error:', err instanceof Error ? err.message : err);
      }
    })();

    res.json({ event: toPortalEvent(event) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /admin/events/series/:seriesId
 * Delete all events in a series.
 * NOTE: Must be defined before /events/:id to avoid route conflict.
 */
router.delete('/events/series/:seriesId', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.seriesId, 'series ID');
    const deleted = await deleteSeriesEvents(req.params.seriesId);
    if (deleted === 0) {
      throw createError('Series not found', 404, 'NOT_FOUND');
    }
    res.json({ success: true, deleted });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /admin/events/:id
 * Delete any event.
 */
router.delete('/events/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');

    const { error } = await supabaseAdmin
      .from('events')
      .delete()
      .eq('id', req.params.id)
      .in('source', [...MANAGED_SOURCES]);

    if (error) {
      console.error('[COMMONS-ADMIN] Event delete error:', error.message);
      throw createError('Failed to delete event', 500, 'SERVER_ERROR');
    }

    void dispatchWebhooks('event.deleted', req.params.id, {
      id: req.params.id, name: '', start: '', end: null, timezone: 'UTC', description: null,
      category: [], place_id: null,
      location: { name: '', address: null, lat: null, lng: null },
      url: null, images: [], organizer: { name: '', phone: null },
      cost: null, series_id: null, series_instance_number: null, series_instance_count: null, start_time_required: true, tags: [], wheelchair_accessible: null, recurrence: null,
      source: { publisher: 'neighborhood-commons', collected_at: new Date().toISOString(), method: 'portal', license: 'CC BY 4.0' },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// IMAGE UPLOAD (admin can upload for any portal event)
// =============================================================================

/**
 * POST /admin/events/:id/image
 * Admin uploads an event image (bypasses portal account ownership check).
 */
router.post('/events/:id/image', imageBodyLimit, writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const { image } = validateRequest(imageUploadSchema, req.body);

    // Verify event exists (admin — use supabaseAdmin, no RLS)
    const { data: event } = await supabaseAdmin
      .from('events')
      .select('id')
      .eq('id', req.params.id)
      .in('source', [...MANAGED_SOURCES])
      .maybeSingle();

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const imageUrl = await processAndUploadImage(req.params.id, image);

    const { error: updateError } = await supabaseAdmin
      .from('events')
      .update({ event_image_url: imageUrl })
      .eq('id', req.params.id)
      .in('source', [...MANAGED_SOURCES]);

    if (updateError) {
      console.error('[COMMONS-ADMIN] Image URL update error:', updateError.message);
      throw createError('Failed to save image reference', 500, 'SERVER_ERROR');
    }

    res.json({ image_url: imageUrl });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// API KEY MANAGEMENT
// =============================================================================

/**
 * POST /admin/api-keys
 * Create a new API key.
 */
router.post('/api-keys', writeLimiter, async (req, res, next) => {
  try {
    const { name, contact_email } = validateRequest(createApiKeySchema, req.body);

    const key = await generateAndStoreKey(name, contact_email);

    res.status(201).json({
      api_key: {
        id: key.id,
        raw_key: key.raw_key,
        name: key.name,
        contact_email,
        rate_limit_per_hour: 1000,
        status: 'active',
        created_at: key.created_at,
      },
      note: 'Save the raw_key — it will not be shown again.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/api-keys
 * List all API keys.
 */
router.get('/api-keys', portalLimiter, async (_req, res, next) => {
  try {
    const { data: keys, error } = await supabaseAdmin
      .from('api_keys')
      .select('id, key_prefix, name, contact_email, rate_limit_per_hour, status, last_used_at, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[COMMONS-ADMIN] API keys list error:', error.message);
      throw createError('Failed to list API keys', 500, 'SERVER_ERROR');
    }

    res.json({ api_keys: keys || [] });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /admin/api-keys/:id
 * Update API key name or status.
 */
router.patch('/api-keys/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const id = req.params.id;
    const updates = validateRequest(updateApiKeySchema, req.body);

    if (Object.keys(updates).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const { data: apiKey, error } = await supabaseAdmin
      .from('api_keys')
      .update(updates)
      .eq('id', id)
      .select('id, key_prefix, name, contact_email, rate_limit_per_hour, status, last_used_at, created_at')
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] API key update error:', error.message);
      throw createError('Failed to update API key', 500, 'SERVER_ERROR');
    }

    res.json({ api_key: apiKey });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /admin/api-keys/:id
 * Revoke an API key (soft delete — sets status='revoked').
 */
router.delete('/api-keys/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const id = req.params.id;

    const { error } = await supabaseAdmin
      .from('api_keys')
      .update({ status: 'revoked' })
      .eq('id', id);

    if (error) {
      console.error('[COMMONS-ADMIN] API key revoke error:', error.message);
      throw createError('Failed to revoke API key', 500, 'SERVER_ERROR');
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// NEWSLETTER INGESTION — Sources, Emails, and Event Candidates
// =============================================================================

const createNewsletterSourceSchema = z.object({
  name: z.string().min(1).max(200),
  sender_email: z.string().email().max(320).optional(),
  notes: z.string().max(2000).optional(),
  auto_approve: z.boolean().optional().default(false),
});

const updateNewsletterSourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  sender_email: z.string().email().max(320).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  auto_approve: z.boolean().optional(),
  status: z.enum(['active', 'paused', 'retired']).optional(),
});

const approveCandidateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  venue_name: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (expected YYYY-MM-DD)').optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Invalid time format (expected HH:MM)').transform(t => t.slice(0, 5)).optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Invalid time format (expected HH:MM)').transform(t => t.slice(0, 5)).optional(),
  price: z.string().max(100).optional(),
  event_timezone: z.string().max(50).optional(),
});

const rejectCandidateSchema = z.object({
  review_notes: z.string().max(2000).optional(),
});

const duplicateCandidateSchema = z.object({
  matched_event_id: z.string().uuid().optional(),
});

// ─── Newsletter Sources ─────────────────────────────────────────

router.get('/newsletter-sources', portalLimiter, async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('newsletter_sources')
      .select('id, name, sender_email, notes, auto_approve, status, created_at, last_received_at')
      .order('last_received_at', { ascending: false, nullsFirst: false });

    if (error) {
      console.error('[COMMONS-ADMIN] Newsletter sources list error:', error.message);
      throw createError('Failed to list newsletter sources', 500, 'SERVER_ERROR');
    }

    res.json({ sources: data || [] });
  } catch (err) {
    next(err);
  }
});

router.post('/newsletter-sources', writeLimiter, async (req, res, next) => {
  try {
    const input = validateRequest(createNewsletterSourceSchema, req.body);

    const { data, error } = await supabaseAdmin
      .from('newsletter_sources')
      .insert({
        name: input.name,
        sender_email: input.sender_email || null,
        notes: input.notes || null,
        auto_approve: input.auto_approve,
      })
      .select('id, name, sender_email, notes, auto_approve, status, created_at, last_received_at')
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Newsletter source create error:', error.message);
      throw createError('Failed to create newsletter source', 500, 'SERVER_ERROR');
    }

    console.log(`[COMMONS-ADMIN] Created newsletter source "${input.name}"`);
    res.status(201).json({ source: data });
  } catch (err) {
    next(err);
  }
});

router.patch('/newsletter-sources/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const input = validateRequest(updateNewsletterSourceSchema, req.body);

    // Build update object with only provided fields
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.sender_email !== undefined) updates.sender_email = input.sender_email;
    if (input.notes !== undefined) updates.notes = input.notes;
    if (input.auto_approve !== undefined) updates.auto_approve = input.auto_approve;
    if (input.status !== undefined) updates.status = input.status;

    if (Object.keys(updates).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const { data, error } = await supabaseAdmin
      .from('newsletter_sources')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, name, sender_email, notes, auto_approve, status, created_at, last_received_at')
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Newsletter source update error:', error.message);
      throw createError('Failed to update newsletter source', 500, 'SERVER_ERROR');
    }

    if (!data) {
      throw createError('Newsletter source not found', 404, 'NOT_FOUND');
    }

    console.log(`[COMMONS-ADMIN] Updated newsletter source ${req.params.id}`);
    res.json({ source: data });
  } catch (err) {
    next(err);
  }
});

// ─── Newsletter Emails ──────────────────────────────────────────

router.get('/newsletter-emails', portalLimiter, async (req, res, next) => {
  try {
    const sourceId = typeof req.query.source_id === 'string' ? req.query.source_id : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    let query = supabaseAdmin
      .from('newsletter_emails')
      .select('id, source_id, message_id, sender_email, subject, received_at, processing_status, processing_error, candidate_count, newsletter_sources(name)')
      .order('received_at', { ascending: false })
      .limit(limit);

    if (sourceId) {
      validateUuidParam(sourceId, 'source_id');
      query = query.eq('source_id', sourceId);
    }
    if (status) {
      query = query.eq('processing_status', status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[COMMONS-ADMIN] Newsletter emails list error:', error.message);
      throw createError('Failed to list newsletter emails', 500, 'SERVER_ERROR');
    }

    res.json({ emails: data || [] });
  } catch (err) {
    next(err);
  }
});

router.get('/newsletter-emails/:id', portalLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');

    const { data: email, error } = await supabaseAdmin
      .from('newsletter_emails')
      .select('id, source_id, message_id, sender_email, subject, body_html, body_plain, received_at, processing_status, processing_error, candidate_count, llm_response, newsletter_sources(name)')
      .eq('id', req.params.id)
      .single();

    if (error || !email) {
      throw createError('Newsletter email not found', 404, 'NOT_FOUND');
    }

    // Fetch candidates for this email
    const { data: candidates } = await supabaseAdmin
      .from('event_candidates')
      .select('id, title, description, start_date, start_time, end_time, location_name, location_address, location_lat, location_lng, source_url, confidence, status, matched_event_id, match_confidence, review_notes, created_at, reviewed_at')
      .eq('email_id', req.params.id)
      .order('created_at', { ascending: true });

    res.json({ email, candidates: candidates || [] });
  } catch (err) {
    next(err);
  }
});

// ─── Feed Sources ───────────────────────────────────────────────

const FEED_TYPES = ['ical', 'rss', 'eventbrite', 'agile_ticketing'] as const;

const createFeedSourceSchema = z.object({
  name: z.string().min(1).max(200),
  feed_url: z.string().url(),
  feed_type: z.enum(FEED_TYPES).optional().default('ical'),
  poll_interval_hours: z.number().int().min(1).max(168).optional().default(24),
  default_location: z.string().max(500).optional(),
  default_timezone: z.string().max(100).optional().default('America/New_York'),
  notes: z.string().max(2000).optional(),
});

const updateFeedSourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  feed_url: z.string().url().optional(),
  feed_type: z.enum(FEED_TYPES).optional(),
  poll_interval_hours: z.number().int().min(1).max(168).optional(),
  default_location: z.string().max(500).nullable().optional(),
  default_timezone: z.string().max(100).optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'paused', 'retired']).optional(),
});

router.get('/feed-sources', portalLimiter, async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('feed_sources')
      .select('id, name, feed_url, feed_type, poll_interval_hours, status, default_location, default_timezone, notes, created_at, last_polled_at, last_poll_result, last_poll_error, last_event_count')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[COMMONS-ADMIN] Feed sources list error:', error.message);
      throw createError('Failed to list feed sources', 500, 'SERVER_ERROR');
    }

    res.json({ sources: data || [] });
  } catch (err) {
    next(err);
  }
});

router.post('/feed-sources', writeLimiter, async (req, res, next) => {
  try {
    const input = validateRequest(createFeedSourceSchema, req.body);

    const { data: source, error } = await supabaseAdmin
      .from('feed_sources')
      .insert({
        name: input.name,
        feed_url: input.feed_url,
        feed_type: input.feed_type,
        poll_interval_hours: input.poll_interval_hours,
        default_location: input.default_location || null,
        default_timezone: input.default_timezone,
        notes: input.notes || null,
      })
      .select('id, name, feed_url, feed_type, status')
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Create feed source error:', error.message);
      throw createError('Failed to create feed source', 500, 'SERVER_ERROR');
    }

    const adminId = getAdminUserId();
    auditPortalAction('feed_source_created', adminId, source.id as string);
    console.log(`[COMMONS-ADMIN] Created feed source "${input.name}"`);

    res.status(201).json({ source });
  } catch (err) {
    next(err);
  }
});

router.patch('/feed-sources/:id', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const input = validateRequest(updateFeedSourceSchema, req.body);

    const { data: source, error } = await supabaseAdmin
      .from('feed_sources')
      .update(input)
      .eq('id', req.params.id)
      .select('id, name, feed_url, feed_type, poll_interval_hours, status, default_location, default_timezone, notes')
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Update feed source error:', error.message);
      throw createError('Failed to update feed source', 500, 'SERVER_ERROR');
    }

    const adminId = getAdminUserId();
    auditPortalAction('feed_source_updated', adminId, req.params.id);
    res.json({ source });
  } catch (err) {
    next(err);
  }
});

router.post('/feed-sources/:id/poll', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');

    const { data: source, error: fetchErr } = await supabaseAdmin
      .from('feed_sources')
      .select('id, name, feed_url, feed_type, poll_interval_hours, status, default_location, default_timezone, last_polled_at')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !source) {
      throw createError('Feed source not found', 404, 'NOT_FOUND');
    }

    const result = await pollFeedSource(source as unknown as Parameters<typeof pollFeedSource>[0]);

    const adminId = getAdminUserId();
    auditPortalAction('feed_source_polled', adminId, req.params.id, {
      candidates: result.candidateCount,
      skipped: result.skippedDuplicates,
    });

    res.json({ result });
  } catch (err) {
    next(err);
  }
});

// ─── Event Candidates ───────────────────────────────────────────

router.get('/event-candidates', portalLimiter, async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    let query = supabaseAdmin
      .from('event_candidates')
      .select('id, email_id, source_id, feed_source_id, title, description, start_date, start_time, end_time, location_name, location_address, location_lat, location_lng, source_url, confidence, status, matched_event_id, match_confidence, review_notes, created_at, reviewed_at, candidate_image_url, newsletter_emails(subject), newsletter_sources(name), feed_sources(name)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[COMMONS-ADMIN] Event candidates list error:', error.message);
      throw createError('Failed to list event candidates', 500, 'SERVER_ERROR');
    }

    res.json({ candidates: data || [] });
  } catch (err) {
    next(err);
  }
});

// GET /event-candidates/:id — detail with source email body
router.get('/event-candidates/:id', portalLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');

    const { data: candidate, error } = await supabaseAdmin
      .from('event_candidates')
      .select('id, email_id, source_id, feed_source_id, title, description, start_date, start_time, end_time, location_name, location_address, location_lat, location_lng, source_url, confidence, status, matched_event_id, match_confidence, review_notes, created_at, reviewed_at, candidate_image_url, extraction_metadata, newsletter_emails(subject, body_plain, body_html, sender_email, received_at), newsletter_sources(name), feed_sources(name)')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) {
      console.error('[COMMONS-ADMIN] Event candidate detail error:', error.message);
      throw createError('Failed to fetch candidate', 500, 'SERVER_ERROR');
    }

    if (!candidate) {
      throw createError('Candidate not found', 404, 'NOT_FOUND');
    }

    res.json({ candidate });
  } catch (err) {
    next(err);
  }
});

router.post('/event-candidates/:id/approve', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const overrides = req.body && Object.keys(req.body).length > 0
      ? validateRequest(approveCandidateSchema, req.body)
      : {};

    // Fetch the candidate
    const { data: candidate, error: fetchErr } = await supabaseAdmin
      .from('event_candidates')
      .select('id, title, description, start_date, start_time, end_time, location_name, location_address, location_lat, location_lng, source_url, confidence, status, source_id, feed_source_id, candidate_image_url, newsletter_sources(name), feed_sources(name)')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !candidate) {
      throw createError('Event candidate not found', 404, 'NOT_FOUND');
    }

    if (candidate.status !== 'pending') {
      throw createError(`Candidate is already ${candidate.status}`, 409, 'CONFLICT');
    }

    // Build event data from candidate + overrides
    const title = overrides.title || (candidate.title as string);
    const description = overrides.description || (candidate.description as string | null);
    const eventDate = overrides.event_date || (candidate.start_date as string | null);
    const startTime = overrides.start_time || (candidate.start_time as string | null);
    const endTime = overrides.end_time || (candidate.end_time as string | null);
    const venueName = overrides.venue_name || (candidate.location_name as string | null);
    const address = overrides.address || (candidate.location_address as string | null);
    const category = overrides.category || 'community';
    const price = overrides.price || null;
    const timezone = overrides.event_timezone || 'America/New_York';

    if (!eventDate) {
      throw createError('Event date is required to approve', 400, 'VALIDATION_ERROR');
    }

    // Build event_at timestamp
    const timeStr = startTime || '12:00';
    const eventAt = toTimestamptz(eventDate, timeStr, timezone);
    const endTimeAt = endTime ? toTimestamptz(eventDate, endTime, timezone) : null;

    // Source publisher from newsletter source name
    const sourceJoin = candidate.newsletter_sources as unknown as { name: string } | null;
    const feedJoin = candidate.feed_sources as unknown as { name: string } | null;
    const sourceName = sourceJoin?.name || feedJoin?.name;

    // Insert the real event
    const { data: event, error: insertErr } = await supabaseAdmin
      .from('events')
      .insert({
        content: title,
        description: description || null,
        event_at: eventAt,
        end_time: endTimeAt,
        event_timezone: timezone,
        place_name: venueName || null,
        venue_address: address || null,
        latitude: candidate.location_lat,
        longitude: candidate.location_lng,
        category,
        price: price || null,
        link_url: (candidate.source_url as string | null) || null,
        source: 'newsletter',
        source_method: 'newsletter',
        source_publisher: sourceName || 'newsletter',
        status: 'published',
        visibility: 'public',
        region_id: config.defaultRegionId || null,
        start_time_required: !!startTime,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('[COMMONS-ADMIN] Event create from candidate error:', insertErr.message);
      throw createError('Failed to create event from candidate', 500, 'SERVER_ERROR');
    }

    const eventId = event.id as string;

    // Update candidate status
    await supabaseAdmin
      .from('event_candidates')
      .update({
        status: 'approved',
        matched_event_id: eventId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);

    // Fire-and-forget: geocode if needed
    void geocodeEventIfNeeded(
      eventId,
      address,
      candidate.location_lat as number | null,
      candidate.location_lng as number | null,
      null,
    );

    // Fire-and-forget: download and re-encode candidate image
    const candidateImageUrl = candidate.candidate_image_url as string | null;
    if (candidateImageUrl) {
      void downloadAndAttachImage(eventId, candidateImageUrl).catch((err) => {
        console.error('[COMMONS-ADMIN] Candidate image download failed:', err instanceof Error ? err.message : err);
      });
    }

    // Fire-and-forget: dispatch webhooks
    void (async () => {
      const { data: row } = await supabaseAdmin
        .from('events')
        .select(PORTAL_SELECT)
        .eq('id', eventId)
        .maybeSingle();
      if (row) {
        void dispatchWebhooks('event.created', eventId, toNeighborhoodEvent(row as unknown as PortalEventRow));
      }
    })().catch(() => {});

    const adminId = getAdminUserId();
    auditPortalAction('newsletter_candidate_approved', adminId, eventId, { candidate_id: req.params.id });
    console.log(`[COMMONS-ADMIN] Approved candidate ${req.params.id} → event ${eventId}`);

    res.status(201).json({ event_id: eventId, candidate_id: req.params.id });
  } catch (err) {
    next(err);
  }
});

router.post('/event-candidates/:id/reject', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const input = req.body && Object.keys(req.body).length > 0
      ? validateRequest(rejectCandidateSchema, req.body)
      : {};

    const { data: candidate, error: fetchErr } = await supabaseAdmin
      .from('event_candidates')
      .select('id, status')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !candidate) {
      throw createError('Event candidate not found', 404, 'NOT_FOUND');
    }

    if (candidate.status !== 'pending') {
      throw createError(`Candidate is already ${candidate.status}`, 409, 'CONFLICT');
    }

    await supabaseAdmin
      .from('event_candidates')
      .update({
        status: 'rejected',
        review_notes: input.review_notes || null,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);

    const adminId = getAdminUserId();
    auditPortalAction('newsletter_candidate_rejected', adminId, req.params.id);
    console.log(`[COMMONS-ADMIN] Rejected candidate ${req.params.id}`);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/event-candidates/:id/duplicate', writeLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const input = req.body && Object.keys(req.body).length > 0
      ? validateRequest(duplicateCandidateSchema, req.body)
      : {};

    const { data: candidate, error: fetchErr } = await supabaseAdmin
      .from('event_candidates')
      .select('id, status, matched_event_id')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !candidate) {
      throw createError('Event candidate not found', 404, 'NOT_FOUND');
    }

    if (candidate.status !== 'pending') {
      throw createError(`Candidate is already ${candidate.status}`, 409, 'CONFLICT');
    }

    await supabaseAdmin
      .from('event_candidates')
      .update({
        status: 'duplicate',
        matched_event_id: input.matched_event_id || (candidate.matched_event_id as string | null),
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);

    const adminId = getAdminUserId();
    auditPortalAction('newsletter_candidate_duplicate', adminId, req.params.id);
    console.log(`[COMMONS-ADMIN] Marked candidate ${req.params.id} as duplicate`);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
