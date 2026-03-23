/**
 * Portal Account Routes
 *
 * Role detection, account claiming, profile management.
 */

import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase.js";
import { createError } from "../../middleware/error-handler.js";
import { validateRequest } from "../../lib/helpers.js";
import { writeLimiter, portalLimiter } from "../../middleware/rate-limit.js";
import { PORTAL_ACCOUNT_SELECT } from "../../lib/event-operations.js";
import { isPortalAdmin, getActAsAccountId, getUserClient, getPortalAccountId } from "../../lib/portal-helpers.js";

const router: ReturnType<typeof Router> = Router();

// =============================================================================

router.get('/whoami', portalLimiter, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const email = req.user?.email;
    if (!userId || !email) throw createError('Unauthorized', 401, 'UNAUTHORIZED');

    if (isPortalAdmin(req)) {
      // Admin impersonation: return target account as business role
      const actAs = getActAsAccountId(req);
      if (actAs) {
        const { data: targetAccount } = await supabaseAdmin
          .from('portal_accounts')
          .select(PORTAL_ACCOUNT_SELECT)
          .eq('id', actAs)
          .in('status', ['active', 'pending'])
          .maybeSingle();

        if (!targetAccount) throw createError('Target account not found', 404, 'NOT_FOUND');
        res.json({ role: 'business', account: targetAccount, impersonating: true });
        return;
      }

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
    // Account claiming is identity-binding — never allowed during impersonation
    if (req.headers['x-act-as-account']) {
      throw createError('Cannot claim accounts during impersonation', 400, 'VALIDATION_ERROR');
    }

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

    // Admin impersonation: look up by account ID
    const actAs = getActAsAccountId(req);
    let account;
    let error;
    if (actAs) {
      const result = await supabaseAdmin
        .from('portal_accounts')
        .select(PORTAL_ACCOUNT_SELECT)
        .eq('id', actAs)
        .maybeSingle();
      account = result.data;
      error = result.error;
    } else {
      const result = await getUserClient(req)
        .from('portal_accounts')
        .select(PORTAL_ACCOUNT_SELECT)
        .eq('auth_user_id', userId)
        .maybeSingle();
      account = result.data;
      error = result.error;
    }

    if (error) {
      console.error('[PORTAL] Account fetch error:', error.message);
      throw createError('Failed to fetch account', 500, 'SERVER_ERROR');
    }

    if (!account) {
      throw createError('No portal account found', 404, 'NOT_FOUND');
    }

    // Sync email: if the auth user verified a new email, update portal_accounts to match.
    // Skip during admin impersonation — req.user.email is the admin's email, not the business owner's.
    if (!actAs) {
      const authEmail = req.user?.email;
      if (authEmail && authEmail !== account.email) {
        await supabaseAdmin
          .from('portal_accounts')
          .update({ email: authEmail })
          .eq('id', account.id);
        account.email = authEmail;
      }
    }

    res.json({ account });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// PROFILE (business self-service)
// =============================================================================

const dayHoursSchema = z.object({
  open: z.boolean(),
  ranges: z.array(z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  })).max(5),
});

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
  operating_hours: z.array(dayHoursSchema).length(7).optional().nullable(),
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
    if (data.operating_hours !== undefined) update.operating_hours = data.operating_hours;

    if (Object.keys(update).length === 0) {
      throw createError('No fields to update — include at least one field to change (e.g., title, description, category)', 400, 'VALIDATION_ERROR');
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


export default router;
