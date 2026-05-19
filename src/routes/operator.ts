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
 *   GET   /operator/applications                          — list of pending api_keys
 *   GET   /operator/applications/:id                      — application detail + actions
 *   POST  /operator/applications/:id/approve              — provision collective + activate + (optional) grant witness_authority
 *   POST  /operator/applications/:id/reject               — flip status, send rejection email
 *   POST  /operator/applications/:id/grant-witnessing     — grant witness_authority on request (PR B)
 *
 * Operator authority is purely env-var driven; there's no `is_operator`
 * column. Adding one later is additive.
 *
 * The "always provision collective at approval" rule (PR B) replaces
 * the earlier PR 4c approve-witnessing fork: every developer is equipped
 * with a collective Organization at activation time; witness_authority
 * stays operator-gated but flows through a self-service request flow
 * from the dashboard.
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
  sendWitnessingEnabledEmail,
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

const approvalSchema = z.object({
  collective_name: z.string().trim().min(2).max(120),
  collective_slug: z.string().trim().min(1).max(100).optional(),
  collective_description: z.string().trim().max(2000).optional(),
  // HTML checkboxes send "on" when checked, omitted when unchecked.
  grant_witness_authority: z.string().optional(),
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
  witness_authority: boolean | null;
  witness_authority_requested_at: string | null;
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
    .select('id, name, contact_email, url, key_prefix, status, activated_at, application_metadata, brand_config, contributor_profile_id, created_at, witness_authority, witness_authority_requested_at')
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
      ? calloutBanner('Approved. Collective Organization provisioned, key linked, activation email sent.')
      : successFlag === 'rejected'
      ? calloutBanner('Rejected. Notification email sent.')
      : successFlag === 'witness-granted'
      ? calloutBanner('Witnessing capability granted. Developer notified by email.')
      : '';

    const csrfToken = issueCsrfCookie(res);
    const isPending = app.status === 'active' && !app.activated_at;

    // Pre-fill the collective fields: "<App Name> Community" as the default
    // name, derived slug. Operator can edit before submit. Every approval
    // provisions a collective — per PR B, equip every developer with their
    // collective Organization at activation time.
    const suggestedCollectiveName = `${app.name || 'App'} Community`;
    const suggestedCollectiveSlug = deriveOrgSlug(suggestedCollectiveName);

    // If this is an already-activated key whose developer has requested
    // witness_authority, surface a banner with one-click grant.
    const witnessRequestBanner = (!isPending && app.witness_authority_requested_at && !app.witness_authority)
      ? `
        <div class="nc-card" style="border-left: 3px solid var(--accent);">
          <div class="nc-card-label">Witnessing requested</div>
          <p style="margin:0 0 10px;">
            The developer requested witness_authority on <strong>${escapeHtml(new Date(app.witness_authority_requested_at).toLocaleString())}</strong>.
            Grants the capability to write events with <code>source_method='witnessed'</code> attributed to their collective.
          </p>
          <form method="POST" action="/operator/applications/${escapeAttr(app.id)}/grant-witnessing">
            ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
            <button type="submit" class="nc-btn">Grant witnessing</button>
          </form>
        </div>
      `
      : '';

    const actions = isPending
      ? `
        <div class="nc-card">
          <div class="nc-card-label">Decision — approve</div>
          <form method="POST" action="/operator/applications/${escapeAttr(app.id)}/approve" style="margin-bottom:8px;">
            ${hiddenInput(CSRF_FIELD_NAME, csrfToken)}
            <p style="margin:0 0 12px;">
              Activates the service key and provisions a collective <code>Organization</code> for this app.
              Every developer gets a collective at approval — it's what they'll use as <code>organizer_org_id</code> on witnessed events (per <a href="/docs/four-roles" target="_blank" rel="noopener">four-roles</a>).
              <code>witness_authority</code> stays off by default; the developer can request it from their dashboard, or you can grant it preemptively below.
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
              <label for="collective_description">Collective description (optional)</label>
              <textarea id="collective_description" name="collective_description" maxlength="2000" placeholder="One or two sentences. Shown on the org's public profile."></textarea>
            </div>
            <div class="nc-field" style="margin-bottom:14px;">
              <label style="font-weight: 400; color: var(--ink-2);">
                <input type="checkbox" name="grant_witness_authority" value="on" style="vertical-align: middle; margin-right: 6px;">
                Also grant <code>witness_authority</code> now (preemptive — usually leave unchecked; developer can request from dashboard)
              </label>
            </div>
            <button type="submit" class="nc-btn">Approve and activate</button>
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
      : `${witnessRequestBanner}<div class="nc-card" style="background: var(--bg);">
          <div class="nc-card-label">Decision</div>
          <div style="color:var(--muted);">This application has already been reviewed.${app.witness_authority ? ' Witnessing is enabled.' : ''}</div>
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

// Approve always provisions a collective Organization for the app (per
// docs/four-roles.md — every contributor needs a collective identity to
// use as organizer_org_id on witnessed events). witness_authority is
// optional at this step; the developer can request it later from the
// dashboard.

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

    if (!(app.status === 'active' && !app.activated_at)) {
      res.redirect(303, `/operator/applications/${app.id}`);
      return;
    }

    const formParsed = approvalSchema.safeParse(req.body || {});
    if (!formParsed.success) {
      res.status(400).send(operatorShell({
        title: 'Approval failed',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Approval failed</h1>${errorBanner('Collective name is required (2-120 chars).')}<p><a href="/operator/applications/${escapeAttr(app.id)}">← Back to application</a></p>`,
      }));
      return;
    }

    const collectiveName = formParsed.data.collective_name;
    const collectiveSlug = (formParsed.data.collective_slug && formParsed.data.collective_slug.trim())
      || deriveOrgSlug(collectiveName);
    const collectiveDescription = formParsed.data.collective_description || null;
    const grantWitness = !!formParsed.data.grant_witness_authority;

    if (!collectiveSlug || collectiveSlug.length < 1) {
      res.status(400).send(operatorShell({
        title: 'Approval failed',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Approval failed</h1>${errorBanner('Could not derive a valid slug from the collective name.')}<p><a href="/operator/applications/${escapeAttr(app.id)}">← Back to application</a></p>`,
      }));
      return;
    }

    // 1. Create the collective Organization.
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
      if (orgErr && (orgErr as { code?: string }).code === '23505') {
        res.status(409).send(operatorShell({
          title: 'Slug already in use',
          operatorEmail: req.operatorEmail || '',
          body: `<h1>Slug already in use</h1>${errorBanner(`The slug "${collectiveSlug}" is taken. Pick a different one and try again.`)}<p><a href="/operator/applications/${escapeAttr(app.id)}">← Back to application</a></p>`,
        }));
        return;
      }
      console.error('[OPERATOR] Approval org insert failed:', orgErr?.message);
      res.status(500).send(operatorShell({
        title: 'Approval failed',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Approval failed</h1>${errorBanner('Could not create the collective Organization. Check logs and try again.')}`,
      }));
      return;
    }

    // 2. Link the api_key → org (so the app can edit / manage its collective).
    const { error: linkErr } = await supabaseAdmin
      .from('api_key_organization_links')
      .insert({
        api_key_id: app.id,
        organization_id: org.id,
      });

    if (linkErr) {
      await supabaseAdmin.from('organizations').delete().eq('id', org.id);
      console.error('[OPERATOR] api_key_organization_links insert failed:', linkErr.message);
      res.status(500).send(operatorShell({
        title: 'Approval failed',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Approval failed</h1>${errorBanner('Could not link the api_key to the collective. The collective was rolled back; try again.')}`,
      }));
      return;
    }

    // 3. Activate the key + (optionally) grant witness_authority + review record.
    const nowIso = new Date().toISOString();
    const reviewRecord = {
      action: 'approved',
      at: nowIso,
      by: req.operatorEmail || 'unknown',
      notes: null,
      collective_org_id: org.id,
      witness_authority_granted: grantWitness,
    };
    const updatedMeta = {
      ...(app.application_metadata || {}),
      review: reviewRecord,
    };

    const keyUpdate: Record<string, unknown> = {
      activated_at: nowIso,
      application_metadata: updatedMeta,
    };
    if (grantWitness) {
      keyUpdate.witness_authority = true;
      keyUpdate.witness_authority_requested_at = null;
    }

    const { error: keyErr } = await supabaseAdmin
      .from('api_keys')
      .update(keyUpdate)
      .eq('id', app.id);

    if (keyErr) {
      console.error('[OPERATOR] Approval api_key update failed:', keyErr.message);
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
        console.error('[OPERATOR] Approval profile update failed:', profErr.message);
      }
    }

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
// POST /operator/applications/:id/grant-witnessing
// =============================================================================
//
// Grants witness_authority to a key that has requested it (PR B). The
// developer triggers the request via /developers/collective/request-witnessing
// from their dashboard; this is the operator's one-click approve.
//
// Idempotent: if witness_authority is already true, just redirects.

router.post('/applications/:id/grant-witnessing', operatorLimiter, async (req, res, next) => {
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

    if (app.witness_authority === true) {
      // Already granted — no-op redirect.
      res.redirect(303, `/operator/applications/${app.id}?success=witness-granted`);
      return;
    }

    const nowIso = new Date().toISOString();
    const reviewMeta = (app.application_metadata || {}) as Record<string, unknown>;
    const witnessGrantRecord = {
      action: 'witness_authority_granted',
      at: nowIso,
      by: req.operatorEmail || 'unknown',
    };
    const updatedMeta = {
      ...reviewMeta,
      witness_grant: witnessGrantRecord,
    };

    const { error: updErr } = await supabaseAdmin
      .from('api_keys')
      .update({
        witness_authority: true,
        witness_authority_requested_at: null,
        application_metadata: updatedMeta,
      })
      .eq('id', app.id);

    if (updErr) {
      console.error('[OPERATOR] Grant-witnessing update failed:', updErr.message);
      res.status(500).send(operatorShell({
        title: 'Grant failed',
        operatorEmail: req.operatorEmail || '',
        body: `<h1>Grant failed</h1>${errorBanner('Database update failed. Try again.')}`,
      }));
      return;
    }

    // Notify the developer that witnessing is now enabled. Best-effort.
    try {
      const profile = await loadProfile(app.contributor_profile_id);
      const collectiveOrg = await loadCollectiveOrgForKey(app.id);
      await sendWitnessingEnabledEmail({
        email: app.contact_email,
        appName: app.name || profile?.name || 'your app',
        collectiveOrg,
      });
    } catch (emailErr) {
      console.error('[OPERATOR] Witnessing-enabled email send failed:', emailErr instanceof Error ? emailErr.message : emailErr);
    }

    res.redirect(303, `/operator/applications/${app.id}?success=witness-granted`);
  } catch (err) {
    next(err);
  }
});

/**
 * Resolve the collective Organization linked to the given api_key.
 * Returns the first (and typically only) linked org. Used by the
 * grant-witnessing email so the developer sees the UUID they should be
 * using as `organizer_org_id`.
 */
async function loadCollectiveOrgForKey(apiKeyId: string): Promise<{ id: string; name: string; slug: string } | null> {
  const { data: link } = await supabaseAdmin
    .from('api_key_organization_links')
    .select('organization_id')
    .eq('api_key_id', apiKeyId)
    .limit(1)
    .maybeSingle();
  if (!link?.organization_id) return null;
  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('id, name, slug')
    .eq('id', link.organization_id)
    .maybeSingle();
  if (!org) return null;
  return {
    id: org.id as string,
    name: org.name as string,
    slug: org.slug as string,
  };
}

export default router;
