/**
 * Developer Registration Routes — Neighborhood Commons
 *
 * Self-service API key registration for developers.
 * Email + OTP verification → free API key (1000 req/hr).
 * No admin approval required.
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';
import { validateRequest } from '../lib/helpers.js';
import { createError } from '../middleware/error-handler.js';
import { enumerationLimiter, writeLimiter } from '../middleware/rate-limit.js';
import { requireApiKey } from '../middleware/api-key.js';
import { generateAndStoreKey } from '../lib/api-keys.js';

const router: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sendOtpSchema = z.object({
  email: z.string().email().max(320),
});

const verifyOtpSchema = z.object({
  email: z.string().email().max(320),
  token: z.string().min(6).max(8),
  name: z.string().min(1).max(200).trim(),
});

const rotateKeySchema = z.object({
  email: z.string().email().max(320),
  token: z.string().min(6).max(8),
});

// ---------------------------------------------------------------------------
// POST /developers/register/send-otp
// Send a verification code to register for an API key.
// ---------------------------------------------------------------------------

router.post('/register/send-otp', enumerationLimiter, async (req, res, next) => {
  try {
    const { email } = validateRequest(sendOtpSchema, req.body);

    // Always send OTP regardless of whether a key exists — prevents email enumeration.
    // The verify-otp endpoint checks for duplicates before issuing a key.
    const { error: otpErr } = await supabaseAdmin.auth.signInWithOtp({ email });
    if (otpErr) {
      console.error('[DEVELOPERS] OTP send failed:', otpErr.message);
      throw createError('Failed to send verification code', 500, 'SERVER_ERROR');
    }

    console.log(`[DEVELOPERS] OTP sent to ${email.substring(0, 3)}***`);
    res.json({ success: true, message: 'If eligible, a verification code was sent to your email.' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /developers/register/verify-otp
// Verify code and receive your API key.
// ---------------------------------------------------------------------------

router.post('/register/verify-otp', enumerationLimiter, async (req, res, next) => {
  try {
    const { email, token, name } = validateRequest(verifyOtpSchema, req.body);

    // Check if an active key already exists
    const { data: existing } = await supabaseAdmin
      .from('api_keys')
      .select('id')
      .eq('contact_email', email)
      .eq('status', 'active')
      .maybeSingle();

    if (existing) {
      throw createError('An API key already exists for this email', 409, 'ALREADY_EXISTS');
    }

    // Verify OTP via Supabase auth
    const { error: verifyErr } = await supabaseAdmin.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });

    if (verifyErr) {
      console.error('[DEVELOPERS] OTP verify failed:', verifyErr.message);
      throw createError('Invalid or expired verification code', 401, 'INVALID_OTP');
    }

    // Generate and store the API key
    let key;
    try {
      key = await generateAndStoreKey(name.trim(), email);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[DEVELOPERS] Key insert failed:', msg);
      throw createError('Failed to create API key', 500, 'SERVER_ERROR');
    }

    console.log(`[DEVELOPERS] Key created for ${email.substring(0, 3)}***: ${key.name}`);

    res.status(201).json({
      api_key: {
        id: key.id,
        raw_key: key.raw_key,
        name: key.name,
        rate_limit_per_hour: 1000,
        created_at: key.created_at,
      },
      message: 'Save your raw_key — it will not be shown again.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /developers/me
// Get your API key info and webhook count.
// Requires X-API-Key header.
// ---------------------------------------------------------------------------

router.get('/me', requireApiKey, async (req, res, next) => {
  try {
    const keyId = req.apiKeyInfo!.id;

    const { data: keyInfo, error } = await supabaseAdmin
      .from('api_keys')
      .select('id, name, contact_email, rate_limit_per_hour, created_at')
      .eq('id', keyId)
      .single();

    if (error || !keyInfo) {
      throw createError('API key not found', 404, 'NOT_FOUND');
    }

    // Count active webhook subscriptions
    const { count: webhookCount } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('api_key_id', keyId)
      .eq('status', 'active');

    res.json({
      api_key: {
        id: keyInfo.id,
        name: keyInfo.name,
        contact_email: keyInfo.contact_email,
        rate_limit_per_hour: keyInfo.rate_limit_per_hour,
        webhook_count: webhookCount || 0,
        created_at: keyInfo.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /developers/keys/rotate
// Rotate your API key. Requires re-verifying your email via OTP.
// Send OTP first via /register/send-otp, then call this with the token.
// Requires current X-API-Key header.
// ---------------------------------------------------------------------------

router.post('/keys/rotate', writeLimiter, requireApiKey, async (req, res, next) => {
  try {
    const { email, token } = validateRequest(rotateKeySchema, req.body);
    const keyId = req.apiKeyInfo!.id;

    // Verify the key belongs to this email
    const { data: keyInfo } = await supabaseAdmin
      .from('api_keys')
      .select('id, contact_email')
      .eq('id', keyId)
      .single();

    if (!keyInfo || keyInfo.contact_email !== email) {
      throw createError('Email does not match this API key', 403, 'FORBIDDEN');
    }

    // Verify OTP
    const { error: verifyErr } = await supabaseAdmin.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });

    if (verifyErr) {
      throw createError('Invalid or expired verification code', 401, 'INVALID_OTP');
    }

    // Revoke old key
    await supabaseAdmin
      .from('api_keys')
      .update({ status: 'revoked' })
      .eq('id', keyId);

    // Create new key
    let newKey;
    try {
      newKey = await generateAndStoreKey(keyInfo.contact_email, keyInfo.contact_email);
    } catch (err: unknown) {
      // Re-activate old key if new one fails
      await supabaseAdmin
        .from('api_keys')
        .update({ status: 'active' })
        .eq('id', keyId);
      throw createError('Failed to create new key', 500, 'SERVER_ERROR');
    }

    // Migrate webhook subscriptions to new key
    await supabaseAdmin
      .from('webhook_subscriptions')
      .update({ api_key_id: newKey.id })
      .eq('api_key_id', keyId);

    console.log(`[DEVELOPERS] Key rotated for ${email.substring(0, 3)}***`);

    res.json({
      api_key: {
        id: newKey.id,
        raw_key: newKey.raw_key,
        name: newKey.name,
        rate_limit_per_hour: 1000,
        created_at: newKey.created_at,
      },
      message: 'Save your new raw_key — the old key has been deactivated.',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
