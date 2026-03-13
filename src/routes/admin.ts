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
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { requireCommonsAdmin } from '../middleware/auth.js';
import { writeLimiter, enumerationLimiter } from '../middleware/rate-limit.js';
import { validateRequest, validateUuidParam } from '../lib/helpers.js';
import { uploadToR2 } from '../lib/cloudflare.js';
import { config } from '../config.js';
import { dispatchWebhooks } from '../lib/webhook-delivery.js';
import { auditPortalAction, hashId } from '../lib/audit.js';
import { generateAndStoreKey } from '../lib/api-keys.js';
import { toNeighborhoodEvent, type PortalEventRow } from '../lib/event-transform.js';
import { sanitizeUrl, checkApprovedDomain } from '../lib/url-sanitizer.js';
import {
  toPortalEvent,
  portalInputToInsert,
  PORTAL_SELECT,
  toTimestamptz,
  fromTimestamptz,
  getAdminUserId,
  createEventSeries,
  deleteSeriesEvents,
  dispatchSeriesWebhooks,
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
  ticket_url: z.string().url().max(2000).optional().or(z.literal('')),
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
  ticket_url: z.string().url().max(2000).optional().or(z.literal('')).nullable(),
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
router.get('/stats', enumerationLimiter, async (_req, res, next) => {
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
      .eq('source', 'portal');

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const { count: eventsThisWeek } = await supabaseAdmin
      .from('events')
      .select('id', { count: 'exact', head: true })
      .eq('source', 'portal')
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
router.get('/accounts', enumerationLimiter, async (_req, res, next) => {
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
        .eq('source', 'portal')
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
router.get('/accounts/:id', enumerationLimiter, async (req, res, next) => {
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
      .eq('source', 'portal')
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
        .eq('source', 'portal');
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
router.get('/accounts/:id/activity', enumerationLimiter, async (req, res, next) => {
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
router.get('/events', enumerationLimiter, async (_req, res, next) => {
  try {
    const { data: events, error } = await supabaseAdmin
      .from('events')
      .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name, email)`)
      .eq('source', 'portal')
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
      .eq('source', 'portal')
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
      .eq('source', 'portal')
      .select(PORTAL_SELECT)
      .single();

    if (error) {
      console.error('[COMMONS-ADMIN] Event update error:', error.message);
      throw createError('Failed to update event', 500, 'SERVER_ERROR');
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
      .eq('source', 'portal');

    if (error) {
      console.error('[COMMONS-ADMIN] Event delete error:', error.message);
      throw createError('Failed to delete event', 500, 'SERVER_ERROR');
    }

    void dispatchWebhooks('event.deleted', req.params.id, {
      id: req.params.id, name: '', start: '', end: null, description: null,
      category: [], place_id: null,
      location: { name: '', address: null, lat: null, lng: null },
      url: null, images: [], organizer: { name: '', phone: null },
      cost: null, series_id: null, series_instance_number: null, start_time_required: true, recurrence: null,
      source: { publisher: 'fiber', collected_at: new Date().toISOString(), method: 'portal', license: 'CC BY 4.0' },
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
      .eq('source', 'portal')
      .maybeSingle();

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const imageUrl = await processAndUploadImage(req.params.id, image);

    const { error: updateError } = await supabaseAdmin
      .from('events')
      .update({ event_image_url: imageUrl })
      .eq('id', req.params.id)
      .eq('source', 'portal');

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
router.get('/api-keys', enumerationLimiter, async (_req, res, next) => {
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

export default router;
