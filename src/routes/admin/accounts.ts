/**
 * Admin Account Routes
 *
 * Platform stats, account CRUD, approve/reject/suspend/reactivate.
 */

import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase.js";
import { createError } from "../../middleware/error-handler.js";
import { validateRequest, validateUuidParam } from "../../lib/helpers.js";
import { auditPortalAction, hashId } from "../../lib/audit.js";
import { writeLimiter, portalLimiter } from "../../middleware/rate-limit.js";
import { PORTAL_SELECT, MANAGED_SOURCES, toPortalEvent } from "../../lib/event-operations.js";
import { dispatchSeriesWebhooks } from "../../lib/event-series.js";

const router: ReturnType<typeof Router> = Router();

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

    // Count unique events: series count as 1 (instance_number=1), one-offs have null instance_number.
    // This gives the real "how many distinct things are programmed" count.
    const { count: totalOneOffs } = await supabaseAdmin
      .from('events')
      .select('id', { count: 'exact', head: true })
      .in('source', [...MANAGED_SOURCES])
      .is('series_id', null);

    const { count: totalSeries } = await supabaseAdmin
      .from('events')
      .select('id', { count: 'exact', head: true })
      .in('source', [...MANAGED_SOURCES])
      .not('series_id', 'is', null)
      .eq('series_instance_number', 1);

    const totalEvents = (totalOneOffs || 0) + (totalSeries || 0);

    // Upcoming 7 days: unique events with an instance in the next week
    const now = new Date().toISOString();
    const oneWeekOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { count: upcomingOneOffs } = await supabaseAdmin
      .from('events')
      .select('id', { count: 'exact', head: true })
      .in('source', [...MANAGED_SOURCES])
      .is('series_id', null)
      .gte('event_at', now)
      .lte('event_at', oneWeekOut)
      .eq('status', 'published');

    // Count distinct series with any upcoming instance in the next 7 days
    const { data: upcomingSeriesIds } = await supabaseAdmin
      .from('events')
      .select('series_id')
      .in('source', [...MANAGED_SOURCES])
      .not('series_id', 'is', null)
      .gte('event_at', now)
      .lte('event_at', oneWeekOut)
      .eq('status', 'published');

    const uniqueUpcomingSeriesCount = upcomingSeriesIds
      ? new Set(upcomingSeriesIds.map((r: { series_id: string }) => r.series_id)).size
      : 0;

    const upcomingEvents = (upcomingOneOffs || 0) + uniqueUpcomingSeriesCount;

    // Provenance breakdown by source_method
    const { data: provenanceRows } = await supabaseAdmin
      .from('events')
      .select('source_method, series_id, series_instance_number')
      .in('source', [...MANAGED_SOURCES]);

    const provenance: Record<string, number> = {};
    if (provenanceRows) {
      for (const row of provenanceRows) {
        // Count unique events: skip series instances beyond #1
        if (row.series_id && row.series_instance_number !== 1) continue;
        const method = row.source_method || 'portal';
        provenance[method] = (provenance[method] || 0) + 1;
      }
    }

    // Category distribution: count unique events grouped by category
    const { data: categoryRows } = await supabaseAdmin
      .from('events')
      .select('category, series_id, series_instance_number')
      .in('source', [...MANAGED_SOURCES]);

    const category_distribution: Record<string, number> = {};
    if (categoryRows) {
      for (const row of categoryRows) {
        if (row.series_id && row.series_instance_number !== 1) continue;
        const cat = row.category || 'uncategorized';
        category_distribution[cat] = (category_distribution[cat] || 0) + 1;
      }
    }

    res.json({
      stats: {
        total_accounts: totalAccounts,
        claimed_accounts: claimedAccounts,
        managed_accounts: totalAccounts - claimedAccounts,
        pending_accounts: pendingAccounts,
        total_events: totalEvents,
        upcoming_7d: upcomingEvents,
        provenance,
        category_distribution,
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

    // Count unique events per account (series = 1, one-offs = 1)
    const accountIds = (accounts || []).map((a: { id: string }) => a.id);
    let eventCounts: Record<string, number> = {};
    if (accountIds.length > 0) {
      const { data: counts } = await supabaseAdmin
        .from('events')
        .select('creator_account_id, series_id, series_instance_number')
        .in('source', [...MANAGED_SOURCES])
        .in('creator_account_id', accountIds);

      if (counts) {
        eventCounts = counts.reduce((acc: Record<string, number>, row: { creator_account_id: string; series_id: string | null; series_instance_number: number | null }) => {
          // Skip series instances beyond #1
          if (row.series_id && row.series_instance_number !== 1) return acc;
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
      .order('event_at', { ascending: true });

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

export default router;
