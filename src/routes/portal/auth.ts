/**
 * Portal Auth Routes
 *
 * Pre-auth routes: email check and self-registration.
 */

import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase.js";
import { createError } from "../../middleware/error-handler.js";
import { validateRequest } from "../../lib/helpers.js";
import { config } from "../../config.js";
import { verifyTurnstile } from "../../lib/captcha.js";
import { enumerationLimiter } from "../../middleware/rate-limit.js";
import { blockDatacenterIps } from "../../middleware/ip-filter.js";

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


export default router;
