/**
 * Self-service registration for service-tier API keys — Neighborhood Commons.
 *
 * Anyone can register, build, and exercise their full integration. The key
 * lands with `activated_at = NULL` and authenticates for reads with the
 * service-tier rate limit, but `requireServiceApiKey` rejects writes with
 * `KEY_PENDING` until a one-time human review activates it.
 *
 * The reviewer reads `application_metadata` (captured here at registration)
 * when deciding to activate. Activation lives at
 * `POST /v1/service/api-keys/:id/activate`.
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { validateRequest } from '../../lib/helpers.js';
import { createError } from '../../middleware/error-handler.js';
import { enumerationLimiter, verifyOtpLimiter } from '../../middleware/rate-limit.js';
import { generateAndStoreKey } from '../../lib/api-keys.js';
import { storeOtp, verifyOtp, sendOtpEmail } from '../../lib/developer-otp.js';

const router: ReturnType<typeof Router> = Router();

// Service-tier reads default to a higher limit than browse-tier.
const SERVICE_TIER_RATE_LIMIT_PER_HOUR = 2000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sendOtpSchema = z.object({
  email: z.string().email().max(320),
});

const verifyOtpSchema = z.object({
  email: z.string().email().max(320),
  token: z.string().min(6).max(8),
  /** App or product name. Surfaced on the reputation graph after activation. */
  app_name: z.string().min(1).max(200).trim(),
  /** Public URL of the app — homepage or App Store / Play Store listing. */
  app_url: z.string().url().max(500),
  /**
   * One-paragraph description of what's being built. The reviewer reads this
   * verbatim, so be concrete: who's the user, what's the integration shape.
   */
  what_youre_building: z.string().min(20).max(2000).trim(),
  /**
   * How the app verifies the organizations it onboards. Determines what
   * verification_authority gets granted at activation.
   * Free-form to encourage thinking; expect "in-person", "video call",
   * "domain email loop", "manual review by editor", etc.
   */
  verification_process: z.string().min(20).max(2000).trim(),
  /** Used to size rate limits at activation. */
  expected_first_week_writes: z.string().max(200).trim().optional(),
});

// ---------------------------------------------------------------------------
// POST /service/register/send-otp
// ---------------------------------------------------------------------------

router.post('/send-otp', enumerationLimiter, async (req, res, next) => {
  try {
    const { email } = validateRequest(sendOtpSchema, req.body);

    const code = await storeOtp(email);
    await sendOtpEmail(email, code);

    console.log(`[SERVICE-REG] OTP sent to ${email.substring(0, 3)}***`);
    res.json({
      success: true,
      message: 'A verification code was sent to your email. Continue to /service/register/verify-otp.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /service/register/verify-otp
//
// Issues a service-tier api_key with `activated_at = NULL`. The raw key is
// returned once. The key authenticates for reads at the service-tier rate
// limit and for the verifications/path lookup, but writes return KEY_PENDING
// until a human review activates it.
// ---------------------------------------------------------------------------

router.post('/verify-otp', enumerationLimiter, verifyOtpLimiter, async (req, res, next) => {
  try {
    const params = validateRequest(verifyOtpSchema, req.body);

    // Reject if an active service-tier key already exists for this email.
    // Multiple pending applications from the same email are allowed (operator
    // can deduplicate at activation time), but we don't want to silently
    // re-issue against an already-activated email.
    const { data: existing } = await supabaseAdmin
      .from('api_keys')
      .select('id, activated_at')
      .eq('contact_email', params.email.toLowerCase())
      .eq('contributor_tier', 'service')
      .eq('status', 'active')
      .not('activated_at', 'is', null)
      .maybeSingle();

    if (existing) {
      throw createError(
        'A service-tier API key already exists for this email. To rotate, contact hi@neighborhood-commons.org.',
        409,
        'ALREADY_EXISTS',
      );
    }

    const valid = await verifyOtp(params.email, params.token);
    if (!valid) {
      throw createError('Invalid or expired verification code', 401, 'INVALID_OTP');
    }

    let key;
    try {
      key = await generateAndStoreKey(
        params.app_name,
        params.email.toLowerCase(),
        'service',
        SERVICE_TIER_RATE_LIMIT_PER_HOUR,
        params.app_url,
        {
          pending: true,
          applicationMetadata: {
            app_name: params.app_name,
            app_url: params.app_url,
            what_youre_building: params.what_youre_building,
            verification_process: params.verification_process,
            expected_first_week_writes: params.expected_first_week_writes ?? null,
            registered_at: new Date().toISOString(),
          },
        },
      );
    } catch (err: unknown) {
      console.error('[SERVICE-REG] Key insert failed:', JSON.stringify(err, null, 2));
      throw createError('Failed to create API key', 500, 'SERVER_ERROR');
    }

    console.log(
      `[SERVICE-REG] Pending service key issued: ${key.id} (${params.email.substring(0, 3)}***, app=${params.app_name})`,
    );

    res.status(201).json({
      api_key: {
        id: key.id,
        raw_key: key.raw_key,
        name: key.name,
        rate_limit_per_hour: SERVICE_TIER_RATE_LIMIT_PER_HOUR,
        status: 'pending_activation',
        created_at: key.created_at,
      },
      message:
        "Save your raw_key — it won't be shown again. Reads work immediately. Build your full integration; when you're ready for live writes, email hi@neighborhood-commons.org with your app URL and we'll activate within a business day.",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
