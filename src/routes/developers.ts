/**
 * Developer Registration Routes — Neighborhood Commons
 *
 * Self-service API key registration for developers.
 * Email + OTP verification → free API key (1000 req/hr).
 * No admin approval required.
 */

import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';
import { validateRequest } from '../lib/helpers.js';
import { createError } from '../middleware/error-handler.js';
import { enumerationLimiter, writeLimiter } from '../middleware/rate-limit.js';
import { requireApiKey } from '../middleware/api-key.js';

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
// Helpers
// ---------------------------------------------------------------------------

/** Generate a prefixed API key: fib_<32 random hex chars> */
function generateApiKey(): string {
  return 'fib_' + crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// POST /developers/register/send-otp
// Send a verification code to register for an API key.
// ---------------------------------------------------------------------------

router.post('/register/send-otp', enumerationLimiter, async (req, res, next) => {
  try {
    const { email } = validateRequest(sendOtpSchema, req.body);

    // Check if an active key already exists for this email
    const { data: existing } = await supabaseAdmin
      .from('api_keys')
      .select('id')
      .eq('owner_email', email)
      .eq('is_active', true)
      .maybeSingle();

    if (existing) {
      throw createError('An API key already exists for this email. Use the rotate endpoint to get a new key.', 409, 'ALREADY_EXISTS');
    }

    // Send OTP via Supabase auth (same mechanism as portal)
    const { error: otpErr } = await supabaseAdmin.auth.signInWithOtp({ email });
    if (otpErr) {
      console.error('[DEVELOPERS] OTP send failed:', otpErr.message);
      throw createError('Failed to send verification code', 500, 'SERVER_ERROR');
    }

    console.log(`[DEVELOPERS] OTP sent to ${email.substring(0, 3)}***`);
    res.json({ success: true, message: 'Verification code sent to your email.' });
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
      .eq('owner_email', email)
      .eq('is_active', true)
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

    // Generate API key and store it
    const rawKey = generateApiKey();

    const { data: keyRow, error: insertErr } = await supabaseAdmin
      .from('api_keys')
      .insert({
        key: rawKey,
        name: name.trim(),
        tier: 'free',
        rate_limit_per_hour: 1000,
        owner_email: email,
        is_active: true,
      })
      .select('id, name, created_at')
      .single();

    if (insertErr) {
      console.error('[DEVELOPERS] Key insert failed:', insertErr.message);
      throw createError('Failed to create API key', 500, 'SERVER_ERROR');
    }

    console.log(`[DEVELOPERS] Key created for ${email.substring(0, 3)}***: ${keyRow.name}`);

    res.status(201).json({
      api_key: {
        id: keyRow.id,
        raw_key: rawKey,
        name: keyRow.name,
        rate_limit_per_hour: 1000,
        created_at: keyRow.created_at,
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
      .select('id, name, owner_email, rate_limit_per_hour, created_at')
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
      .eq('is_active', true);

    res.json({
      api_key: {
        id: keyInfo.id,
        name: keyInfo.name,
        owner_email: keyInfo.owner_email,
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
      .select('id, owner_email')
      .eq('id', keyId)
      .single();

    if (!keyInfo || keyInfo.owner_email !== email) {
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

    // Deactivate old key
    await supabaseAdmin
      .from('api_keys')
      .update({ is_active: false })
      .eq('id', keyId);

    // Create new key (preserves webhook subscriptions by migrating the FK)
    const newRawKey = generateApiKey();
    const { data: newKey, error: insertErr } = await supabaseAdmin
      .from('api_keys')
      .insert({
        key: newRawKey,
        name: keyInfo.owner_email,
        tier: 'free',
        rate_limit_per_hour: 1000,
        owner_email: keyInfo.owner_email,
        is_active: true,
      })
      .select('id, name, created_at')
      .single();

    if (insertErr) {
      // Re-activate old key if new one fails
      await supabaseAdmin
        .from('api_keys')
        .update({ is_active: true })
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
        raw_key: newRawKey,
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
