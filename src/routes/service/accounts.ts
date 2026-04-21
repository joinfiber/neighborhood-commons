/**
 * Service API — Accounts
 *
 * Portal account CRUD for service-tier callers. Modifying an account
 * requires the calling key to be linked to it (or be admin). Coordinate
 * changes propagate to all events owned by the account, including
 * region re-resolution and event.updated webhook dispatch.
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest, validateUuidParam, sanitizeSearchInput } from '../../lib/helpers.js';
import { serviceLimiter } from '../../middleware/rate-limit.js';
import { dispatchEventWebhookById } from '../../lib/webhook-delivery.js';
import { PORTAL_SELECT, MANAGED_SOURCES, toPortalEvent } from '../../lib/event-operations.js';
import { assertLinkedAccount } from './helpers.js';

const router: ReturnType<typeof Router> = Router();

const createAccountSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
  business_name: z.string().min(1).max(200),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(500).optional().or(z.literal('')),
  default_venue_name: z.string().max(200).optional(),
  default_place_id: z.string().max(500).optional(),
  default_address: z.string().max(500).optional(),
  default_latitude: z.number().min(-90).max(90).optional(),
  default_longitude: z.number().min(-180).max(180).optional(),
  operating_hours: z.array(z.object({
    open: z.boolean(),
    ranges: z.array(z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    })),
  })).length(7).optional(),
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
  operating_hours: z.array(z.object({
    open: z.boolean(),
    ranges: z.array(z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    })),
  })).length(7).optional(),
  status: z.enum(['active', 'suspended', 'pending', 'rejected']).optional(),
  logo_url: z.string().url().max(2000).optional().or(z.literal('')).or(z.null()),
  cover_image_url: z.string().url().max(2000).optional().or(z.literal('')).or(z.null()),
  description: z.string().max(2000).optional().or(z.literal('')).or(z.null()),
});

// =============================================================================
// ACCOUNT LINKING — Consumer apps link their users to portal accounts
// =============================================================================

const linkAccountSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
  business_name: z.string().min(1).max(200),
  claimed_by: z.string().max(50).optional(),
});

/**
 * POST /service/accounts/link
 * Find-or-create a portal account by email and link it to the calling service key.
 * This is how consumer apps (Merrie, etc.) establish a relationship with a venue operator.
 */
router.post('/accounts/link', serviceLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(linkAccountSchema, req.body);
    const apiKeyId = req.apiKeyInfo!.id;
    let created = false;
    let linked = false;

    // 1. Look up existing account by email
    let { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, email, business_name, status, claimed_at, claimed_by, slug, created_at, updated_at')
      .ilike('email', data.email)
      .maybeSingle();

    // 2. Create if not found
    if (!account) {
      const { data: newAccount, error: createError_ } = await supabaseAdmin
        .from('portal_accounts')
        .insert({
          email: data.email,
          business_name: data.business_name,
          status: 'active',
        })
        .select('id, email, business_name, status, claimed_at, claimed_by, slug, created_at, updated_at')
        .single();

      if (createError_) {
        if (createError_.code === '23505') {
          // Race condition: account was created between our check and insert
          const { data: raceAccount } = await supabaseAdmin
            .from('portal_accounts')
            .select('id, email, business_name, status, claimed_at, claimed_by, slug, created_at, updated_at')
            .ilike('email', data.email)
            .single();
          account = raceAccount;
        } else {
          console.error('[SERVICE] Account link create error:', createError_.message);
          throw createError('Failed to create account', 500, 'SERVER_ERROR');
        }
      } else {
        account = newAccount;
        created = true;
      }
    }

    if (!account) throw createError('Failed to resolve account', 500, 'SERVER_ERROR');

    // 3. Link the service key to this account (upsert)
    const { error: linkError } = await supabaseAdmin
      .from('api_key_account_links')
      .upsert(
        { api_key_id: apiKeyId, portal_account_id: account.id },
        { onConflict: 'api_key_id,portal_account_id' },
      );

    if (linkError) {
      console.error('[SERVICE] Account link error:', linkError.message);
    } else {
      linked = true;
    }

    // 4. Mark as claimed if not already
    if (!account.claimed_at) {
      const claimedBy = data.claimed_by || 'api';
      await supabaseAdmin
        .from('portal_accounts')
        .update({ claimed_at: new Date().toISOString(), claimed_by: claimedBy })
        .eq('id', account.id);
      account = { ...account, claimed_at: new Date().toISOString(), claimed_by: claimedBy };
    }

    console.log(`[SERVICE] Account linked: ${account.email} → key ${apiKeyId.slice(0, 8)}... (created=${created})`);
    res.status(created ? 201 : 200).json({ account, created, linked });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// ACCOUNT CRUD
// =============================================================================

/** GET /service/accounts — List accounts with event counts, optional search + pagination */
const listAccountsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  email: z.string().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(500),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

router.get('/accounts', serviceLimiter, async (req, res, next) => {
  try {
    const { search, email, limit, offset } = validateRequest(listAccountsQuerySchema, req.query);

    let query = supabaseAdmin
      .from('portal_accounts')
      .select('id, email, business_name, auth_user_id, status, claimed_at, claimed_by, default_venue_name, default_place_id, default_address, default_latitude, default_longitude, website, phone, operating_hours, logo_url, cover_image_url, description, last_login_at, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false });

    // Exact email lookup (case-insensitive)
    if (email) {
      query = query.ilike('email', email.toLowerCase().trim());
    }

    if (search) {
      const sanitized = sanitizeSearchInput(search);
      if (sanitized) {
        query = query.or(`business_name.ilike.%${sanitized}%,default_address.ilike.%${sanitized}%`);
      }
    }

    query = query.range(offset, offset + limit - 1);

    const { data: accounts, error, count } = await query;

    if (error) throw createError('Failed to fetch accounts', 500, 'SERVER_ERROR');

    // Count unique events per account
    const accountIds = (accounts || []).map((a: { id: string }) => a.id);
    let eventCounts: Record<string, number> = {};
    if (accountIds.length > 0) {
      const { data: counts } = await supabaseAdmin
        .from('events')
        .select('creator_account_id, series_id, series_instance_number')
        .in('source', [...MANAGED_SOURCES])
        .in('creator_account_id', accountIds)
        .limit(10000);

      if (counts) {
        eventCounts = counts.reduce((acc: Record<string, number>, row: { creator_account_id: string; series_id: string | null; series_instance_number: number | null }) => {
          // Count one-offs (no series_id) and one representative per series.
          // Instance 0 = ongoing series, instance 1 = first of a bounded series,
          // null = older events (treat as representative). Skip instances 2+.
          if (row.series_id && row.series_instance_number != null && row.series_instance_number > 1) return acc;
          acc[row.creator_account_id] = (acc[row.creator_account_id] || 0) + 1;
          return acc;
        }, {});
      }
    }

    const result = (accounts || []).map((a: { id: string }) => ({
      ...a,
      event_count: eventCounts[a.id] || 0,
    }));

    res.json({ accounts: result, total: count ?? result.length });
  } catch (err) {
    next(err);
  }
});

/** GET /service/accounts/:id — Single account with events */
router.get('/accounts/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, email, business_name, auth_user_id, status, default_venue_name, default_place_id, default_address, default_latitude, default_longitude, website, phone, operating_hours, last_login_at, claimed_at, created_at, updated_at')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error || !account) throw createError('Account not found', 404, 'NOT_FOUND');

    // Fetch unique events only (one-offs + first instance of each series)
    // and limit to a reasonable page size. Past events are rarely needed in this view.
    const { data: events } = await supabaseAdmin
      .from('events')
      .select(PORTAL_SELECT)
      .eq('creator_account_id', account.id)
      .in('source', [...MANAGED_SOURCES])
      .or('series_id.is.null,series_instance_number.eq.0,series_instance_number.eq.1')
      .order('event_at', { ascending: false })
      .limit(200);

    res.json({ account, events: (events || []).map(toPortalEvent) });
  } catch (err) {
    next(err);
  }
});

/** POST /service/accounts — Create account */
router.post('/accounts', serviceLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(createAccountSchema, req.body);

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
        operating_hours: data.operating_hours ?? null,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') throw createError('Account with this email already exists', 409, 'CONFLICT');
      console.error('[SERVICE] Create account error:', error.message);
      throw createError('Failed to create account', 500, 'SERVER_ERROR');
    }

    console.log(`[SERVICE] Account created: ${account.business_name}`);
    res.status(201).json({ account });
  } catch (err) {
    next(err);
  }
});

/** PATCH /service/accounts/:id — Update account (scoped to linked accounts) */
router.patch('/accounts/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    await assertLinkedAccount(req, req.params.id);
    const data = validateRequest(updateAccountSchema, req.body);

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) update[key] = value ?? null;
    }

    if (Object.keys(update).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .update(update)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw createError('Failed to update account', 500, 'SERVER_ERROR');

    // Propagate coordinate changes to all events owned by this account
    const coordsChanged = update.default_latitude !== undefined || update.default_longitude !== undefined;
    let eventsUpdated = 0;
    if (coordsChanged) {
      const newLat = account.default_latitude as number | null;
      const newLng = account.default_longitude as number | null;
      console.log(`[SERVICE] Coord change detected for ${account.business_name}: lat=${newLat}, lng=${newLng}`);

      const eventUpdate: Record<string, unknown> = {
        latitude: newLat,
        longitude: newLng,
      };

      // Only set approximate_location if we have valid coordinates
      if (newLat != null && newLng != null) {
        eventUpdate.approximate_location = `POINT(${newLng} ${newLat})`;
      }

      // Re-resolve region from new coordinates
      if (newLat != null && newLng != null) {
        const { data: regionData, error: regionError } = await supabaseAdmin.rpc('find_user_region', {
          p_longitude: newLng,
          p_latitude: newLat,
        });
        if (regionError) {
          console.error(`[SERVICE] Region resolution failed:`, regionError.message);
        } else if (regionData && regionData.length > 0) {
          eventUpdate.region_id = regionData[0].region_id;
          console.log(`[SERVICE] Account region re-resolved: ${regionData[0].region_name}`);
        }
      }

      // Fetch affected event IDs (all events owned by this account)
      const { data: affectedEvents, error: fetchError } = await supabaseAdmin
        .from('events')
        .select('id')
        .eq('creator_account_id', req.params.id);

      if (fetchError) {
        console.error(`[SERVICE] Failed to fetch events for propagation:`, fetchError.message);
      }

      const affectedIds = (affectedEvents || []).map((e) => e.id);
      console.log(`[SERVICE] Found ${affectedIds.length} events to update for account ${req.params.id}`);

      if (affectedIds.length > 0) {
        console.log(`[SERVICE] Updating events with:`, JSON.stringify(eventUpdate));
        const { data: updated, error: updateError } = await supabaseAdmin
          .from('events')
          .update(eventUpdate)
          .in('id', affectedIds)
          .select('id');

        if (updateError) {
          console.error(`[SERVICE] Event coordinate propagation FAILED:`, updateError.message, updateError.details, updateError.hint);
        } else {
          eventsUpdated = updated?.length || 0;
          console.log(`[SERVICE] Propagated coordinates to ${eventsUpdated} events for account ${account.business_name}`);
        }

        // Fire event.updated webhooks (fire-and-forget)
        if (eventsUpdated > 0) {
          for (const eventId of affectedIds) {
            dispatchEventWebhookById('event.updated', eventId);
          }
        }
      }
    }

    res.json({ account, ...(coordsChanged ? { events_updated: eventsUpdated } : {}) });
  } catch (err) {
    next(err);
  }
});

/** DELETE /service/accounts/:id — Delete account and all its events (scoped) */
router.delete('/accounts/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    await assertLinkedAccount(req, req.params.id);

    // Delete all events owned by this account first
    await supabaseAdmin
      .from('events')
      .delete()
      .eq('creator_account_id', req.params.id);

    // Delete the account
    const { error } = await supabaseAdmin
      .from('portal_accounts')
      .delete()
      .eq('id', req.params.id);

    if (error) throw createError('Failed to delete account', 500, 'SERVER_ERROR');

    console.log(`[SERVICE] Account deleted: ${req.params.id}`);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

export default router;
