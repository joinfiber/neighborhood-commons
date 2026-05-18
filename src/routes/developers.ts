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
      ${textareaField('what_youre_building', "What you're building", { required: true, value: prefill.what_youre_building, hint: `A paragraph is plenty. Name the data shape (events, hours, schedules, broadcasts) and the entities involved. The three example shapes above are all green-lit; saying "I'm collecting public yoga-class schedules across Philly" is perfect.` })}
      ${textareaField('verification_process', 'Verification process', { required: true, value: prefill.verification_process, hint: `How do you confirm the publisher of your content has authority over what they're publishing? For proxied public info, naming your sources is plenty ("I scrape venue calendar pages, then de-dupe"). For first-party, describe the publisher's journey ("teachers create an account and add their own classes"). For witnessed, describe the evidence ("users upload a photo of the flyer with each submission").` })}
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

export default router;
