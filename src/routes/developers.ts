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
import { config } from '../config.js';
import {
  storeOtp,
  verifyOtp,
  sendOtpEmail,
} from '../lib/developer-otp.js';
import {
  optionalDeveloperSession,
  requireDeveloperSession,
  requireStepUp,
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
import multer from 'multer';
import {
  processAndUploadLogo,
  deleteLogo,
  LOGO_MAX_BYTES,
} from '../lib/developer-portal/logo-upload.js';

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
      .select('id, name, key_prefix, contributor_tier, status, activated_at, contributor_profile_id, contact_email, mfa_enrolled_at, witness_authority, witness_authority_requested_at')
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

    // Is this developer also an operator? Surfaces the operator-portal CTA
    // on the dashboard so they don't have to remember the URL.
    const contactEmail = (keyRow.contact_email as string | undefined)?.toLowerCase() || '';
    const isOperator = contactEmail !== '' && config.operator.emails.includes(contactEmail);

    // Resolve the developer's collective + their publishing scope.
    //
    // api_key_organization_links is a SCOPING table — it lists every org this
    // key may write to. A publisher (Merrie) is scoped to many orgs it
    // publishes for; a witnessing app (Fiber) typically has just its collective.
    // The collective is the org the /collective/provision flow created, named
    // "<App> Community" (the convention that flow writes) — so match on that,
    // NOT on "first linked org", which would mislabel an arbitrary publishing
    // org as the collective.
    const collectiveName = `${(keyRow.name as string | null) || 'App'} Community`;
    const { data: links } = await supabaseAdmin
      .from('api_key_organization_links')
      .select('organization_id')
      .eq('api_key_id', session.api_key_id);
    const linkedOrgIds = (links || []).map((l) => l.organization_id as string);
    const publishingOrgCount = linkedOrgIds.length;
    let collectiveOrg: { id: string; name: string; slug: string } | null = null;
    if (linkedOrgIds.length > 0) {
      const { data: orgs } = await supabaseAdmin
        .from('organizations')
        .select('id, name, slug')
        .in('id', linkedOrgIds);
      const match = (orgs || []).find((o) => (o.name as string) === collectiveName);
      if (match) {
        collectiveOrg = {
          id: match.id as string,
          name: match.name as string,
          slug: match.slug as string,
        };
      }
    }

    // Surface one-shot success / error flags for the collective + witness flows.
    const flashMessage = req.query.collective === 'provisioned'
      ? 'Collective Organization provisioned.'
      : req.query.witness === 'requested'
      ? 'Witnessing request sent. The operator will review and notify you by email.'
      : null;
    const flashError = (req.query.error as string) || null;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderDashboard({
      keyRow: keyRow as Record<string, unknown>,
      profile,
      justRegisteredKey,
      csrfToken,
      isOperator,
      collectiveOrg,
      publishingOrgCount,
      flashMessage,
      flashError,
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
  // Logo is managed via the dedicated multipart route below
  // (POST /profile/logo); we deliberately don't accept it here so the
  // urlencoded text save can't clobber the uploaded image.
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
      // logo_url intentionally omitted — managed by POST /profile/logo
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
// POST /developers/profile/logo  (upload)
// POST /developers/profile/logo/remove
// =============================================================================
//
// Logo handling lives in its own routes because the upload has to be
// multipart-encoded and the text-only POST /profile stays urlencoded.
// Multer parses the multipart body into req.file (the image) and
// req.body (the CSRF token). The image goes through the same magic-byte
// + Sharp re-encode + R2 upload pipeline as event photos.

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: LOGO_MAX_BYTES,
    files: 1,
  },
});

router.post(
  '/profile/logo',
  writeFormLimiter,
  // Multer runs before requireDeveloperSession so the multipart body is
  // parsed in time for CSRF + handler code to read req.body and req.file.
  logoUpload.single('logo'),
  requireDeveloperSession,
  async (req, res, next) => {
    try {
      if (!validateCsrf(req)) {
        res.redirect(303, '/developers/profile?error=' + encodeURIComponent('Your session expired. Please try again.'));
        return;
      }

      const file = (req as unknown as { file?: { buffer: Buffer; mimetype: string } }).file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        res.redirect(303, '/developers/profile?error=' + encodeURIComponent('Pick a JPEG, PNG, or WebP under 5MB.'));
        return;
      }

      const session = req.developerSession!;
      const profile = await loadProfileForSession(session.api_key_id);
      if (!profile) {
        res.redirect(302, '/developers/dashboard');
        return;
      }

      let uploadResult;
      try {
        uploadResult = await processAndUploadLogo(profile.id as string, file.buffer);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed.';
        res.redirect(303, '/developers/profile?error=' + encodeURIComponent(message));
        return;
      }

      const { error: updErr } = await supabaseAdmin
        .from('contributor_profiles')
        .update({ logo_url: uploadResult.url })
        .eq('id', profile.id as string);

      if (updErr) {
        console.error('[DEV_PORTAL] Logo URL persist failed:', updErr.message);
        res.redirect(303, '/developers/profile?error=' + encodeURIComponent('Saved the upload but could not update the profile. Try again.'));
        return;
      }

      res.redirect(303, '/developers/profile?saved=1');
    } catch (err) {
      next(err);
    }
  },
);

router.post('/profile/logo/remove', writeFormLimiter, requireDeveloperSession, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.redirect(303, '/developers/profile?error=' + encodeURIComponent('Your session expired. Please try again.'));
      return;
    }

    const session = req.developerSession!;
    const profile = await loadProfileForSession(session.api_key_id);
    if (!profile) {
      res.redirect(302, '/developers/dashboard');
      return;
    }

    // Clear the DB pointer first — even if the R2 delete fails, the
    // public-facing profile no longer references the image.
    const { error: updErr } = await supabaseAdmin
      .from('contributor_profiles')
      .update({ logo_url: null })
      .eq('id', profile.id as string);

    if (updErr) {
      console.error('[DEV_PORTAL] Logo URL clear failed:', updErr.message);
      res.redirect(303, '/developers/profile?error=' + encodeURIComponent('Could not remove the logo. Try again.'));
      return;
    }

    // Best-effort R2 cleanup. Failure here just leaves an orphan object.
    await deleteLogo(profile.id as string);

    res.redirect(303, '/developers/profile?saved=1');
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// POST /developers/collective/provision
// POST /developers/collective/request-witnessing
// =============================================================================
//
// PR B — equip every developer with their collective Organization.
// `provision` is a transitional fallback for pre-PR-B approvals (Merrie,
// Neighborhood Commons-the-app) that activated without a collective.
// `request-witnessing` is the self-service ask for witness_authority —
// the operator approves with one click in /operator/applications.

router.post('/collective/provision', writeFormLimiter, requireDeveloperSession, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.redirect(303, '/developers/dashboard?error=' + encodeURIComponent('Your session expired. Please try again.'));
      return;
    }

    const session = req.developerSession!;

    // Resolve the dev's key + the collective name from its app name.
    const { data: keyRow } = await supabaseAdmin
      .from('api_keys')
      .select('id, name, contributor_profile_id')
      .eq('id', session.api_key_id)
      .maybeSingle();
    if (!keyRow) {
      res.redirect(302, '/developers/login');
      return;
    }
    const appName = (keyRow.name as string | null) || 'App';
    const collectiveName = `${appName} Community`;

    // Already have a collective? It's the linked org named "<App> Community" —
    // NOT just "any linked org". A publisher is scoped to many publishing orgs,
    // none of which is its collective; the old "any link" check wrongly treated
    // the first such org as the collective and blocked real provisioning.
    const { data: links } = await supabaseAdmin
      .from('api_key_organization_links')
      .select('organization_id')
      .eq('api_key_id', session.api_key_id);
    const linkedOrgIds = (links || []).map((l) => l.organization_id as string);
    if (linkedOrgIds.length > 0) {
      const { data: linkedOrgs } = await supabaseAdmin
        .from('organizations')
        .select('id, name')
        .in('id', linkedOrgIds);
      if ((linkedOrgs || []).some((o) => (o.name as string) === collectiveName)) {
        res.redirect(303, '/developers/dashboard');
        return;
      }
    }

    const baseCollectiveSlug = deriveCollectiveSlug(collectiveName);

    // Resolve a unique slug — fall back to appending random suffixes on
    // collision so the dashboard-triggered provisioning doesn't hard-fail.
    const slug = await deriveUniqueCollectiveSlug(baseCollectiveSlug);

    const { data: org, error: orgErr } = await supabaseAdmin
      .from('organizations')
      .insert({
        slug,
        name: collectiveName,
        // The collective is contributed by this developer's app — attribute it
        // to their registered profile (migration 090), same axis as events.
        contributor_profile_id: (keyRow.contributor_profile_id as string | null) ?? null,
        method: 'self_asserted',
      })
      .select('id')
      .single();

    if (orgErr || !org) {
      console.error('[DEV_PORTAL] Collective provision failed:', orgErr?.message);
      res.redirect(303, '/developers/dashboard?error=' + encodeURIComponent('Could not provision your collective. Try again.'));
      return;
    }

    const { error: linkErr } = await supabaseAdmin
      .from('api_key_organization_links')
      .insert({ api_key_id: session.api_key_id, organization_id: org.id });

    if (linkErr) {
      await supabaseAdmin.from('organizations').delete().eq('id', org.id);
      console.error('[DEV_PORTAL] Collective link failed:', linkErr.message);
      res.redirect(303, '/developers/dashboard?error=' + encodeURIComponent('Could not link the collective. Try again.'));
      return;
    }

    res.redirect(303, '/developers/dashboard?collective=provisioned');
  } catch (err) {
    next(err);
  }
});

router.post('/collective/request-witnessing', writeFormLimiter, requireDeveloperSession, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.redirect(303, '/developers/dashboard?error=' + encodeURIComponent('Your session expired. Please try again.'));
      return;
    }

    const session = req.developerSession!;

    const { data: keyRow } = await supabaseAdmin
      .from('api_keys')
      .select('id, name, contact_email, witness_authority, witness_authority_requested_at')
      .eq('id', session.api_key_id)
      .maybeSingle();

    if (!keyRow) {
      res.redirect(302, '/developers/login');
      return;
    }

    if (keyRow.witness_authority === true) {
      res.redirect(303, '/developers/dashboard');
      return;
    }

    // Idempotent — re-requesting just refreshes the timestamp.
    const { error: updErr } = await supabaseAdmin
      .from('api_keys')
      .update({ witness_authority_requested_at: new Date().toISOString() })
      .eq('id', session.api_key_id);

    if (updErr) {
      console.error('[DEV_PORTAL] Witness request failed:', updErr.message);
      res.redirect(303, '/developers/dashboard?error=' + encodeURIComponent('Could not file your request. Try again.'));
      return;
    }

    // Best-effort operator notification — fire-and-forget.
    void notifyOperatorWitnessRequest({
      appName: (keyRow.name as string | null) || 'an app',
      contactEmail: (keyRow.contact_email as string),
      apiKeyId: session.api_key_id,
    });

    res.redirect(303, '/developers/dashboard?witness=requested');
  } catch (err) {
    next(err);
  }
});

/**
 * Derive a slug for a collective Organization. Same character class as
 * the profile slug helper but kept local so the developer-portal module
 * doesn't reach into the service-routes namespace.
 */
function deriveCollectiveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‘’‛']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

/** Tries the base slug first; on collision appends -2, -3, ... up to 5 tries. */
async function deriveUniqueCollectiveSlug(base: string): Promise<string> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const { data: hit } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('slug', candidate)
      .maybeSingle();
    if (!hit) return candidate;
  }
  // Last-ditch: append a random suffix.
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Send a heads-up email to the operator about a witness-authority request. */
async function notifyOperatorWitnessRequest(args: { appName: string; contactEmail: string; apiKeyId: string }): Promise<void> {
  const operatorEmail = config.operator.email;
  if (!operatorEmail) {
    console.warn('[DEV_PORTAL] Witness request from', args.appName, '— no COMMONS_OPERATOR_EMAIL configured, skipping notification');
    return;
  }
  const baseUrl = config.apiBaseUrl || 'https://neighborhood-commons.org';
  const reviewUrl = `${baseUrl.replace(/\/$/, '')}/operator/applications/${encodeURIComponent(args.apiKeyId)}`;
  const listUrl = `${baseUrl.replace(/\/$/, '')}/operator/applications`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px; color: #37352f; line-height: 1.6;">
      <div style="font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: #7a7670; margin-bottom: 24px;">
        Neighborhood Commons · Operator
      </div>
      <div style="font-size: 18px; color: #1a1917; font-weight: 600; margin-bottom: 16px;">
        Witnessing request from ${escapeHtml(args.appName)}
      </div>
      <p style="margin: 0 0 16px;">
        <strong>${escapeHtml(args.appName)}</strong> (<code>${escapeHtml(args.contactEmail)}</code>) is asking for the <code>witness_authority</code> capability.
        It also now shows up under "Witness-authority requests" on the pending list.
      </p>
      <div style="margin: 24px 0;">
        <a href="${reviewUrl}" style="display: inline-block; padding: 12px 20px; background: #2b4d2b; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
          Review and grant →
        </a>
        <a href="${listUrl}" style="display: inline-block; padding: 12px 20px; color: #37352f; background: transparent; border: 1px solid #c8c4be; text-decoration: none; border-radius: 6px; font-weight: 500; margin-left: 8px;">
          See all pending
        </a>
      </div>
      <p style="font-size: 13px; color: #6b6660; margin: 0;">
        Granting flips <code>api_keys.witness_authority</code> to true for this key, links it to the collective Organization (if not already), and emails the developer with a usage example.
      </p>
    </div>
  `;
  try {
    const { sendEmail } = await import('../lib/email.js');
    await sendEmail(operatorEmail, `[Commons] Witnessing request: ${args.appName}`, html);
  } catch (err) {
    console.error('[DEV_PORTAL] Operator notification email failed:', err instanceof Error ? err.message : err);
  }
}

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
// GET  /developers/security/refresh-key  — confirm page
// POST /developers/security/refresh-key  — rotate the key in place
// =============================================================================
//
// Self-service API-key rotation. In-place: a new raw key replaces key_hash +
// key_prefix on the SAME api_keys row, so the contributor profile, MFA
// enrollment, org links, and the active dashboard session (which authenticates
// by cookie, not by the API key) all survive untouched — only the credential
// changes. The old key dies the instant the new hash is written; there is no
// overlap window. That's the right shape for a leaked or lost key — a live
// consumer must redeploy with the new key promptly.
//
// Gated by requireStepUp: a fresh MFA check, so a hijacked dashboard session
// can't silently rotate the key out from under the owner. The GET is what
// step-up returns to (a GET target, cleanly); the POST re-checks for defense
// in depth.

router.get('/security/refresh-key', renderLimiter, requireStepUp, async (req, res, next) => {
  try {
    const csrfToken = issueCsrfCookie(res);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(portalShell({
      title: 'Refresh API key',
      body: renderRefreshKeyConfirm({ csrfToken, error: (req.query.error as string) || null }),
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/security/refresh-key', writeFormLimiter, requireStepUp, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.status(403).send('CSRF check failed.');
      return;
    }

    const session = req.developerSession!;

    // New raw key + hash. The raw key is shown ONCE on the result page and
    // never stored — only its hash is persisted. Same shape as issuance.
    const { randomBytes, createHash } = await import('crypto');
    const rawKey = 'nc_' + randomBytes(16).toString('hex');
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.substring(0, 12);

    const { error: updateErr } = await supabaseAdmin
      .from('api_keys')
      .update({ key_hash: keyHash, key_prefix: keyPrefix })
      .eq('id', session.api_key_id);

    if (updateErr) {
      console.error('[DEV_PORTAL] Key refresh failed:', updateErr.message);
      res.redirect(303, '/developers/security/refresh-key?error=' +
        encodeURIComponent('Could not refresh your key. Try again.'));
      return;
    }

    // Audit trail — the key id, never the key itself.
    console.log(`[DEV_PORTAL] API key ${session.api_key_id} rotated in place`);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(portalShell({
      title: 'API key refreshed',
      body: renderRefreshKeyResult({ rawKey }),
    }));
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
  const logoUrl = profile.logo_url as string | null;

  const logoCard = `
    <div class="nc-card">
      <div class="nc-card-label">Logo</div>
      ${logoUrl
        ? `<div style="display:flex; align-items:center; gap:18px; margin-bottom:14px;">
             <img src="${escapeAttr(logoUrl)}" alt="${escapeAttr((profile.name as string) || 'Logo')}" style="width:80px; height:80px; border-radius:8px; object-fit:cover; background:#f1efea; border:1px solid var(--border);">
             <div style="font-size:13px; color:var(--muted);">
               Currently set. Upload a new file below to replace it, or use the remove button.
             </div>
           </div>
           <form method="POST" action="/developers/profile/logo/remove" style="display:inline; margin-bottom:14px;">
             ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
             <button type="submit" class="nc-btn nc-btn--secondary" style="margin-bottom:14px;">Remove logo</button>
           </form>`
        : `<div style="font-size:13px; color:var(--muted); margin-bottom:12px;">
             No logo yet. JPEG, PNG, or WebP under 5MB. Square images render best — they get resized to 400px max.
           </div>`}
      <form method="POST" action="/developers/profile/logo" enctype="multipart/form-data" novalidate>
        ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
        <div class="nc-field" style="margin-bottom:8px;">
          <label for="logo" style="display:block; font-size:13px; font-weight:600; color:var(--ink-2); margin-bottom:6px;">Choose a file</label>
          <input id="logo" name="logo" type="file" accept="image/jpeg,image/png,image/webp" required>
        </div>
        <button type="submit" class="nc-btn">${logoUrl ? 'Replace logo' : 'Upload logo'}</button>
      </form>
    </div>
  `;

  const body = `
    <h1>Edit profile.</h1>
    <p class="nc-portal-lede">
      This is what readers see when they tap "via ${escapeHtml((profile.name as string) || 'your app')}" in a consumer app.
      Slug <code>${escapeHtml(profile.slug as string)}</code> ·
      <span class="nc-status ${statusClass}">${status}</span>
    </p>
    ${saved ? calloutBanner('Saved.') : ''}
    ${errorBanner(error)}
    ${logoCard}
    <form method="POST" action="/developers/profile" novalidate>
      ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
      ${textField('name', 'App name', { required: true, value: profile.name, hint: 'Display name. Shown verbatim in splash cards.' })}
      ${textField('tagline', 'Tagline', { required: true, maxlength: 120, value: profile.tagline, hint: 'One-liner. Up to ~80 chars renders well in splash cards.' })}
      ${textareaField('description', 'Description', { required: true, value: profile.description, hint: '~2000 chars. Plain text for now.' })}
      ${textField('app_url', 'App URL', { type: 'url', required: true, value: profile.app_url })}
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

function renderRefreshKeyConfirm(args: { csrfToken: string; error: string | null }): string {
  const { csrfToken, error } = args;
  return `
    <h1>Refresh API key</h1>
    <p class="nc-portal-lede">Generate a new service key. This <strong>immediately invalidates your current key</strong> — anything calling the API with it gets <code>401</code> until you deploy the new one. Your profile, MFA, and publishing scope are unaffected.</p>
    ${errorBanner(error)}
    <div class="nc-card">
      <div class="nc-card-label">Before you continue</div>
      <ul style="margin:6px 0 0 18px; padding:0; line-height:1.7;">
        <li>The new key is shown <strong>once</strong> on the next screen — copy it immediately.</li>
        <li>Update the <code>X-API-Key</code> header wherever your app runs.</li>
        <li>Refresh if your key may be exposed, or as routine rotation.</li>
      </ul>
    </div>
    <form method="POST" action="/developers/security/refresh-key">
      ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
      <button type="submit" class="nc-btn">Refresh key</button>
      <a href="/developers/dashboard" class="nc-btn nc-btn--secondary" style="margin-left:8px;">Cancel</a>
    </form>
  `;
}

function renderRefreshKeyResult(args: { rawKey: string }): string {
  return `
    <h1>Your new API key</h1>
    ${calloutBanner('Key refreshed — your previous key no longer works. Copy this now; it will not be shown again.')}
    <div class="nc-card">
      <div class="nc-card-label">New service key (copy now)</div>
      <div class="nc-key">${escapeHtml(args.rawKey)}</div>
      <div style="margin-top:10px; font-size:13px; color:var(--muted);">
        Pass via the <code>X-API-Key</code> header. Update every running deployment now — the old key returns <code>401</code>.
      </div>
    </div>
    <a href="/developers/dashboard" class="nc-btn">Back to dashboard</a>
  `;
}

function renderDashboard(args: {
  keyRow: Record<string, unknown>;
  profile: Record<string, unknown> | null;
  justRegisteredKey: string | null;
  csrfToken: string;
  isOperator: boolean;
  collectiveOrg: { id: string; name: string; slug: string } | null;
  publishingOrgCount: number;
  flashMessage: string | null;
  flashError: string | null;
}): string {
  const { keyRow, profile, justRegisteredKey, csrfToken, isOperator, collectiveOrg, publishingOrgCount, flashMessage, flashError } = args;
  const status = (keyRow.activated_at ? 'active' : 'pending') as 'active' | 'pending';
  const keyPrefix = (keyRow.key_prefix as string) || '';
  const mfaEnrolled = !!keyRow.mfa_enrolled_at;
  const witnessAuthority = keyRow.witness_authority === true;
  const witnessRequested = !!keyRow.witness_authority_requested_at;

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

  // Publishing Modes panel — the educational + actionable surface for the
  // three authority paths. Renders only once the key is active (pending
  // keys have nothing to publish yet).
  const publishingModesCard = status === 'active' ? renderPublishingModes({
    collectiveOrg,
    publishingOrgCount,
    witnessAuthority,
    witnessRequested,
    csrfToken,
  }) : '';

  // MFA lives in the Credentials & security section (was a line item in
  // "What's next"). Grouping it with the key gives security a single home
  // that future controls (sessions, additional keys, scopes) slot into.
  const securityMfaCard = `
    <div class="nc-card">
      <div class="nc-card-label">Multi-factor authentication</div>
      ${mfaEnrolled
        ? '<div style="font-size:14px; color:var(--ink-2);">MFA is <strong>on</strong> for this account.</div>'
        : `<div style="font-size:14px; color:var(--ink-2);">MFA is <strong>off</strong>. Enable it to harden your account and unlock sensitive actions like refreshing your key.</div>
           <div style="margin-top:12px;"><a href="/developers/security/enroll-mfa" class="nc-btn nc-btn--secondary">Enable MFA</a></div>`}
    </div>`;

  const body = `
    <h1>Dashboard</h1>
    <p class="nc-portal-lede">
      ${escapeHtml((keyRow.name as string) || 'Your app')} ·
      <span class="nc-status ${statusClass}">${status}</span>
    </p>
    ${flashMessage ? calloutBanner(flashMessage) : ''}
    ${errorBanner(flashError)}
    ${justRegisteredCallout}

    <h2>Credentials &amp; security</h2>
    <div class="nc-card">
      <div class="nc-card-label">Service key</div>
      <div style="font-family:var(--font-mono); font-size:13px; color:var(--ink);">${escapeHtml(keyPrefix)}…</div>
      <div style="margin-top:10px; font-size:13px; color:var(--muted);">
        ${status === 'pending'
          ? 'Status: <strong>pending</strong>. Reads work immediately; writes return <code>403 KEY_PENDING</code> until an operator activates your key.'
          : 'Status: <strong>active</strong>. Reads and writes are live.'}
      </div>
      <div style="margin-top:14px;">
        <a href="/developers/security/refresh-key" class="nc-btn nc-btn--secondary">Refresh key</a>
      </div>
    </div>
    ${securityMfaCard}

    ${publishingModesCard}
    ${profileCard}
    <div class="nc-card">
      <div class="nc-card-label">What's next</div>
      <ul style="margin:6px 0 0 18px; padding:0; line-height:1.7;">
        <li>${status === 'pending'
          ? 'Activation email arrives when the operator reviews your application.'
          : 'Your key is active. Build away.'}</li>
        ${isOperator
          ? `<li>You're an operator — review pending applications at <a href="/operator/applications">/operator/applications</a>.</li>`
          : ''}
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

/**
 * Render the Publishing Modes card — the educational + actionable
 * surface for the three authority paths (per docs/four-roles.md).
 * Equips every developer with their collective UUID + a clear path to
 * enable witnessing if they want it.
 */
function renderPublishingModes(args: {
  collectiveOrg: { id: string; name: string; slug: string } | null;
  publishingOrgCount: number;
  witnessAuthority: boolean;
  witnessRequested: boolean;
  csrfToken: string;
}): string {
  const { collectiveOrg, publishingOrgCount, witnessAuthority, witnessRequested, csrfToken } = args;

  const collectiveBlock = collectiveOrg
    ? `
      <div style="margin-top:8px; padding:10px 12px; background:#f1efea; border-radius:4px; font-size:13px;">
        <div style="font-weight:600; color:var(--ink); margin-bottom:4px;">Your collective: ${escapeHtml(collectiveOrg.name)}</div>
        <div style="font-family:var(--font-mono); word-break:break-all;">${escapeHtml(collectiveOrg.id)}</div>
        <div style="margin-top:4px; color:var(--muted);">
          Slug <code>${escapeHtml(collectiveOrg.slug)}</code>
        </div>
      </div>
    `
    : `
      <div style="margin-top:8px; padding:10px 12px; background:#f1efea; border-radius:4px; font-size:13px;">
        ${publishingOrgCount > 0
          ? `<div style="font-weight:600; color:var(--ink); margin-bottom:4px;">Publishing for ${publishingOrgCount} organization${publishingOrgCount === 1 ? '' : 's'}</div>
             <div style="color:var(--muted);">The organizations your key is scoped to write to — you publish on their behalf. These aren't a single collective.</div>`
          : `<div style="color:var(--muted);">No organizations linked yet. As your key creates or links organizations, they'll appear here.</div>`}
        <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border); color:var(--muted);">
          Doing the <strong>witnessed</strong> path (your users surface public-fact evidence)? Those events publish under one collective identity —
          <form method="POST" action="/developers/collective/provision" style="display:inline; margin-left:4px;">
            ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
            <button type="submit" class="nc-btn nc-btn--secondary" style="padding:4px 10px; font-size:13px;">Provision a collective</button>
          </form>
        </div>
      </div>
    `;

  const witnessRow = !collectiveOrg
    ? `<li><strong>Witnessed</strong> — your users surface evidence (photos, OCR) of public-fact events; events attribute to your collective, never to individuals.
        <div style="font-size:13px; color:var(--muted); margin-top:4px;">Provision your collective above before requesting this capability.</div></li>`
    : witnessAuthority
    ? `<li><strong>Witnessed</strong> ✓ enabled — your users surface evidence of public-fact events. Set <code>source.method: "witnessed"</code> and use your collective UUID as <code>organizer_org_id</code>.</li>`
    : witnessRequested
    ? `<li><strong>Witnessed</strong> — requested. The operator will review and notify you by email.</li>`
    : `<li><strong>Witnessed</strong> — your users surface evidence (photos, OCR) of public-fact events; events attribute to your collective. Requires a one-time operator approval.
        <form method="POST" action="/developers/collective/request-witnessing" style="display:inline; margin-left:6px;">
          ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
          <button type="submit" class="nc-btn nc-btn--secondary" style="padding:4px 10px; font-size:13px;">Request capability</button>
        </form>
      </li>`;

  return `
    <div class="nc-card">
      <div class="nc-card-label">Publishing modes</div>
      <p style="margin:6px 0 12px; font-size:14px; color:var(--ink-2);">
        Three ways your app can route content into the Commons. See <a href="/docs/four-roles" target="_blank" rel="noopener">four-roles</a> for the doctrine.
      </p>
      <ul style="margin:0 0 12px 18px; padding:0; line-height:1.7;">
        <li><strong>First-party</strong> ✓ enabled — your verified organizations publish about themselves (their own events, hours, broadcasts). Set <code>source.method: "self_asserted"</code>.</li>
        <li><strong>Proxied</strong> ✓ enabled — you pull from public feeds / scrape public calendar pages. Set <code>source.method: "proxied"</code> and put the source URL in <code>source_feed_url</code>.</li>
        ${witnessRow}
      </ul>
      ${collectiveBlock}
    </div>
  `;
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
