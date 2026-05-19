/**
 * Developer Portal — neighborhood-commons.org/developers
 *
 * Server-rendered HTML routes for self-service developer registration
 * and dashboard. No JavaScript required; standard browser form POSTs.
 *
 * PR 2 surface (this file):
 *   GET   /developers              — dispatch (logged-in → dashboard, else sign-up)
 *   GET   /developers/sign-up      — render registration form
 *   POST  /developers/register     — handle form, hold pending, send OTP, redirect
 *   GET   /developers/verify       — render OTP entry form
 *   POST  /developers/verify       — verify OTP, provision atomically, set cookie, redirect
 *   GET   /developers/dashboard    — read-only dashboard (requires session)
 *
 * Sessions are DB-backed (developer_sessions). CSRF protection via
 * double-submit cookie. Atomic provisioning at verify-time happens in
 * lib/developer-portal/provision.ts.
 */

import { Router, urlencoded } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import {
  storeOtp,
  verifyOtp,
  sendOtpEmail,
} from '../lib/developer-otp.js';
import {
  optionalDeveloperSession,
  requireDeveloperSession,
} from '../middleware/developer-session.js';
import {
  setSessionCookie,
  clearSessionCookie,
  getRawTokenFromRequest,
  destroySession,
} from '../lib/developer-portal/sessions.js';
import {
  issueCsrfCookie,
  validateCsrf,
  CSRF_FIELD_NAME,
} from '../lib/developer-portal/csrf.js';
import {
  portalShell,
  escapeHtml,
  escapeAttr,
  errorBanner,
  calloutBanner,
  hiddenInput,
} from '../lib/developer-portal/templates.js';
import {
  provisionDeveloper,
  holdPendingRegistration,
  readPendingRegistration,
  type RegistrationFormData,
} from '../lib/developer-portal/provision.js';
import {
  issueMagicLink,
  consumeMagicLink,
  sendMagicLinkEmail,
} from '../lib/developer-portal/magic-links.js';
import {
  generateTotpSecret,
  otpauthUrl,
  verifyTotp,
  formatSecretForDisplay,
} from '../lib/developer-portal/totp.js';
import {
  encryptMfaSecret,
  decryptMfaSecret,
  bufferToBytea,
  isMfaCryptoConfigured,
} from '../lib/developer-portal/mfa-crypto.js';
import {
  generateBackupCodes,
  consumeBackupCode,
  BACKUP_CODE_COUNT,
} from '../lib/developer-portal/backup-codes.js';
import QRCode from 'qrcode';

const router: ReturnType<typeof Router> = Router();

// Form-encoded bodies for HTML form POSTs. JSON middleware is global in
// app.ts; we add urlencoded here for the developer-portal forms.
router.use(urlencoded({ extended: false, limit: '32kb' }));
router.use(optionalDeveloperSession);

// =============================================================================
// RATE LIMITING
// =============================================================================
//
// Registration is OTP-gated, so the cost of abuse is bounded by email
// delivery costs. Limit modestly per IP.

const writeFormLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Too many form submissions; try again in a few minutes.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const renderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
});

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const registerFormSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
  app_name: z.string().trim().min(1).max(200),
  tagline: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  who_its_for: z.string().trim().max(500).optional().nullable(),
  app_url: z.string().trim().url().max(2000),
  category: z.string().trim().max(50).optional().nullable(),
  what_youre_building: z.string().trim().min(1).max(2000),
  verification_process: z.string().trim().min(1).max(2000),
  // CSRF token is consumed by middleware, not by this schema. We accept
  // additional unknown fields and let validateCsrf do its check separately.
}).passthrough();

const verifyFormSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
  code: z.string().trim().regex(/^\d{8}$/, 'Code must be 8 digits.'),
}).passthrough();

// =============================================================================
// GET /developers — dispatch
// =============================================================================

router.get('/', renderLimiter, (req, res) => {
  if (req.developerSession) {
    res.redirect(302, '/developers/dashboard');
    return;
  }
  res.redirect(302, '/developers/sign-up');
});

// =============================================================================
// GET /developers/sign-up
// =============================================================================

router.get('/sign-up', renderLimiter, (req, res) => {
  if (req.developerSession) {
    res.redirect(302, '/developers/dashboard');
    return;
  }
  const csrfToken = issueCsrfCookie(res);
  const error = (req.query.error as string) || null;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderSignUp(csrfToken, error, {}));
});

// =============================================================================
// POST /developers/register
// =============================================================================
//
// Validate form, hold the data in pending_registrations, send the OTP,
// redirect to the verify page. If anything's wrong, re-render the form
// with the error banner.

router.post('/register', writeFormLimiter, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.status(403);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(renderSignUp(issueCsrfCookie(res), 'Your session expired. Please try again.', req.body));
      return;
    }

    const parsed = registerFormSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const message = firstIssue ? `${firstIssue.path.join('.')}: ${firstIssue.message}` : 'Invalid form submission.';
      res.status(400);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(renderSignUp(issueCsrfCookie(res), message, req.body));
      return;
    }

    const form: RegistrationFormData = {
      email: parsed.data.email,
      app_name: parsed.data.app_name,
      tagline: parsed.data.tagline,
      description: parsed.data.description,
      who_its_for: parsed.data.who_its_for || null,
      app_url: parsed.data.app_url,
      category: parsed.data.category || null,
      what_youre_building: parsed.data.what_youre_building,
      verification_process: parsed.data.verification_process,
    };

    await holdPendingRegistration(form);
    const code = await storeOtp(form.email);
    await sendOtpEmail(form.email, code);

    res.redirect(303, `/developers/verify?email=${encodeURIComponent(form.email)}`);
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GET /developers/verify
// =============================================================================

router.get('/verify', renderLimiter, (req, res) => {
  if (req.developerSession) {
    res.redirect(302, '/developers/dashboard');
    return;
  }
  const email = typeof req.query.email === 'string' ? req.query.email : '';
  const error = (req.query.error as string) || null;
  const csrfToken = issueCsrfCookie(res);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderVerify(csrfToken, email, error));
});

// =============================================================================
// POST /developers/verify
// =============================================================================
//
// Verify OTP → run atomic provisioning → set session cookie → redirect to
// dashboard. Renders the verify page with an error banner on any failure.

router.post('/verify', writeFormLimiter, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.status(403);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(renderVerify(issueCsrfCookie(res), '', 'Your session expired. Please request a new code.'));
      return;
    }

    const parsed = verifyFormSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const message = firstIssue ? firstIssue.message : 'Invalid form submission.';
      res.status(400);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(renderVerify(issueCsrfCookie(res), (req.body?.email as string) || '', message));
      return;
    }

    const valid = await verifyOtp(parsed.data.email, parsed.data.code);
    if (!valid) {
      res.status(400);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(renderVerify(issueCsrfCookie(res), parsed.data.email, 'That code is invalid or expired. Request a new one if needed.'));
      return;
    }

    const form = await readPendingRegistration(parsed.data.email);
    if (!form) {
      res.status(400);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(renderVerify(issueCsrfCookie(res), parsed.data.email, "We don't have your registration on file anymore. Please start over."));
      return;
    }

    const result = await provisionDeveloper(form);
    setSessionCookie(res, result.rawSessionToken, result.sessionExpiresAt);

    // Single-use param to let the dashboard show the just-issued key once.
    res.redirect(303, `/developers/dashboard?just_registered=1&key=${encodeURIComponent(result.rawApiKey)}`);
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GET /developers/dashboard
// =============================================================================

router.get('/dashboard', renderLimiter, requireDeveloperSession, async (req, res, next) => {
  try {
    const session = req.developerSession!;
    // Load the key + profile for the dashboard view.
    const { data: keyRow } = await supabaseAdmin
      .from('api_keys')
      .select('id, name, key_prefix, contributor_tier, status, activated_at, contributor_profile_id, contact_email')
      .eq('id', session.api_key_id)
      .maybeSingle();

    if (!keyRow) {
      // Session points at a deleted key — destroy and bounce.
      const rawToken = getRawTokenFromRequest(req);
      if (rawToken) await destroySession(rawToken);
      clearSessionCookie(res);
      res.redirect(302, '/developers/sign-up');
      return;
    }

    let profile: Record<string, unknown> | null = null;
    if (keyRow.contributor_profile_id) {
      const { data: profileRow } = await supabaseAdmin
        .from('contributor_profiles')
        .select('id, slug, name, tagline, description, who_its_for, app_url, logo_url, category, status')
        .eq('id', keyRow.contributor_profile_id)
        .maybeSingle();
      profile = profileRow as Record<string, unknown> | null;
    }

    // Surface the raw key exactly once after registration. We never store
    // the raw key — it's passed through the URL and shown then cleared.
    const justRegisteredKey = req.query.just_registered === '1' && typeof req.query.key === 'string'
      ? (req.query.key as string)
      : null;

    // Issue a CSRF token for the logout form on this page.
    const csrfToken = issueCsrfCookie(res);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderDashboard({
      keyRow: keyRow as Record<string, unknown>,
      profile,
      justRegisteredKey,
      csrfToken,
    }));
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GET /developers/login
// =============================================================================
//
// Magic-link login for returning developers. Distinct from registration:
// no form data to hold, just email → click link in email → session.

router.get('/login', renderLimiter, (req, res) => {
  if (req.developerSession) {
    res.redirect(302, '/developers/dashboard');
    return;
  }
  const csrfToken = issueCsrfCookie(res);
  const error = (req.query.error as string) || null;
  const sent = req.query.sent === '1';
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderLogin(csrfToken, error, sent));
});

// =============================================================================
// POST /developers/login
// =============================================================================
//
// Issue a magic-link token for the given email and send it. We don't
// disclose whether the email actually has an account — same response
// shape regardless. Prevents user-enumeration.

const loginEmailSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
}).passthrough();

router.post('/login', writeFormLimiter, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.status(403);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLogin(issueCsrfCookie(res), 'Your session expired. Please try again.', false));
      return;
    }

    const parsed = loginEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLogin(issueCsrfCookie(res), 'Enter a valid email address.', false));
      return;
    }

    // Confirm an api_key exists for this email before sending. We don't
    // tell the user either way (no user enumeration) — but we do skip
    // the email send for unknown addresses to save delivery cost.
    const { data: keyRow } = await supabaseAdmin
      .from('api_keys')
      .select('id')
      .eq('contact_email', parsed.data.email)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();

    if (keyRow) {
      const rawToken = await issueMagicLink(parsed.data.email);
      await sendMagicLinkEmail(parsed.data.email, rawToken);
    }
    // Either way: render the same "check your email" confirmation.
    res.redirect(303, '/developers/login?sent=1');
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GET /developers/login/verify
// =============================================================================
//
// Consume the magic-link token from the URL. On success: look up the
// developer's api_key by email, create a session, set cookie, redirect
// to dashboard. On failure: redirect to login with error.

router.get('/login/verify', renderLimiter, async (req, res, next) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const email = await consumeMagicLink(token);
    if (!email) {
      res.redirect(303, '/developers/login?error=' + encodeURIComponent('That sign-in link is invalid or expired. Try again.'));
      return;
    }

    // Find the developer's most-recent active key for this email.
    const { data: keyRow } = await supabaseAdmin
      .from('api_keys')
      .select('id')
      .eq('contact_email', email)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!keyRow) {
      // Token was valid but no key — shouldn't normally happen since we
      // guard the issuance, but be defensive.
      res.redirect(303, '/developers/login?error=' + encodeURIComponent("We couldn't find your account. If this is unexpected, email hi@neighborhood-commons.org."));
      return;
    }

    const { rawToken: sessionToken, expiresAt } = await import('../lib/developer-portal/sessions.js').then(m => m.createSession(keyRow.id as string));
    setSessionCookie(res, sessionToken, expiresAt);
    res.redirect(303, '/developers/dashboard');
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GET /developers/profile
// =============================================================================
//
// Render the profile-edit form, pre-filled from the developer's
// contributor_profile. Requires session. No MFA gate — PR 4 adds that
// for post-activation edits.

router.get('/profile', renderLimiter, requireDeveloperSession, async (req, res, next) => {
  try {
    const session = req.developerSession!;
    const profile = await loadProfileForSession(session.api_key_id);
    if (!profile) {
      res.redirect(302, '/developers/dashboard');
      return;
    }

    const csrfToken = issueCsrfCookie(res);
    const error = (req.query.error as string) || null;
    const saved = req.query.saved === '1';
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderProfileEdit(csrfToken, profile, error, saved));
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// POST /developers/profile
// =============================================================================
//
// Apply profile edits. Validates each field; updates the
// contributor_profiles row; redirects back with a "saved" flag.

const profileEditSchema = z.object({
  name: z.string().trim().min(1).max(200),
  tagline: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  who_its_for: z.string().trim().max(500).optional().nullable(),
  app_url: z.string().trim().url().max(2000),
  category: z.string().trim().max(50).optional().nullable(),
  logo_url: z.string().trim().url().max(2000).optional().or(z.literal('')),
}).passthrough();

router.post('/profile', writeFormLimiter, requireDeveloperSession, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.redirect(303, '/developers/profile?error=' + encodeURIComponent('Your session expired. Please try again.'));
      return;
    }

    const parsed = profileEditSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const message = firstIssue ? `${firstIssue.path.join('.')}: ${firstIssue.message}` : 'Invalid submission.';
      res.redirect(303, '/developers/profile?error=' + encodeURIComponent(message));
      return;
    }

    const session = req.developerSession!;
    const profile = await loadProfileForSession(session.api_key_id);
    if (!profile) {
      res.redirect(302, '/developers/dashboard');
      return;
    }

    const update: Record<string, unknown> = {
      name: parsed.data.name,
      tagline: parsed.data.tagline,
      description: parsed.data.description,
      who_its_for: parsed.data.who_its_for || null,
      app_url: parsed.data.app_url,
      category: parsed.data.category || null,
      logo_url: parsed.data.logo_url || null,
    };

    const { error } = await supabaseAdmin
      .from('contributor_profiles')
      .update(update)
      .eq('id', profile.id as string);

    if (error) {
      console.error('[DEV_PORTAL] Profile update failed:', error.message);
      res.redirect(303, '/developers/profile?error=' + encodeURIComponent('Save failed. Please try again.'));
      return;
    }

    res.redirect(303, '/developers/profile?saved=1');
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// POST /developers/logout
// =============================================================================
//
// Sign out — destroys the session row and clears the cookie. Form POST
// from the dashboard.

router.post('/logout', writeFormLimiter, async (req, res, next) => {
  try {
    const rawToken = getRawTokenFromRequest(req);
    if (rawToken) await destroySession(rawToken);
    clearSessionCookie(res);
    res.redirect(303, '/developers/sign-up');
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// SECURITY: MFA enrollment + step-up
// =============================================================================
//
// PR 4b. TOTP enrollment for the developer dashboard; required before
// the operator surface unlocks. Backup codes generated at enrollment.
// Step-up flow re-verifies a TOTP / backup code for sensitive actions
// when the session's elevation window has lapsed (15 minutes).

const SECURITY_ENROLL_PATH = '/developers/security/enroll-mfa';
const SECURITY_STEPUP_PATH = '/developers/security/step-up';

/** Validate a return URL passed via ?return=. Must be a local path
 *  (single leading slash, no protocol, no double-slash). Anything else
 *  → fall back to the dashboard. Prevents open-redirect abuse. */
function safeReturnUrl(value: unknown): string {
  if (typeof value !== 'string') return '/developers/dashboard';
  if (!value.startsWith('/')) return '/developers/dashboard';
  if (value.startsWith('//')) return '/developers/dashboard';
  if (value.includes('\\')) return '/developers/dashboard';
  // Don't bounce back into the step-up route itself (loop guard)
  if (value.startsWith(SECURITY_STEPUP_PATH)) return '/developers/dashboard';
  return value;
}

async function loadKeyMfaState(apiKeyId: string): Promise<{
  mfa_enrolled_at: string | null;
  mfa_secret_encrypted: string | null;
  mfa_backup_codes_hashed: string[] | null;
} | null> {
  const { data } = await supabaseAdmin
    .from('api_keys')
    .select('mfa_enrolled_at, mfa_secret_encrypted, mfa_backup_codes_hashed')
    .eq('id', apiKeyId)
    .maybeSingle();
  if (!data) return null;
  return {
    mfa_enrolled_at: (data.mfa_enrolled_at as string | null) ?? null,
    // Supabase-js returns bytea columns as `\x<hex>` strings on SELECT.
    mfa_secret_encrypted: (data.mfa_secret_encrypted as string | null) ?? null,
    mfa_backup_codes_hashed: (data.mfa_backup_codes_hashed as string[] | null) ?? null,
  };
}

async function markSessionElevated(sessionId: string): Promise<void> {
  await supabaseAdmin
    .from('developer_sessions')
    .update({ mfa_verified_at: new Date().toISOString() })
    .eq('id', sessionId);
}

/**
 * Render a QR code for an otpauth URL as inline SVG. Used to make
 * MFA enrollment one-tap on a phone authenticator app instead of
 * typing 32 base32 characters by hand.
 *
 * Errors get swallowed and an empty string is returned — the page
 * still works (manual entry + tap-to-add link both remain).
 */
async function renderOtpauthQrSvg(otpauth: string): Promise<string> {
  try {
    return await QRCode.toString(otpauth, {
      type: 'svg',
      margin: 1,
      width: 220,
      errorCorrectionLevel: 'M',
    });
  } catch (err) {
    console.warn('[DEV_PORTAL] QR render failed:', err instanceof Error ? err.message : err);
    return '';
  }
}

// -----------------------------------------------------------------------------
// GET /developers/security/enroll-mfa
// -----------------------------------------------------------------------------
//
// Generate a fresh TOTP secret and render the enrollment form. The secret
// rides as a hidden form field through the POST round-trip (same surface
// as the QR an authenticator would scan — no additional exposure).

router.get('/security/enroll-mfa', renderLimiter, requireDeveloperSession, async (req, res, next) => {
  try {
    const returnUrl = safeReturnUrl(req.query.return);

    if (!isMfaCryptoConfigured()) {
      res.status(500).send(portalShell({
        title: 'MFA unavailable',
        body: `<h1>MFA temporarily unavailable.</h1>
          <p class="nc-portal-lede">The server's encryption key isn't configured, so MFA secrets can't be stored safely. Contact <a href="mailto:hi@neighborhood-commons.org">hi@neighborhood-commons.org</a>.</p>`,
      }));
      return;
    }

    const session = req.developerSession!;
    const state = await loadKeyMfaState(session.api_key_id);
    if (!state) {
      res.redirect(302, '/developers/login');
      return;
    }

    if (state.mfa_enrolled_at) {
      // MFA already enrolled. PR 4b doesn't ship disable/re-enroll —
      // direct the user back to the dashboard.
      res.send(portalShell({
        title: 'MFA already enrolled',
        body: `<h1>MFA is already enrolled.</h1>
          <p class="nc-portal-lede">Your account is protected by an authenticator app. To replace your device or regenerate backup codes, email <a href="mailto:hi@neighborhood-commons.org">hi@neighborhood-commons.org</a> — we'll verify your identity and reset.</p>
          <p><a href="${escapeAttr(returnUrl)}" class="nc-btn nc-btn--secondary">Continue</a></p>`,
      }));
      return;
    }

    // Fresh secret per GET. If the user reloads, they get a new one — that's
    // fine; only the secret submitted with the matching POST gets persisted.
    const secret = generateTotpSecret();
    const { data: keyRow } = await supabaseAdmin
      .from('api_keys')
      .select('contact_email, name')
      .eq('id', session.api_key_id)
      .maybeSingle();
    const accountName = (keyRow?.contact_email as string | undefined) || 'developer';
    const issuer = 'Neighborhood Commons';
    const url = otpauthUrl({ issuer, accountName, secret });
    const qrSvg = await renderOtpauthQrSvg(url);

    const csrfToken = issueCsrfCookie(res);
    res.send(portalShell({
      title: 'Enable MFA',
      body: renderEnrollMfa({ csrfToken, secret, otpauth: url, qrSvg, accountName, returnUrl, error: null }),
    }));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /developers/security/enroll-mfa
// -----------------------------------------------------------------------------
//
// Verify the submitted code against the secret echoed back in the form.
// On success, encrypt + persist the secret, generate backup codes,
// elevate the session, render the codes inline (single chance to copy).

const enrollMfaSchema = z.object({
  secret: z.string().min(16).max(64),
  code: z.string().min(6).max(7),
  return: z.string().optional(),
}).passthrough();

router.post('/security/enroll-mfa', writeFormLimiter, requireDeveloperSession, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.status(403).send('CSRF check failed.');
      return;
    }

    if (!isMfaCryptoConfigured()) {
      res.status(500).send('MFA unavailable.');
      return;
    }

    const parsed = enrollMfaSchema.safeParse(req.body || {});
    const returnUrl = safeReturnUrl(parsed.success ? parsed.data.return : undefined);
    if (!parsed.success) {
      res.status(400).send(portalShell({
        title: 'Enable MFA',
        body: renderEnrollMfa({
          csrfToken: issueCsrfCookie(res),
          secret: '',
          otpauth: '',
          qrSvg: '',
          accountName: '',
          returnUrl,
          error: 'Submit a 6-digit code from your authenticator.',
        }),
      }));
      return;
    }

    const session = req.developerSession!;
    const state = await loadKeyMfaState(session.api_key_id);
    if (!state) {
      res.redirect(302, '/developers/login');
      return;
    }
    if (state.mfa_enrolled_at) {
      // Race: another tab enrolled. Forward to the already-enrolled page.
      res.redirect(303, SECURITY_ENROLL_PATH);
      return;
    }

    if (!verifyTotp(parsed.data.secret, parsed.data.code)) {
      // Re-render with the same secret so the user can retry without
      // re-pairing the authenticator.
      const { data: keyRow } = await supabaseAdmin
        .from('api_keys')
        .select('contact_email')
        .eq('id', session.api_key_id)
        .maybeSingle();
      const accountName = (keyRow?.contact_email as string | undefined) || 'developer';
      const otpauthUrlStr = otpauthUrl({ issuer: 'Neighborhood Commons', accountName, secret: parsed.data.secret });
      const qrSvg = await renderOtpauthQrSvg(otpauthUrlStr);
      res.status(400).send(portalShell({
        title: 'Enable MFA',
        body: renderEnrollMfa({
          csrfToken: issueCsrfCookie(res),
          secret: parsed.data.secret,
          otpauth: otpauthUrlStr,
          qrSvg,
          accountName,
          returnUrl,
          error: "That code didn't match. Try the next one your authenticator shows.",
        }),
      }));
      return;
    }

    // Verified. Persist the encrypted secret + new backup codes; flip the
    // enrolled flag; elevate this session.
    const encryptedBuf = encryptMfaSecret(parsed.data.secret);
    const { raw: rawCodes, hashed: hashedCodes } = generateBackupCodes();
    const nowIso = new Date().toISOString();

    const { error: updErr } = await supabaseAdmin
      .from('api_keys')
      .update({
        mfa_secret_encrypted: bufferToBytea(encryptedBuf),
        mfa_enrolled_at: nowIso,
        mfa_backup_codes_hashed: hashedCodes,
      })
      .eq('id', session.api_key_id);

    if (updErr) {
      console.error('[DEV_PORTAL] MFA enroll persist failed:', updErr.message);
      res.status(500).send('Failed to save MFA settings.');
      return;
    }

    await markSessionElevated(session.id);

    res.send(portalShell({
      title: 'MFA enrolled',
      body: renderMfaSuccess({ backupCodes: rawCodes, returnUrl }),
    }));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// GET /developers/security/step-up
// -----------------------------------------------------------------------------
//
// Show the step-up form. Used by sensitive routes (operator portal,
// future profile-edit hardening) when the session's elevation window
// has lapsed. ?return= captures where to send the user after success;
// validated against safeReturnUrl.

router.get('/security/step-up', renderLimiter, requireDeveloperSession, async (req, res, next) => {
  try {
    const returnUrl = safeReturnUrl(req.query.return);
    const session = req.developerSession!;
    const state = await loadKeyMfaState(session.api_key_id);
    if (!state || !state.mfa_enrolled_at) {
      // No MFA on file → bounce to enrollment, preserving the return.
      const target = `${SECURITY_ENROLL_PATH}?return=${encodeURIComponent(returnUrl)}`;
      res.redirect(303, target);
      return;
    }

    const csrfToken = issueCsrfCookie(res);
    res.send(portalShell({
      title: 'Verify it’s you',
      body: renderStepUp({ csrfToken, returnUrl, error: null }),
    }));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// POST /developers/security/step-up
// -----------------------------------------------------------------------------
//
// Verify a TOTP code OR a backup code. On success, mark the session
// elevated and redirect to the return URL.

const stepUpSchema = z.object({
  code: z.string().min(6).max(20),
  return: z.string().optional(),
}).passthrough();

router.post('/security/step-up', writeFormLimiter, requireDeveloperSession, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.status(403).send('CSRF check failed.');
      return;
    }

    const parsed = stepUpSchema.safeParse(req.body || {});
    const returnUrl = safeReturnUrl(parsed.success ? parsed.data.return : undefined);
    if (!parsed.success) {
      res.status(400).send(portalShell({
        title: 'Verify it’s you',
        body: renderStepUp({ csrfToken: issueCsrfCookie(res), returnUrl, error: 'Enter your 6-digit code or a backup code.' }),
      }));
      return;
    }

    const session = req.developerSession!;
    const state = await loadKeyMfaState(session.api_key_id);
    if (!state || !state.mfa_enrolled_at || !state.mfa_secret_encrypted) {
      res.redirect(303, `${SECURITY_ENROLL_PATH}?return=${encodeURIComponent(returnUrl)}`);
      return;
    }

    const submitted = parsed.data.code.trim();
    const looksLikeTotp = /^[0-9]{6}$/.test(submitted.replace(/\s+/g, ''));

    let verified = false;

    if (looksLikeTotp) {
      try {
        const secret = decryptMfaSecret(state.mfa_secret_encrypted);
        verified = verifyTotp(secret, submitted);
      } catch (err) {
        console.error('[DEV_PORTAL] Step-up decrypt failed:', err instanceof Error ? err.message : err);
      }
    } else {
      // Treat as backup code. Consume removes the matched hash.
      const remaining = consumeBackupCode(submitted, state.mfa_backup_codes_hashed || []);
      if (remaining) {
        const { error: bcErr } = await supabaseAdmin
          .from('api_keys')
          .update({ mfa_backup_codes_hashed: remaining })
          .eq('id', session.api_key_id);
        if (!bcErr) verified = true;
      }
    }

    if (!verified) {
      res.status(400).send(portalShell({
        title: 'Verify it’s you',
        body: renderStepUp({ csrfToken: issueCsrfCookie(res), returnUrl, error: 'That code didn’t match. Try again.' }),
      }));
      return;
    }

    await markSessionElevated(session.id);
    res.redirect(303, returnUrl);
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// Profile loader (shared)
// =============================================================================

async function loadProfileForSession(apiKeyId: string): Promise<Record<string, unknown> | null> {
  const { data: keyRow } = await supabaseAdmin
    .from('api_keys')
    .select('id, contributor_profile_id')
    .eq('id', apiKeyId)
    .maybeSingle();

  if (!keyRow || !keyRow.contributor_profile_id) return null;

  const { data: profile } = await supabaseAdmin
    .from('contributor_profiles')
    .select('id, slug, name, tagline, description, who_its_for, app_url, logo_url, category, status')
    .eq('id', keyRow.contributor_profile_id)
    .maybeSingle();

  return (profile as Record<string, unknown>) || null;
}

// =============================================================================
// HTML RENDERING
// =============================================================================

function renderSignUp(csrfToken: string, error: string | null, prefill: Record<string, unknown>): string {
  const body = `
    <h1>Build on the Neighborhood Commons.</h1>
    <p class="nc-portal-lede">
      Tell us about your app. We'll send a verification code, issue your service key, and route a one-time operator review. Reads work immediately; writes activate when we approve — usually within a day.
    </p>

    <div class="nc-callout">
      <strong>The deal, in one breath.</strong> Reads are free. Writes are licensed <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC&nbsp;BY&nbsp;4.0</a> — other apps in the ecosystem can mix and remix anything you contribute, with attribution back to you. Public information is welcome. Copyrighted material you don't have rights to is not.
    </div>

    <details class="nc-explainer">
      <summary>What kinds of contributions fit — and what doesn't</summary>

      <p><strong>Three shapes of contribution, all welcome:</strong></p>
      <ul>
        <li><strong>First-party publishing.</strong> You're building an app that lets people post things they run. "I'm building a tool where yoga teachers across Philly post their class schedules." The yoga teacher asserts their own offering via you.</li>
        <li><strong>Proxying public information.</strong> You're collecting public facts that already exist on the open web. "I'm pulling event listings from venue websites across South Philly into a single feed." Public info is public; bringing it into the Commons makes it discoverable to every other app.</li>
        <li><strong>Witnessing with evidence.</strong> You're capturing things observed in the world. "Users of my app photograph flyers they see on telephone poles, and I OCR them into structured events." The flyer is public; the evidence is the photo.</li>
      </ul>

      <p><strong>What's not permitted:</strong></p>
      <ul>
        <li>Copyrighted text, photos, video, or audio you don't have rights to redistribute under CC&nbsp;BY&nbsp;4.0. (You can link to it from a description, but the description itself must be yours or rights-cleared.)</li>
        <li>Personal information about individuals. The Commons holds zero PII by design. The entities you publish are organizations, venues, performers, classes — not individual private people.</li>
        <li>Content you haven't verified is real. Confidence isn't required; care is.</li>
      </ul>

      <p><strong>There's a market here, and quality matters.</strong> Consumer apps that read from the Commons filter what they surface. App A might only show events from first-party verified organizations. App B might show everything but visually mark unverified entries. App C might block-list contributors whose data is consistently wrong. If the information you contribute is sloppy or suspect, downstream apps will rightly filter it out — and you'll have done a disservice both to your own work and to the people you were trying to support. Conversely, accurate well-attributed contributions get picked up everywhere and compound your reach.</p>

      <p>The two questions below are how we get a feel for the shape of what you're doing. Be plain and specific — there's no special phrasing we're listening for.</p>
    </details>

    ${errorBanner(error)}
    <form method="POST" action="/developers/register" novalidate>
      ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
      ${textField('email', 'Email', { type: 'email', required: true, value: prefill.email, hint: "We'll send your verification code here." })}
      ${textField('app_name', 'App name', { required: true, value: prefill.app_name, hint: 'How readers will see you. "Via Merrie." "Via Holler." Keep it short.' })}
      ${textField('tagline', 'Tagline', { required: true, maxlength: 120, value: prefill.tagline, hint: 'One-liner. Up to ~80 chars renders well in splash cards.' })}
      ${textareaField('description', 'Description', { required: true, value: prefill.description, hint: '~2000 chars. Plain text for now.' })}
      ${textField('app_url', 'App URL', { type: 'url', required: true, value: prefill.app_url, hint: 'Where users go to use your app.' })}
      ${textField('who_its_for', "Who it's for (optional)", { maxlength: 500, value: prefill.who_its_for })}
      ${textField('category', 'Category (optional)', { maxlength: 50, value: prefill.category, hint: 'Free-form, e.g. "publishing", "discovery", "civic".' })}
      ${textareaField('what_youre_building', "What you're building", { required: true, value: prefill.what_youre_building, hint: `A paragraph is plenty. Name the data shape (events, hours, schedules, broadcasts) and the entities involved. Concrete is best — "I'm collecting public yoga-class schedules across Philly," or "I'm building a tool where chess clubs post their meetups," or "I'm OCR-ing flyers my users photograph." Any of those reads cleanly.` })}
      ${textareaField('verification_process', 'Verification process', { required: true, value: prefill.verification_process, hint: `How do you confirm the publisher of your content has authority over what they're publishing? Whatever fits: "I scrape venue calendar pages and de-dupe — the venues already post these publicly." Or: "Teachers create an account in my app and add their own classes." Or: "Users upload a photo of the flyer with each submission." Any of those reads cleanly.` })}
      <button type="submit" class="nc-btn">Send verification code</button>
    </form>
    <div class="nc-portal-footer-aux" style="margin-top:32px; font-size:13px; color:var(--muted);">
      Already registered? <a href="/developers/login">Sign in</a> via magic link.
    </div>
  `;
  return portalShell({ title: 'Sign up', body });
}

function renderLogin(csrfToken: string, error: string | null, sent: boolean): string {
  if (sent) {
    const body = `
      <h1>Check your email.</h1>
      <p class="nc-portal-lede">
        If your address is registered, we sent a sign-in link. Click it within 15 minutes to land on your dashboard.
      </p>
      <div class="nc-portal-footer-aux" style="margin-top:16px; font-size:13px; color:var(--muted);">
        <a href="/developers/login">Send again</a> · <a href="/developers/sign-up">Create a new account</a>
      </div>
    `;
    return portalShell({ title: 'Check your email', body });
  }

  const body = `
    <h1>Sign in.</h1>
    <p class="nc-portal-lede">
      Enter the email you registered with. We'll send a single-use sign-in link.
    </p>
    ${errorBanner(error)}
    <form method="POST" action="/developers/login" novalidate>
      ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
      ${textField('email', 'Email', { type: 'email', required: true, hint: "The same address you used to register." })}
      <button type="submit" class="nc-btn">Send sign-in link</button>
    </form>
    <div class="nc-portal-footer-aux" style="margin-top:32px; font-size:13px; color:var(--muted);">
      Don't have an account yet? <a href="/developers/sign-up">Register</a>.
    </div>
  `;
  return portalShell({ title: 'Sign in', body });
}

function renderProfileEdit(csrfToken: string, profile: Record<string, unknown>, error: string | null, saved: boolean): string {
  const status = (profile.status as string) || 'pending';
  const statusClass = status === 'active' ? 'nc-status--active' : status === 'suspended' ? 'nc-status--suspended' : 'nc-status--pending';

  const body = `
    <h1>Edit profile.</h1>
    <p class="nc-portal-lede">
      This is what readers see when they tap "via ${escapeHtml((profile.name as string) || 'your app')}" in a consumer app.
      Slug <code>${escapeHtml(profile.slug as string)}</code> ·
      <span class="nc-status ${statusClass}">${status}</span>
    </p>
    ${saved ? calloutBanner('Saved.') : ''}
    ${errorBanner(error)}
    <form method="POST" action="/developers/profile" novalidate>
      ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
      ${textField('name', 'App name', { required: true, value: profile.name, hint: 'Display name. Shown verbatim in splash cards.' })}
      ${textField('tagline', 'Tagline', { required: true, maxlength: 120, value: profile.tagline, hint: 'One-liner. Up to ~80 chars renders well in splash cards.' })}
      ${textareaField('description', 'Description', { required: true, value: profile.description, hint: '~2000 chars. Plain text for now.' })}
      ${textField('app_url', 'App URL', { type: 'url', required: true, value: profile.app_url })}
      ${textField('logo_url', 'Logo URL (optional)', { type: 'url', value: profile.logo_url, hint: 'Square image works best. Paste a URL for now; file upload is coming.' })}
      ${textField('who_its_for', "Who it's for (optional)", { maxlength: 500, value: profile.who_its_for })}
      ${textField('category', 'Category (optional)', { maxlength: 50, value: profile.category, hint: 'Free-form, e.g. "publishing", "discovery", "civic".' })}
      <button type="submit" class="nc-btn">Save</button>
      <a href="/developers/dashboard" class="nc-btn nc-btn--secondary" style="margin-left:8px;">Back to dashboard</a>
    </form>
  `;
  return portalShell({ title: 'Edit profile', body });
}

function renderVerify(csrfToken: string, email: string, error: string | null): string {
  const body = `
    <h1>Check your email.</h1>
    <p class="nc-portal-lede">
      We sent an 8-digit code to <strong>${escapeHtml(email)}</strong>.
      Enter it below within the next 10 minutes.
    </p>
    ${errorBanner(error)}
    <form method="POST" action="/developers/verify" novalidate>
      ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
      ${hiddenInput('email', email)}
      <div class="nc-field">
        <label for="code">Verification code <span class="nc-required">*</span></label>
        <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]{8}" required>
        <span class="nc-field-hint">Eight digits, no spaces.</span>
      </div>
      <button type="submit" class="nc-btn">Confirm</button>
      <a href="/developers/sign-up" class="nc-btn nc-btn--secondary" style="margin-left:8px;">Start over</a>
    </form>
  `;
  return portalShell({ title: 'Verify', body });
}

function renderDashboard(args: {
  keyRow: Record<string, unknown>;
  profile: Record<string, unknown> | null;
  justRegisteredKey: string | null;
  csrfToken: string;
}): string {
  const { keyRow, profile, justRegisteredKey, csrfToken } = args;
  const status = (keyRow.activated_at ? 'active' : 'pending') as 'active' | 'pending';
  const keyPrefix = (keyRow.key_prefix as string) || '';

  const justRegisteredCallout = justRegisteredKey
    ? `${calloutBanner('Welcome! Your service key is below. Copy it now — it will not be shown again.')}
       <div class="nc-card">
         <div class="nc-card-label">Your service key (copy now)</div>
         <div class="nc-key">${escapeHtml(justRegisteredKey)}</div>
         <div style="margin-top:10px; font-size:13px; color:var(--muted);">
           Pass via the <code>X-API-Key</code> header on requests. Reads work immediately; writes activate after operator review.
         </div>
       </div>`
    : '';

  const statusClass = status === 'active' ? 'nc-status--active' : 'nc-status--pending';

  const profileCard = profile
    ? `<div class="nc-card">
         <div class="nc-card-label">Public profile preview</div>
         <h2 style="margin:6px 0 4px;">${escapeHtml(profile.name as string)}</h2>
         <div style="font-size:13px; color:var(--muted); margin-bottom:8px;">
           Slug: <code>${escapeHtml(profile.slug as string)}</code>
           ${profile.app_url ? ` · <a href="${escapeAttr(profile.app_url as string)}" target="_blank" rel="noopener">${escapeHtml(profile.app_url as string)}</a>` : ''}
         </div>
         ${profile.tagline ? `<div style="margin:8px 0;">${escapeHtml(profile.tagline as string)}</div>` : ''}
         ${profile.description ? `<div style="margin:8px 0; color:var(--ink-2); white-space:pre-wrap;">${escapeHtml(profile.description as string)}</div>` : ''}
         <div style="margin-top:14px;">
           <a href="/developers/profile" class="nc-btn nc-btn--secondary">Edit profile</a>
         </div>
       </div>`
    : '';

  const body = `
    <h1>Dashboard</h1>
    <p class="nc-portal-lede">
      ${escapeHtml((keyRow.name as string) || 'Your app')} ·
      <span class="nc-status ${statusClass}">${status}</span>
    </p>
    ${justRegisteredCallout}
    <div class="nc-card">
      <div class="nc-card-label">Service key</div>
      <div style="font-family:var(--font-mono); font-size:13px; color:var(--ink);">${escapeHtml(keyPrefix)}…</div>
      <div style="margin-top:10px; font-size:13px; color:var(--muted);">
        ${status === 'pending'
          ? 'Status: <strong>pending</strong>. Reads work immediately; writes return <code>403 KEY_PENDING</code> until an operator activates your key.'
          : 'Status: <strong>active</strong>. Reads and writes are live.'}
      </div>
    </div>
    ${profileCard}
    <div class="nc-card">
      <div class="nc-card-label">What's next</div>
      <ul style="margin:6px 0 0 18px; padding:0; line-height:1.7;">
        <li>${status === 'pending' ? 'Activation email arrives when the operator reviews your application.' : 'Your key is active. Build away.'}</li>
        <li>MFA enrollment ships in the next release.</li>
        <li>Polish your profile via <a href="/developers/profile">Edit profile</a> — readers see it when they tap "via ${escapeHtml((keyRow.name as string) || 'your app')}" in a consumer app.</li>
      </ul>
    </div>
    <form method="POST" action="/developers/logout" style="margin-top:32px;">
      ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
      <button type="submit" class="nc-btn nc-btn--secondary">Sign out</button>
    </form>
  `;
  return portalShell({ title: 'Dashboard', body });
}

// =============================================================================
// HTML FIELD HELPERS
// =============================================================================

function textField(
  name: string,
  label: string,
  opts: {
    type?: string;
    required?: boolean;
    maxlength?: number;
    value?: unknown;
    hint?: string;
  } = {},
): string {
  const type = opts.type || 'text';
  const required = opts.required ? ' required' : '';
  const maxlength = opts.maxlength ? ` maxlength="${opts.maxlength}"` : '';
  const value = opts.value && typeof opts.value === 'string' ? ` value="${escapeAttr(opts.value)}"` : '';
  const hint = opts.hint ? `<span class="nc-field-hint">${escapeHtml(opts.hint)}</span>` : '';
  const reqMarker = opts.required ? '<span class="nc-required">*</span>' : '';
  return `<div class="nc-field">
    <label for="${escapeAttr(name)}">${escapeHtml(label)} ${reqMarker}</label>
    <input id="${escapeAttr(name)}" name="${escapeAttr(name)}" type="${escapeAttr(type)}"${value}${maxlength}${required}>
    ${hint}
  </div>`;
}

function textareaField(
  name: string,
  label: string,
  opts: {
    required?: boolean;
    value?: unknown;
    hint?: string;
  } = {},
): string {
  const required = opts.required ? ' required' : '';
  const value = opts.value && typeof opts.value === 'string' ? escapeHtml(opts.value) : '';
  const hint = opts.hint ? `<span class="nc-field-hint">${escapeHtml(opts.hint)}</span>` : '';
  const reqMarker = opts.required ? '<span class="nc-required">*</span>' : '';
  return `<div class="nc-field">
    <label for="${escapeAttr(name)}">${escapeHtml(label)} ${reqMarker}</label>
    <textarea id="${escapeAttr(name)}" name="${escapeAttr(name)}"${required}>${value}</textarea>
    ${hint}
  </div>`;
}

// =============================================================================
// MFA RENDERING HELPERS (PR 4b)
// =============================================================================

function renderEnrollMfa(args: {
  csrfToken: string;
  secret: string;
  otpauth: string;
  /** Inline SVG QR code for the otpauth URL. Empty string when rendering
   *  failed or no secret is present (the schema-error re-render path). */
  qrSvg: string;
  accountName: string;
  returnUrl: string;
  error: string | null;
}): string {
  const display = args.secret ? formatSecretForDisplay(args.secret) : '';
  // The QR card is the primary path. The manual secret + tap-link stay
  // as fallback for desktops without a paired phone camera, or for users
  // who prefer typing.
  const qrCard = args.qrSvg
    ? `
      <div class="nc-card" style="text-align:center;">
        <div class="nc-card-label" style="text-align:left;">Scan with your authenticator</div>
        <div style="margin:12px auto; max-width:240px;" aria-label="QR code containing the MFA setup link">${args.qrSvg}</div>
        <div style="font-size:13px; color:var(--muted); text-align:left;">
          Open the authenticator app, choose <em>Add account</em> → <em>Scan QR</em>. Or use one of the manual options below.
        </div>
      </div>
    `
    : '';
  return `
    <h1>Enable MFA</h1>
    <p class="nc-portal-lede">
      Add an authenticator app (1Password, Authy, Google Authenticator, Bitwarden — any of them work) to protect this account.
      Required before the operator surface unlocks.
    </p>
    ${errorBanner(args.error)}
    ${qrCard}
    <div class="nc-card">
      <div class="nc-card-label">Manual entry</div>
      <p style="margin:0 0 10px; font-size:14px; color:var(--muted);">
        If scanning isn't an option, type the secret into your authenticator under <em>Neighborhood Commons (${escapeHtml(args.accountName)})</em>, or tap the otpauth link from your phone.
      </p>
      <div class="nc-key" style="margin-bottom:12px;">${escapeHtml(display)}</div>
      <div style="word-break:break-all; font-family:var(--font-mono); font-size:12px;">
        <a href="${escapeAttr(args.otpauth)}">${escapeHtml(args.otpauth)}</a>
      </div>
    </div>
    <form method="POST" action="${SECURITY_ENROLL_PATH}" novalidate>
      ${hiddenInput(CSRF_FIELD_NAME, args.csrfToken)}
      ${hiddenInput('secret', args.secret)}
      ${hiddenInput('return', args.returnUrl)}
      ${textField('code', 'Verification code', { required: true, maxlength: 7, hint: 'Six digits from your authenticator once the entry is added.' })}
      <button type="submit" class="nc-btn">Verify and enable MFA</button>
      <a href="/developers/dashboard" class="nc-btn nc-btn--secondary" style="margin-left:8px;">Cancel</a>
    </form>
  `;
}

function renderMfaSuccess(args: { backupCodes: string[]; returnUrl: string }): string {
  const codes = args.backupCodes
    .map((c) => `<li style="font-family:var(--font-mono); font-size:15px; padding:4px 0;">${escapeHtml(c)}</li>`)
    .join('');
  const continueLabel = args.returnUrl === '/developers/dashboard'
    ? "I've saved the codes — back to dashboard"
    : "I've saved the codes — continue";
  return `
    <h1>MFA is on.</h1>
    ${calloutBanner(`Save these ${BACKUP_CODE_COUNT} backup codes somewhere safe. They are shown once. Each is single-use.`)}
    <div class="nc-card">
      <div class="nc-card-label">Backup codes</div>
      <ul style="list-style:none; margin:0; padding:0; columns: 2;">
        ${codes}
      </ul>
      <div style="margin-top:14px; font-size:13px; color:var(--muted);">
        Use one of these if you lose access to your authenticator. After use, the code is gone — generate a new batch by emailing <a href="mailto:hi@neighborhood-commons.org">hi@neighborhood-commons.org</a> if you run low.
      </div>
    </div>
    <div style="margin-top:24px;">
      <a href="${escapeAttr(args.returnUrl)}" class="nc-btn">${escapeHtml(continueLabel)}</a>
    </div>
  `;
}

function renderStepUp(args: { csrfToken: string; returnUrl: string; error: string | null }): string {
  return `
    <h1>Verify it’s you.</h1>
    <p class="nc-portal-lede">
      For this action we need a fresh check. Enter the 6-digit code from your authenticator, or a backup code.
    </p>
    ${errorBanner(args.error)}
    <form method="POST" action="${SECURITY_STEPUP_PATH}" novalidate>
      ${hiddenInput(CSRF_FIELD_NAME, args.csrfToken)}
      ${hiddenInput('return', args.returnUrl)}
      ${textField('code', 'Code', { required: true, maxlength: 20, hint: 'Six digits from your authenticator, or a backup code like XXXXX-XXXXX.' })}
      <button type="submit" class="nc-btn">Continue</button>
      <a href="/developers/dashboard" class="nc-btn nc-btn--secondary" style="margin-left:8px;">Cancel</a>
    </form>
  `;
}

export default router;
