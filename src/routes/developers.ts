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
// HTML RENDERING
// =============================================================================

function renderSignUp(csrfToken: string, error: string | null, prefill: Record<string, unknown>): string {
  const body = `
    <h1>Build on the Neighborhood Commons.</h1>
    <p class="nc-portal-lede">
      Tell us about your app. We'll send you a verification code, issue your service key,
      and route an operator review. Most reviews take less than a day; reads work
      immediately, writes activate when we approve.
    </p>
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
      ${textareaField('what_youre_building', "What you're building", { required: true, value: prefill.what_youre_building, hint: "For operator review. The kind of thing you'd say if asked at a party." })}
      ${textareaField('verification_process', 'Verification process', { required: true, value: prefill.verification_process, hint: "For operator review. How do you verify the entities you'll publish for?" })}
      <button type="submit" class="nc-btn">Send verification code</button>
    </form>
    <div class="nc-portal-footer-aux" style="margin-top:32px; font-size:13px; color:var(--muted);">
      Already registered? Your key works as before — sign-in via magic link ships in the next release.
    </div>
  `;
  return portalShell({ title: 'Sign up', body });
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
        <li>Profile editing, logo upload, and MFA enrollment ship in the next release.</li>
        <li>For now, start building against the API. Reads are free and live.</li>
        <li>Activation email arrives when the operator reviews your application.</li>
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

export default router;
