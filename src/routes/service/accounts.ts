/**
 * Service API — Accounts (v2 operational shell)
 *
 * v2: portal_accounts holds tenant operational state — email, claim, status,
 * timestamps. Business-profile data lives on organizations (migration 082).
 *
 * Modifying an account requires the calling key to be linked to *some*
 * organization owned by the target account (or be admin). The /accounts/link
 * endpoint is the entry point for consumer apps to establish a tenant
 * claim; key-to-organization linkage is established separately via
 * /service/organizations/link or auto-link when creating an organization.
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest, validateUuidParam, sanitizeSearchInput } from '../../lib/helpers.js';
import { serviceLimiter } from '../../middleware/rate-limit.js';
import { PORTAL_SELECT, MANAGED_SOURCES, toPortalEvent } from '../../lib/event-operations.js';
import { assertLinkedAccount } from './helpers.js';

const router: ReturnType<typeof Router> = Router();

// v2: account CRUD shrinks to operational state. Profile data is set via
// the /service/organizations endpoints once an organization exists.
const createAccountSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
  claimed_by: z.string().max(50).optional(),
});

const updateAccountSchema = z.object({
  status: z.enum(['active', 'suspended', 'pending', 'rejected']).optional(),
  claimed_by: z.string().max(50).optional(),
});

// =============================================================================
// ACCOUNT LINKING — Consumer apps establish their tenant portal_account
// =============================================================================
//
// v2: /accounts/link only manages the operational tenant row. Authority
// scope (which orgs a key may write to) lives in api_key_organization_links
// and is established via /service/organizations/link or by auto-link when
// the key creates an organization.

const linkAccountSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
  claimed_by: z.string().max(50).optional(),
});

/**
 * POST /service/accounts/link
 * Find-or-create a portal_account by email and mark it claimed.
 *
 * v2 change: no longer inserts into api_key_account_links (that table was
 * dropped in migration 082). Use POST /service/organizations/link to
 * establish writeable scope for this key.
 */
router.post('/accounts/link', serviceLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(linkAccountSchema, req.body);
    const apiKeyId = req.apiKeyInfo!.id;
    let created = false;

    // 1. Look up existing account by email
    let { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, email, status, claimed_at, claimed_by, auth_user_id, created_at, updated_at')
      .ilike('email', data.email)
      .maybeSingle();

    // Defense-in-depth: refuse to link if the account has a Supabase Auth
    // owner (auth_user_id), or if it has been claimed by a different consumer
    // app. Admin keys bypass — they're operating on behalf of the platform.
    if (account && !req.apiKeyInfo?.isAdmin) {
      if (account.auth_user_id) {
        throw createError(
          'This account is owned by an authenticated user and cannot be linked by service keys.',
          409,
          'CONFLICT',
        );
      }
      if (account.claimed_at && account.claimed_by && data.claimed_by
        && account.claimed_by !== data.claimed_by) {
        throw createError(
          `This account is already claimed by "${account.claimed_by}". Linking under a different identity is not permitted.`,
          409,
          'CONFLICT',
        );
      }
    }

    // 2. Create if not found
    if (!account) {
      const { data: newAccount, error: createError_ } = await supabaseAdmin
        .from('portal_accounts')
        .insert({
          email: data.email,
          status: 'active',
        })
        .select('id, email, status, claimed_at, claimed_by, auth_user_id, created_at, updated_at')
        .single();

      if (createError_) {
        if (createError_.code === '23505') {
          // Race condition: account was created between our check and insert
          const { data: raceAccount } = await supabaseAdmin
            .from('portal_accounts')
            .select('id, email, status, claimed_at, claimed_by, auth_user_id, created_at, updated_at')
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

    // 3. Mark as claimed if not already
    if (!account.claimed_at) {
      const claimedBy = data.claimed_by || 'api';
      await supabaseAdmin
        .from('portal_accounts')
        .update({ claimed_at: new Date().toISOString(), claimed_by: claimedBy })
        .eq('id', account.id);
      account = { ...account, claimed_at: new Date().toISOString(), claimed_by: claimedBy };
    }

    console.log(`[SERVICE] Account claim resolved: ${account.email} by key ${apiKeyId.slice(0, 8)}... (created=${created})`);
    res.status(created ? 201 : 200).json({ account, created });
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
      .select('id, email, auth_user_id, status, claimed_at, claimed_by, last_login_at, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false });

    // Exact email lookup (case-insensitive)
    if (email) {
      query = query.ilike('email', email.toLowerCase().trim());
    }

    if (search) {
      const sanitized = sanitizeSearchInput(search);
      if (sanitized) {
        query = query.ilike('email', `%${sanitized}%`);
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
      .select('id, email, auth_user_id, status, claimed_at, claimed_by, last_login_at, created_at, updated_at')
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

/** POST /service/accounts — Create operational account row */
router.post('/accounts', serviceLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(createAccountSchema, req.body);

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .insert({
        email: data.email,
        status: 'active',
        ...(data.claimed_by
          ? { claimed_at: new Date().toISOString(), claimed_by: data.claimed_by }
          : {}),
      })
      .select('id, email, auth_user_id, status, claimed_at, claimed_by, last_login_at, created_at, updated_at')
      .single();

    if (error) {
      if (error.code === '23505') throw createError('Account with this email already exists', 409, 'CONFLICT');
      console.error('[SERVICE] Create account error:', error.message);
      throw createError('Failed to create account', 500, 'SERVER_ERROR');
    }

    console.log(`[SERVICE] Account created: ${account.email}`);
    res.status(201).json({ account });
  } catch (err) {
    next(err);
  }
});

/** PATCH /service/accounts/:id — Update operational fields (scoped) */
router.patch('/accounts/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    await assertLinkedAccount(req, req.params.id);
    const data = validateRequest(updateAccountSchema, req.body);

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) update[key] = value;
    }

    if (Object.keys(update).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .update(update)
      .eq('id', req.params.id)
      .select('id, email, auth_user_id, status, claimed_at, claimed_by, last_login_at, created_at, updated_at')
      .single();

    if (error) throw createError('Failed to update account', 500, 'SERVER_ERROR');
    res.json({ account });
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
