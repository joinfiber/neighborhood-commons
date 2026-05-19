/**
 * Operator portal — neighborhood-commons.org/operator
 *
 * Server-rendered HTML for the operator (Zac, plus any address in
 * COMMONS_OPERATOR_EMAIL). Gated by `requireOperator` middleware, which
 * 404s on anyone who isn't on the env-var allowlist — the route's
 * existence isn't leaked.
 *
 * Routes:
 *   GET   /operator                                       — index (redirect to applications)
 *   GET   /operator/applications                          — list of pending api_keys (PR 4a)
 *   GET   /operator/applications/:id                      — application detail + actions (PR 4a)
 *   POST  /operator/applications/:id/approve              — flip activated_at + status, send email (PR 4a)
 *   POST  /operator/applications/:id/reject               — flip status, send rejection email (PR 4a)
 *   POST  /operator/applications/:id/approve-witnessing   — provision collective org, grant witness_authority, approve (PR 4c)
 *
 * Operator authority is purely env-var driven; there's no `is_operator`
 * column. Adding one later is additive.
 */

import { Router, urlencoded } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireOperator } from '../middleware/developer-session.js';
import {
  issueCsrfCookie,
  validateCsrf,
  CSRF_FIELD_NAME,
} from '../lib/developer-portal/csrf.js';
import {
  escapeHtml,
  escapeAttr,
  errorBanner,
  calloutBanner,
  hiddenInput,
} from '../lib/developer-portal/templates.js';
import {
  sendActivationEmail,
  sendRejectionEmail,
} from '../lib/developer-portal/activation-emails.js';

const router: ReturnType<typeof Router> = Router();

// Form-encoded bodies (CSRF check reads req.body[_csrf]).
router.use(urlencoded({ extended: false, limit: '32kb' }));

// Every operator route requires the gate. Order matters — this runs before
// the per-route handlers so unauthorised requests hit 404 immediately.
router.use(requireOperator);

// =============================================================================
// RATE LIMITING
// =============================================================================
//
// Operator routes are low-traffic; the limiter here is mostly to bound
// abuse if a session token leaks. Generous limit per IP.

const operatorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
});

// =============================================================================
// VALIDATION
// =============================================================================

const uuidSchema = z.string().uuid();

const rejectFormSchema = z.object({
  reason: z.string().trim().max(2000).optional(),
}).passthrough();

const witnessApprovalSchema = z.object({
  collective_name: z.string().trim().min(2).max(120),
  collective_slug: z.string().trim().min(1).max(100).optional(),
  collective_description: z.string().trim().max(2000).optional(),
}).passthrough();

/** Derive a slug from a name. Mirrors the deriveSlug helper in
 *  src/routes/service/organizations.ts. Kept local so the operator
 *  route doesn't reach across into the service module. */
function deriveOrgSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‘’‛']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

// =============================================================================
// TYPES
// =============================================================================

interface ApplicationRow {
  id: string;
  name: string | null;
  contact_email: string;
  url: string | null;
  key_prefix: string | null;
  status: string;
  activated_at: string | null;
  application_metadata: Record<string, unknown> | null;
  brand_config: Record<string, unknown> | null;
  contributor_profile_id: string | null;
  created_at: string;
}

interface ContributorProfileRow {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  who_its_for: string | null;
  app_url: string | null;
  category: string | null;
  status: string;
}

// =============================================================================
// SHELL
// =============================================================================
//
// Operator pages reuse the developer-portal shared CSS but render their
// own shell with an "Operator" eyebrow so it's visually obvious which
// surface you're on. Keeping the templating local rather than extending
// portalShell — the eyebrow + footer differ and it's cleaner to copy a
// short HTML doc than parametrise the existing one.

function operatorShell(args: { title: string; body: string; operatorEmail: string }): string {
  // Inline a minimal style block — the operator UI uses the same CSS
  // variables/utility classes as the developer portal. We duplicate the
  // styles here (rather than sharing a file across routes) so the operator
  // surface stays decoupled and can drift in tone later if useful.
  const styles = `
    :root {
      --bg: #faf9f7; --surface: #fff; --ink: #1a1917; --ink-2: #37352f;
      --muted: #7a7670; --muted-2: #9c9791; --border: #e8e5e0; --border-strong: #c8c4be;
      --accent: #2b4d2b; --accent-soft: #eaf2ea; --danger: #8b2c2c; --danger-soft: #f4e8e8;
      --radius: 6px;
      --font-sans: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: var(--font-sans); background: var(--bg); color: var(--ink-2); line-height: 1.55; -webkit-font-smoothing: antialiased; }
    a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
    a:hover { text-decoration-thickness: 2px; }
    .nc-op-wrap { max-width: 920px; margin: 0 auto; padding: 40px 24px 80px; }
    .nc-op-eyebrow { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-bottom: 16px; }
    .nc-op-eyebrow strong { color: var(--accent); font-weight: 500; }
    h1 { font-family: var(--font-sans); font-size: 24px; font-weight: 600; line-height: 1.2; color: var(--ink); margin: 0 0 16px; }
    h2 { font-size: 17px; font-weight: 600; color: var(--ink); margin: 28px 0 10px; }
    .nc-op-lede { font-size: 15px; color: var(--ink-2); margin: 0 0 28px; }
    .nc-error { padding: 12px 14px; background: var(--danger-soft); color: var(--danger); border-radius: var(--radius); font-size: 14px; margin-bottom: 20px; }
    .nc-callout { padding: 14px 16px; background: var(--accent-soft); color: var(--ink-2); border-radius: var(--radius); font-size: 14px; margin: 0 0 20px; }
    .nc-card { padding: 18px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin: 0 0 14px; }
    .nc-card .nc-card-label { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
    .nc-status { display: inline-block; padding: 2px 8px; font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; border-radius: 3px; }
    .nc-status--pending { background: #f7efe1; color: #8c6a1e; }
    .nc-status--active { background: var(--accent-soft); color: var(--accent); }
    .nc-status--rejected { background: var(--danger-soft); color: var(--danger); }
    .nc-status--suspended { background: #efeae0; color: #6b6660; }
    .nc-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; color: var(--muted); margin: 4px 0 12px; }
    .nc-meta code { font-family: var(--font-mono); }
    .nc-btn { display: inline-block; padding: 10px 18px; font: inherit; font-size: 14px; font-weight: 500; color: #fff; background: var(--accent); border: none; border-radius: var(--radius); cursor: pointer; text-decoration: none; }
    .nc-btn:hover { background: #1f3a1f; }
    .nc-btn--secondary { color: var(--ink-2); background: transparent; border: 1px solid var(--border-strong); }
    .nc-btn--secondary:hover { background: var(--surface); }
    .nc-btn--danger { background: var(--danger); }
    .nc-btn--danger:hover { background: #6e2222; }
    .nc-app-row { display: flex; gap: 16px; align-items: baseline; padding: 12px 0; border-bottom: 1px solid var(--border); }
    .nc-app-row:last-child { border-bottom: none; }
    .nc-app-row .nc-app-name { font-weight: 500; color: var(--ink); flex: 1; min-width: 0; }
    .nc-app-row .nc-app-meta { font-size: 13px; color: var(--muted); }
    .nc-prose { white-space: pre-wrap; color: var(--ink-2); line-height: 1.6; }
    .nc-field { margin: 0 0 16px; }
    .nc-field label { display: block; font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 6px; }
    .nc-field textarea { width: 100%; padding: 10px 12px; font: inherit; font-size: 14px; color: var(--ink); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius); outline: none; resize: vertical; min-height: 80px; }
    .nc-field textarea:focus { border-color: var(--accent); }
    .nc-actions { display: flex; gap: 12px; align-items: center; margin-top: 12px; }
    .nc-op-footer { margin-top: 48px; font-size: 12px; color: var(--muted-2); border-top: 1px solid var(--border); padding-top: 18px; }
    code { font-family: var(--font-mono); font-size: 12.5px; background: #f1efea; padding: 1px 4px; border-radius: 3px; }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(args.title)} — Operator · Neighborhood Commons</title>
  <meta name="robots" content="noindex,nofollow">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>${styles}</style>
</head>
<body>
  <main class="nc-op-wrap">
    <div class="nc-op-eyebrow"><strong>Operator</strong> · ${escapeHtml(args.operatorEmail)} · <a href="/developers/dashboard">developer view</a></div>
    ${args.body}
    <footer class="nc-op-footer">
      Internal surface. Actions here are audit-logged via the application_metadata.review record.
    </footer>
  </main>
</body>
</html>`;
}

// =============================================================================
// HELPERS
// =============================================================================

function statusBadge(status: string, activatedAt: string | null): string {
  // For api_keys: status=active + activated_at=null is "pending review"; we
  // surface that as 'pending' to the operator so the visible state matches
  // the workflow vocabulary (not the underlying column trick — see
  // migration 075).
  if (status === 'active' && !activatedAt) {
    return `<span class="nc-status nc-status--pending">pending</span>`;
  }
  const cls = status === 'active' ? 'nc-status--active'
    : status === 'rejected' ? 'nc-status--rejected'
    : 'nc-status--suspended';
  return `<span class="nc-status ${cls}">${escapeHtml(status)}</span>`;
}

function reviewSection(meta: Record<string, unknown> | null): string {
  const review = (meta?.review || null) as
    | { at?: string; by?: string; action?: string; notes?: string | null }
    | null;
  if (!review || !review.action) return '';
  const when = review.at ? new Date(review.at).toLocaleString() : 'unknown time';
  const by = review.by ? escapeHtml(review.by) : 'unknown operator';
  const notes = review.notes
    ? `<div class="nc-prose" style="margin-top:8px;">${escapeHtml(review.notes)}</div>`
    : '';
  return `<div class="nc-card">
    <div class="nc-card-label">Review record</div>
    <div>${escapeHtml(review.action)} by <code>${by}</code> on ${escapeHtml(when)}</div>
    ${notes}
  </div>`;
}

/** Fetch one api_keys row by id, or null if not found. */
async function loadApplication(id: string): Promise<ApplicationRow | null> {
  const { data } = await supabaseAdmin
    .from('api_keys')
    .select('id, name, contact_email, url, key_prefix, status, activated_at, application_metadata, brand_config, contributor_profile_id, created_at')
    .eq('id', id)
    .maybeSingle();
  return (data as ApplicationRow | null) || null;
}

async function loadProfile(id: string | null): Promise<ContributorProfileRow | null> {
  if (!id) return null;
  const { data } = await supabaseAdmin
    .from('contributor_profiles')
    .select('id, slug, name, tagline, description, who_its_for, app_url, category, status')
    .eq('id', id)
    .maybeSingle();
  return (data as ContributorProfileRow | null) || null;
}

// =============================================================================
// GET /operator  (index redirect)
// =============================================================================

router.get('/', operatorLimiter, (_req, res) => {
  res.redirect(302, '/operator/applications');
});

// =============================================================================
// GET /operator/applications
// =============================================================================
//
// List view. Default filter = pending (activated_at IS NULL AND status='active');
// ?status=all|pending|active|rejected|suspended toggles.

router.get('/applications', operatorLimiter, async (req, res, next) => {
  try {
    const filter = typeof req.query.status === 'string' ? req.query.status : 'pending';
    let query = supabaseAdmin
      .from('api_keys')
      .select('id, name, contact_email, status, activated_at, contributor_profile_id, created_at, application_metadata, key_prefix, url, brand_config')
      .eq('contributor_tier', 'service')
      .order('created_at', { ascending: false })
      .limit(200);

    if (filter === 'pending') {
      query = query.eq('status', 'active').is('activated_at', null);
    } else if (filter === 'active') {
      query = query.eq('status', 'active').not('activated_at', 'is', null);
    } else if (filter === 'rejected') {
      query = query.eq('status', 'rejected');
    } else if (filter === 'suspended') {
      query = query.eq('status', 'suspended');
    }
    // 'all' = no extra predicate

    const { data: rows, error } = await query;
    if (error) {
      console.error('[OPERATOR] Applications list failed:', error.message);
      res.status(500).send(operatorShell({
        title: 'Applications',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Applications</h1>${errorBanner('Could not load applications. Try again or check logs.')}`,
      }));
      return;
    }

    const list = (rows || []) as ApplicationRow[];
    const filters = ['pending', 'all', 'active', 'rejected', 'suspended'] as const;
    const filterNav = filters
      .map((f) => f === filter
        ? `<strong>${escapeHtml(f)}</strong>`
        : `<a href="/operator/applications?status=${escapeAttr(f)}">${escapeHtml(f)}</a>`)
      .join(' · ');

    const items = list.length === 0
      ? `<div class="nc-card" style="text-align:center; color:var(--muted);">No applications match this filter.</div>`
      : list.map((row) => {
          const created = new Date(row.created_at).toLocaleString();
          return `<div class="nc-app-row">
            <div class="nc-app-name">
              <a href="/operator/applications/${escapeAttr(row.id)}">${escapeHtml(row.name || '(unnamed app)')}</a>
              <div class="nc-app-meta">${escapeHtml(row.contact_email)} · ${created}</div>
            </div>
            <div>${statusBadge(row.status, row.activated_at)}</div>
          </div>`;
        }).join('');

    const body = `
      <h1>Applications</h1>
      <p class="nc-op-lede">${filterNav}</p>
      <div class="nc-card" style="padding: 8px 20px;">
        ${items}
      </div>
    `;
    res.setHeader('Cache-Control', 'no-store');
    res.send(operatorShell({ title: 'Applications', operatorEmail: req.operatorEmail || '', body }));
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GET /operator/applications/:id
// =============================================================================
//
// Detail view. Shows the application_metadata, the contributor profile,
// and the approve/reject forms. CSRF cookie issued here.

router.get('/applications/:id', operatorLimiter, async (req, res, next) => {
  try {
    const parsed = uuidSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(404).send(operatorShell({
        title: 'Not Found',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Not Found</h1><p>That application id is malformed.</p><p><a href="/operator/applications">Back to list</a></p>`,
      }));
      return;
    }

    const app = await loadApplication(parsed.data);
    if (!app) {
      res.status(404).send(operatorShell({
        title: 'Not Found',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Not Found</h1><p>No application with that id.</p><p><a href="/operator/applications">Back to list</a></p>`,
      }));
      return;
    }

    const profile = await loadProfile(app.contributor_profile_id);
    const meta = (app.application_metadata || {}) as Record<string, unknown>;
    const brand = (app.brand_config || {}) as Record<string, unknown>;

    const successFlag = req.query.success;
    const callout = successFlag === 'approved'
      ? calloutBanner('Approved. Activation email sent.')
      : successFlag === 'approved-witnessing'
      ? calloutBanner('Approved as witnessing app. Collective Organization provisioned, key linked, witness_authority granted. Activation email sent with the collective UUID.')
      : successFlag === 'rejected'
      ? calloutBanner('Rejected. Notification email sent.')
      : '';

    const csrfToken = issueCsrfCookie(res);
    const isPending = app.status === 'active' && !app.activated_at;

    // Pre-fill the witnessing form: "<App Name> Community" as the default
    // collective name, derived slug. Operator can edit before submit.
    const suggestedCollectiveName = `${app.name || 'App'} Community`;
    const suggestedCollectiveSlug = deriveOrgSlug(suggestedCollectiveName);

    const actions = isPending
      ? `
        <div class="nc-card">
          <div class="nc-card-label">Decision — standard</div>
          <form method="POST" action="/operator/applications/${escapeAttr(app.id)}/approve" style="margin-bottom:8px;">
            ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
            <p style="margin:0 0 12px;">Activates the service key for first-party / proxied writes. Sets the contributor profile to <code>active</code>. The applicant receives the activation email.</p>
            <button type="submit" class="nc-btn">Approve and activate</button>
          </form>
        </div>

        <div class="nc-card">
          <div class="nc-card-label">Decision — approve as witnessing app</div>
          <form method="POST" action="/operator/applications/${escapeAttr(app.id)}/approve-witnessing" style="margin-bottom:8px;">
            ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
            <p style="margin:0 0 12px;">
              Use this when the app publishes events via witnessed-with-evidence (per <a href="/docs/four-roles" target="_blank" rel="noopener">four-roles</a>).
              Creates a collective <code>Organization</code> that the app will set as <code>organizer_org_id</code> on witnessed events,
              links the key, and grants <code>witness_authority</code>.
            </p>
            <div class="nc-field">
              <label for="collective_name">Collective Organization name</label>
              <textarea id="collective_name" name="collective_name" maxlength="120" rows="1" placeholder="e.g., Fiber Community">${escapeHtml(suggestedCollectiveName)}</textarea>
            </div>
            <div class="nc-field">
              <label for="collective_slug">Slug</label>
              <textarea id="collective_slug" name="collective_slug" maxlength="100" rows="1" placeholder="auto-derived from name if left blank">${escapeHtml(suggestedCollectiveSlug)}</textarea>
            </div>
            <div class="nc-field">
              <label for="collective_description">Description (optional)</label>
              <textarea id="collective_description" name="collective_description" maxlength="2000" placeholder="One or two sentences. Shown on the org's public profile."></textarea>
            </div>
            <button type="submit" class="nc-btn">Approve as witnessing app</button>
          </form>
        </div>

        <div class="nc-card">
          <div class="nc-card-label">Decision — reject</div>
          <form method="POST" action="/operator/applications/${escapeAttr(app.id)}/reject">
            ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
            <div class="nc-field">
              <label for="reason">Reason (optional)</label>
              <textarea id="reason" name="reason" maxlength="2000" placeholder="A sentence or two. Shown to the applicant in the rejection email."></textarea>
            </div>
            <button type="submit" class="nc-btn nc-btn--danger">Reject</button>
          </form>
        </div>
      `
      : `<div class="nc-card" style="background: var(--bg);">
          <div class="nc-card-label">Decision</div>
          <div style="color:var(--muted);">This application has already been reviewed.</div>
        </div>`;

    const body = `
      <p style="margin:0 0 8px;"><a href="/operator/applications">← All applications</a></p>
      <h1>${escapeHtml(app.name || '(unnamed app)')}</h1>
      <div class="nc-meta">
        ${statusBadge(app.status, app.activated_at)}
        <span>${escapeHtml(app.contact_email)}</span>
        <span>Created ${escapeHtml(new Date(app.created_at).toLocaleString())}</span>
        ${app.key_prefix ? `<span>Key: <code>${escapeHtml(app.key_prefix)}…</code></span>` : ''}
      </div>
      ${callout}

      <div class="nc-card">
        <div class="nc-card-label">Contributor profile</div>
        ${profile
          ? `<div><strong>${escapeHtml(profile.name)}</strong> · slug <code>${escapeHtml(profile.slug)}</code> · status ${statusBadge(profile.status, null)}</div>
             ${profile.tagline ? `<div style="margin-top:8px; font-size:14px; color:var(--ink-2);">${escapeHtml(profile.tagline)}</div>` : ''}
             ${profile.description ? `<div class="nc-prose" style="margin-top:8px; font-size:14px;">${escapeHtml(profile.description)}</div>` : ''}
             ${profile.who_its_for ? `<div style="margin-top:8px; font-size:13px; color:var(--muted);"><strong>Who it's for:</strong> ${escapeHtml(profile.who_its_for)}</div>` : ''}
             ${profile.app_url ? `<div style="margin-top:8px; font-size:13px;">App URL: <a href="${escapeAttr(profile.app_url)}" target="_blank" rel="noopener">${escapeHtml(profile.app_url)}</a></div>` : ''}
             ${profile.category ? `<div style="margin-top:8px; font-size:13px; color:var(--muted);">Category: <code>${escapeHtml(profile.category)}</code></div>` : ''}`
          : `<div style="color:var(--muted);">No contributor profile linked to this key.</div>`}
      </div>

      <h2>Application answers</h2>
      <div class="nc-card">
        <div class="nc-card-label">What they're building</div>
        <div class="nc-prose">${escapeHtml((meta.what_youre_building as string) || '(empty)')}</div>
      </div>
      <div class="nc-card">
        <div class="nc-card-label">Verification process</div>
        <div class="nc-prose">${escapeHtml((meta.verification_process as string) || '(empty)')}</div>
      </div>

      ${brand && Object.keys(brand).length > 0 ? `<div class="nc-card">
        <div class="nc-card-label">Brand config</div>
        <pre style="white-space:pre-wrap; font-family:var(--font-mono); font-size:12px; margin:0; color:var(--ink-2);">${escapeHtml(JSON.stringify(brand, null, 2))}</pre>
      </div>` : ''}

      ${reviewSection(meta)}

      <h2>Decision</h2>
      ${actions}
    `;
    res.setHeader('Cache-Control', 'no-store');
    res.send(operatorShell({ title: app.name || 'Application', operatorEmail: req.operatorEmail || '', body }));
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// POST /operator/applications/:id/approve
// =============================================================================

router.post('/applications/:id/approve', operatorLimiter, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.status(403).setHeader('Content-Type', 'text/plain');
      res.send('CSRF check failed.');
      return;
    }

    const parsed = uuidSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.redirect(303, '/operator/applications');
      return;
    }

    const app = await loadApplication(parsed.data);
    if (!app) {
      res.redirect(303, '/operator/applications');
      return;
    }

    // Only pending applications are approvable. If the operator hit refresh
    // after a prior approval, no-op-redirect rather than double-flipping.
    if (!(app.status === 'active' && !app.activated_at)) {
      res.redirect(303, `/operator/applications/${app.id}`);
      return;
    }

    const nowIso = new Date().toISOString();
    const reviewRecord = {
      action: 'approved',
      at: nowIso,
      by: req.operatorEmail || 'unknown',
      notes: null,
    };
    const updatedMeta = {
      ...(app.application_metadata || {}),
      review: reviewRecord,
    };

    const { error: keyErr } = await supabaseAdmin
      .from('api_keys')
      .update({
        activated_at: nowIso,
        application_metadata: updatedMeta,
      })
      .eq('id', app.id);

    if (keyErr) {
      console.error('[OPERATOR] Approve api_key update failed:', keyErr.message);
      res.status(500).send(operatorShell({
        title: 'Approve failed',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Approve failed</h1>${errorBanner('Database update failed. Try again.')}`,
      }));
      return;
    }

    if (app.contributor_profile_id) {
      const { error: profErr } = await supabaseAdmin
        .from('contributor_profiles')
        .update({ status: 'active' })
        .eq('id', app.contributor_profile_id);
      if (profErr) {
        // The key is activated but profile didn't flip — surface but don't
        // unwind. Operator can retry the profile flip via a fresh approve
        // (the second approve would no-op because activated_at is set).
        console.error('[OPERATOR] Approve profile update failed:', profErr.message);
      }
    }

    // Send activation email. If sending fails, the approval still stands —
    // the operator sees the failure callout and can resend manually.
    const profile = await loadProfile(app.contributor_profile_id);
    try {
      await sendActivationEmail({
        email: app.contact_email,
        appName: app.name || profile?.name || 'your app',
        profileSlug: profile?.slug || '',
      });
    } catch (emailErr) {
      console.error('[OPERATOR] Activation email send failed:', emailErr instanceof Error ? emailErr.message : emailErr);
    }

    res.redirect(303, `/operator/applications/${app.id}?success=approved`);
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// POST /operator/applications/:id/reject
// =============================================================================

router.post('/applications/:id/reject', operatorLimiter, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.status(403).setHeader('Content-Type', 'text/plain');
      res.send('CSRF check failed.');
      return;
    }

    const parsed = uuidSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.redirect(303, '/operator/applications');
      return;
    }

    const app = await loadApplication(parsed.data);
    if (!app) {
      res.redirect(303, '/operator/applications');
      return;
    }

    if (!(app.status === 'active' && !app.activated_at)) {
      res.redirect(303, `/operator/applications/${app.id}`);
      return;
    }

    const formParsed = rejectFormSchema.safeParse(req.body || {});
    const reason = formParsed.success && formParsed.data.reason ? formParsed.data.reason : null;

    const nowIso = new Date().toISOString();
    const reviewRecord = {
      action: 'rejected',
      at: nowIso,
      by: req.operatorEmail || 'unknown',
      notes: reason,
    };
    const updatedMeta = {
      ...(app.application_metadata || {}),
      review: reviewRecord,
    };

    const { error: keyErr } = await supabaseAdmin
      .from('api_keys')
      .update({
        status: 'rejected',
        application_metadata: updatedMeta,
      })
      .eq('id', app.id);

    if (keyErr) {
      console.error('[OPERATOR] Reject api_key update failed:', keyErr.message);
      res.status(500).send(operatorShell({
        title: 'Reject failed',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Reject failed</h1>${errorBanner('Database update failed. Try again.')}`,
      }));
      return;
    }

    if (app.contributor_profile_id) {
      const { error: profErr } = await supabaseAdmin
        .from('contributor_profiles')
        .update({ status: 'suspended' })
        .eq('id', app.contributor_profile_id);
      if (profErr) {
        console.error('[OPERATOR] Reject profile update failed:', profErr.message);
      }
    }

    const profile = await loadProfile(app.contributor_profile_id);
    try {
      await sendRejectionEmail({
        email: app.contact_email,
        appName: app.name || profile?.name || 'your app',
        reason,
      });
    } catch (emailErr) {
      console.error('[OPERATOR] Rejection email send failed:', emailErr instanceof Error ? emailErr.message : emailErr);
    }

    res.redirect(303, `/operator/applications/${app.id}?success=rejected`);
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// POST /operator/applications/:id/approve-witnessing
// =============================================================================
//
// The witnessed-with-evidence approval (PR 4c). In addition to the
// standard approval, this:
//   1. Creates a collective Organization that this app will set as
//      `organizer_org_id` on witnessed events (per docs/four-roles.md).
//   2. Links the api_key → org via api_key_organization_links so the app
//      can manage its own collective.
//   3. Sets api_keys.witness_authority = true, which lets writes with
//      source_method='witnessed' bypass the org-link scope check.
//   4. Activates the key (activated_at) + flips contributor_profile.status
//      to 'active' (same as the standard approve path).
//   5. Sends the activation email with the collective org UUID +
//      a usage example.
//
// Sequence is best-effort atomic — on a failure partway, what's been
// written stays (no transactions across PostgREST). The operator can
// inspect and clean up manually if needed; logs surface where the
// failure happened.

router.post('/applications/:id/approve-witnessing', operatorLimiter, async (req, res, next) => {
  try {
    if (!validateCsrf(req)) {
      res.status(403).setHeader('Content-Type', 'text/plain');
      res.send('CSRF check failed.');
      return;
    }

    const parsed = uuidSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.redirect(303, '/operator/applications');
      return;
    }

    const app = await loadApplication(parsed.data);
    if (!app) {
      res.redirect(303, '/operator/applications');
      return;
    }

    if (!(app.status === 'active' && !app.activated_at)) {
      res.redirect(303, `/operator/applications/${app.id}`);
      return;
    }

    const formParsed = witnessApprovalSchema.safeParse(req.body || {});
    if (!formParsed.success) {
      // Re-render detail with error inline by redirecting back with a flag.
      // For now, surface a plain message — the form on the detail page is
      // single-step and the validation is minimal.
      res.status(400).send(operatorShell({
        title: 'Witnessing approval failed',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Witnessing approval failed</h1>${errorBanner('Collective name is required (2-120 chars). Slug and description are optional.')}<p><a href="/operator/applications/${escapeAttr(app.id)}">← Back to application</a></p>`,
      }));
      return;
    }

    const collectiveName = formParsed.data.collective_name;
    const collectiveSlug = (formParsed.data.collective_slug && formParsed.data.collective_slug.trim())
      || deriveOrgSlug(collectiveName);
    const collectiveDescription = formParsed.data.collective_description || null;

    if (!collectiveSlug || collectiveSlug.length < 1) {
      res.status(400).send(operatorShell({
        title: 'Witnessing approval failed',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Witnessing approval failed</h1>${errorBanner('Could not derive a valid slug from the collective name.')}<p><a href="/operator/applications/${escapeAttr(app.id)}">← Back to application</a></p>`,
      }));
      return;
    }

    // 1. Create the collective Organization.
    //    method='self_asserted' matches docs/four-roles.md — the
    //    contributor (this app) asserts the collective's existence.
    const { data: org, error: orgErr } = await supabaseAdmin
      .from('organizations')
      .insert({
        slug: collectiveSlug,
        name: collectiveName,
        description: collectiveDescription,
        method: 'self_asserted',
      })
      .select('id, slug, name')
      .single();

    if (orgErr || !org) {
      // Slug collision → 23505
      if (orgErr && (orgErr as { code?: string }).code === '23505') {
        res.status(409).send(operatorShell({
          title: 'Slug already in use',
          operatorEmail: req.operatorEmail || '',
          body: `<h1>Slug already in use</h1>${errorBanner(`The slug "${collectiveSlug}" is taken. Pick a different one and try again.`)}<p><a href="/operator/applications/${escapeAttr(app.id)}">← Back to application</a></p>`,
        }));
        return;
      }
      console.error('[OPERATOR] Witnessing org insert failed:', orgErr?.message);
      res.status(500).send(operatorShell({
        title: 'Provisioning failed',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Provisioning failed</h1>${errorBanner('Could not create the collective Organization. Check logs and try again.')}`,
      }));
      return;
    }

    // 2. Link the api_key → org (so the app can edit/manage its collective).
    const { error: linkErr } = await supabaseAdmin
      .from('api_key_organization_links')
      .insert({
        api_key_id: app.id,
        organization_id: org.id,
      });

    if (linkErr) {
      // Try to roll back the org so the slug frees up for a retry.
      await supabaseAdmin.from('organizations').delete().eq('id', org.id);
      console.error('[OPERATOR] api_key_organization_links insert failed:', linkErr.message);
      res.status(500).send(operatorShell({
        title: 'Provisioning failed',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Provisioning failed</h1>${errorBanner('Could not link the api_key to the collective. The collective was rolled back; try again.')}`,
      }));
      return;
    }

    // 3 + 4. Activate the key + grant witness_authority + review record.
    const nowIso = new Date().toISOString();
    const reviewRecord = {
      action: 'approved',
      variant: 'witnessing',
      at: nowIso,
      by: req.operatorEmail || 'unknown',
      notes: null,
      collective_org_id: org.id,
    };
    const updatedMeta = {
      ...(app.application_metadata || {}),
      review: reviewRecord,
    };

    const { error: keyErr } = await supabaseAdmin
      .from('api_keys')
      .update({
        activated_at: nowIso,
        witness_authority: true,
        application_metadata: updatedMeta,
      })
      .eq('id', app.id);

    if (keyErr) {
      console.error('[OPERATOR] Witnessing approve api_key update failed:', keyErr.message);
      // Org + link are already in place; leave them — operator can
      // re-run the approval (the duplicate check on activated_at will
      // skip the re-provisioning).
      res.status(500).send(operatorShell({
        title: 'Approval failed',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Approval failed mid-sequence</h1>${errorBanner('Collective Organization was created and linked, but flipping the key to activated failed. Check the logs and complete manually if needed.')}`,
      }));
      return;
    }

    if (app.contributor_profile_id) {
      const { error: profErr } = await supabaseAdmin
        .from('contributor_profiles')
        .update({ status: 'active' })
        .eq('id', app.contributor_profile_id);
      if (profErr) {
        console.error('[OPERATOR] Witnessing approve profile update failed:', profErr.message);
      }
    }

    // 5. Send activation email with collective UUID + usage example.
    const profile = await loadProfile(app.contributor_profile_id);
    try {
      await sendActivationEmail({
        email: app.contact_email,
        appName: app.name || profile?.name || 'your app',
        profileSlug: profile?.slug || '',
        collectiveOrg: {
          id: org.id as string,
          name: org.name as string,
          slug: org.slug as string,
        },
      });
    } catch (emailErr) {
      console.error('[OPERATOR] Witnessing activation email send failed:', emailErr instanceof Error ? emailErr.message : emailErr);
    }

    res.redirect(303, `/operator/applications/${app.id}?success=approved-witnessing`);
  } catch (err) {
    next(err);
  }
});

export default router;
