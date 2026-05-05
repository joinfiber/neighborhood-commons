/**
 * Neighborhood Commons — Express Application
 *
 * Open neighborhood event data service.
 * CC BY 4.0.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import express, { Express, Request, Response } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';

import { config } from './config.js';
import { supabaseAdmin } from './lib/supabase.js';
import { errorHandler } from './middleware/error-handler.js';
import { globalLimiter } from './middleware/rate-limit.js';

// Routes
import publicRoutes from './routes/public.js';
import portalRoutes from './routes/portal.js';
import adminRoutes from './routes/admin.js';
import v1Routes, { v1Limiter, icsHandler, rssHandler } from './routes/v1.js';
import v1GroupRoutes, { groupsLimiter } from './routes/v1-groups.js';
import v1AccountRoutes, { accountsLimiter } from './routes/v1-accounts.js';
import v1PlacesRoutes, { placesLimiter as v1PlacesLimiter } from './routes/v1-places.js';
import v1OrganizationsRoutes, { organizationsLimiter } from './routes/v1-organizations.js';
import v1PersonsRoutes, { personsLimiter } from './routes/v1-persons.js';
import v1BroadcastsRoutes, { broadcastsLimiter } from './routes/v1-broadcasts.js';
import v1ListsRoutes, { listsLimiter } from './routes/v1-lists.js';
import v1VerifiersRoutes, { verifiersLimiter } from './routes/v1-verifiers.js';
import webhookRoutes from './routes/webhooks.js';
import metaRoutes from './routes/meta.js';
import cronRoutes from './routes/cron.js';
import placesRoutes from './routes/places.js';
import developerRoutes from './routes/developers.js';
import contributeRoutes from './routes/contribute.js';
import serviceRoutes from './routes/service.js';
import pageRoutes from './routes/pages.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the deployed version once at boot so /health can report it.
const pkg = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
const API_VERSION: string = pkg.version;

/**
 * Health check handler — verifies Supabase connectivity, not just process liveness.
 * Serves at both /health (canonical) and /api/internal/health (backward-compat
 * alias for any external monitors configured against the legacy path).
 */
async function healthHandler(_req: Request, res: Response): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('regions').select('id').limit(1);
    if (error) {
      console.error('[HEALTH] DB check failed:', error.message);
      res.status(503).json({
        status: 'error',
        service: 'neighborhood-commons',
        timestamp: new Date().toISOString(),
        version: API_VERSION,
        error: 'Database connection failed',
      });
      return;
    }
    res.json({
      status: 'ok',
      service: 'neighborhood-commons',
      timestamp: new Date().toISOString(),
      version: API_VERSION,
    });
  } catch {
    res.status(503).json({
      status: 'error',
      service: 'neighborhood-commons',
      timestamp: new Date().toISOString(),
      version: API_VERSION,
      error: 'Health check failed',
    });
  }
}

export function createApp(): Express {
  const app = express();

  // SECURITY: trust proxy = 1 is Railway's recommended setting. Railway adds
  // exactly one proxy hop, so Express reads the rightmost X-Forwarded-For entry
  // (the one Railway injected). An attacker-prepended XFF value is ignored.
  // Changing this without understanding Railway's proxy topology breaks rate limiting.
  app.set('trust proxy', 1);

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          scriptSrc: ["'self'", 'https://challenges.cloudflare.com', 'https://static.cloudflareinsights.com'],
          frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
          connectSrc: ["'self'", config.supabase.url, 'https://places.googleapis.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
        },
      },
      // Event images are public data (CC BY 4.0) — allow cross-origin embedding
      // so consumers on other domains can render images without CORP blocking.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
    })
  );

  // CORS — public API is open to all origins; portal/admin routes are restricted
  const publicCors = cors({
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key'],
  });
  const privateCors = cors({
    origin: config.cors.origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Cron-Secret'],
    credentials: true,
  });

  // Open CORS for public read endpoints
  app.use('/api/v1', publicCors);
  app.use('/api/meta', publicCors);
  app.use('/.well-known', publicCors);
  app.use('/api/developers', publicCors);
  app.use('/llms.txt', publicCors);
  // Widget JS and badges must load from any origin
  app.use('/widget', publicCors);
  app.use('/pages.css', publicCors);

  // Restricted CORS for portal, admin, webhooks, internal routes
  app.use('/api/portal', privateCors);
  app.use('/api/admin', privateCors);
  app.use('/api/webhooks', privateCors);
  app.use('/api/internal', privateCors);
  app.use('/api/cron', privateCors);
  app.use('/api/places', privateCors);

  // Response compression
  app.use(compression());

  // Body parsing
  app.use(express.json({ limit: '5mb' }));

  // Global rate limit
  app.use(globalLimiter);

  // ─── Health check (no auth) ──────────────────────────────────────
  // Both paths served by the same handler for backward compatibility with
  // external monitors configured against /api/internal/health before the
  // fifth-auth-model cleanup. The canonical path is /health.
  app.get('/health', healthHandler);
  app.get('/api/internal/health', healthHandler);

  // ─── AI-readable docs ─────────────────────────────────────────────
  app.get('/llms.txt', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/llms.txt'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  });

  // ─── OpenAPI spec ─────────────────────────────────────────────────
  app.get('/api/v1/openapi.json', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/openapi.json'), { headers: { 'Content-Type': 'application/json' } });
  });

  // ─── Public Data API ─────────────────────────────────────────────
  app.use('/api/events', publicRoutes);

  // ─── Portal (business CRUD) ──────────────────────────────────────
  app.use('/api/portal', portalRoutes);

  // ─── Commons Admin ───────────────────────────────────────────────
  app.use('/api/admin', adminRoutes);
  app.use('/api/portal/admin', adminRoutes);

  // ─── Neighborhood API v1 ─────────────────────────────────────────
  app.use('/api/v1/events', v1Limiter, v1Routes);
  app.use('/api/v1/groups', groupsLimiter, v1GroupRoutes);
  app.use('/api/v1/accounts', accountsLimiter, v1AccountRoutes);
  app.use('/api/v1/places', v1PlacesLimiter, v1PlacesRoutes);
  app.use('/api/v1/organizations', organizationsLimiter, v1OrganizationsRoutes);
  app.use('/api/v1/persons', personsLimiter, v1PersonsRoutes);
  app.use('/api/v1/broadcasts', broadcastsLimiter, v1BroadcastsRoutes);
  app.use('/api/v1/lists', listsLimiter, v1ListsRoutes);
  app.use('/api/v1/verifiers', verifiersLimiter, v1VerifiersRoutes);

  // iCal + RSS feeds (mounted at /api/v1/ level)
  app.get('/api/v1/events.ics', icsHandler);
  app.get('/api/v1/events.rss', rssHandler);

  // ─── Meta (regions, categories) ──────────────────────────────────
  app.use('/api/v1/meta', metaRoutes);
  app.use('/api/meta', metaRoutes);

  // ─── Webhooks ────────────────────────────────────────────────────
  app.use('/api/v1/webhooks', webhookRoutes);
  app.use('/api/webhooks', webhookRoutes);

  // ─── Cron jobs ───────────────────────────────────────────────────
  app.use('/api/cron', cronRoutes);

  // ─── Developer Registration ─────────────────────────────────────
  app.use('/api/v1/developers', developerRoutes);

  // ─── Contribute API (external app writes) ─────────────────────
  app.use('/api/v1/contribute', contributeRoutes);
  app.use('/api/v1/service', serviceRoutes);

  // ─── Places (venue search for portal) ──────────────────────────
  app.use('/api/places', placesRoutes);

  // ─── Landing page (server-rendered, instant load, no JS) ───────────
  let cachedStats = {
    totalEvents: 0,
    totalOrganizations: 0,
    totalPlaces: 0,
    regionName: '',
    fetchedAt: 0,
  };
  const STATS_TTL_MS = 24 * 60 * 60 * 1000;

  async function getLandingStats() {
    if (Date.now() - cachedStats.fetchedAt < STATS_TTL_MS) return cachedStats;
    try {
      const [eventResult, orgResult, placeResult, regionResult] = await Promise.all([
        supabaseAdmin.from('events').select('id', { count: 'exact', head: true }).eq('status', 'published'),
        supabaseAdmin.from('organizations').select('id', { count: 'exact', head: true }),
        supabaseAdmin.from('places').select('id', { count: 'exact', head: true }),
        supabaseAdmin.from('regions').select('name').eq('is_active', true).limit(1).maybeSingle(),
      ]);
      cachedStats = {
        totalEvents: eventResult.count || 0,
        totalOrganizations: orgResult.count || 0,
        totalPlaces: placeResult.count || 0,
        regionName: regionResult.data?.name || '',
        fetchedAt: Date.now(),
      };
    } catch { /* stats are optional — stale cache is fine */ }
    return cachedStats;
  }

  app.get('/', async (_req, res, next) => {
    try {
      const baseUrl = config.apiBaseUrl || 'https://api.neighborhood-commons.org';
      const { totalEvents, totalOrganizations, totalPlaces, regionName } = await getLandingStats();

      const statsLine = totalEvents > 0
        ? `Currently serving <strong>${totalEvents.toLocaleString()} events</strong>, <strong>${totalOrganizations.toLocaleString()} organizations</strong>, and <strong>${totalPlaces.toLocaleString()} places</strong>${regionName ? ` in <strong>${regionName}</strong>` : ''}.`
        : '';

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Neighborhood Commons — Open neighborhood data infrastructure</title>
  <meta name="description" content="Open infrastructure for neighborhood data. Events, organizations, places, broadcasts, curated lists. Schema.org-aligned, verified contributors, public reputation graph. Read free. Build with confidence. CC BY 4.0.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/pages.css">
  <style>
    .nc-landing { max-width: 760px; margin: 0 auto; padding: 56px 24px 80px; }
    .nc-hero h1 { font-size: 2.5rem; font-weight: 400; line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 16px; }
    .nc-hero p { font-size: 1.05rem; line-height: 1.7; color: var(--nc-muted); max-width: 580px; }
    .nc-hero .nc-stats { color: var(--nc-text); margin-top: 8px; }
    .nc-hero .nc-stats strong { font-weight: 600; }
    .nc-label { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--nc-dim); margin: 48px 0 14px; }
    .nc-hero .nc-label { margin-top: 0; margin-bottom: 20px; }
    .nc-case { margin: 48px 0 0; }
    .nc-case-point { margin-bottom: 32px; }
    .nc-case-heading { font-size: 1.05rem; font-weight: 500; color: var(--nc-text); margin-bottom: 8px; }
    .nc-case-point p { font-size: 0.9rem; color: var(--nc-muted); line-height: 1.7; margin: 0; }
    .nc-ctas { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 40px 0; }
    .nc-cta { background: var(--nc-surface); border: 1px solid var(--nc-border); border-radius: 12px; padding: 24px; }
    .nc-cta-label { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--nc-dim); margin-bottom: 10px; }
    .nc-cta p { font-size: 0.9rem; color: var(--nc-text); line-height: 1.6; margin: 0 0 16px; }
    .nc-btn { display: inline-block; padding: 10px 20px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; text-decoration: none; font-family: inherit; }
    .nc-btn-primary { background: var(--nc-accent); color: #fff; }
    .nc-btn-secondary { background: var(--nc-surface); color: var(--nc-accent); border: 1px solid var(--nc-border); }
    .nc-code { background: var(--nc-accent); color: #e8e6e1; border-radius: 10px; padding: 18px 22px; font-family: 'DM Mono', monospace; font-size: 0.8rem; line-height: 1.7; overflow-x: auto; margin: 0 0 8px; white-space: pre; }
    .nc-dim-note { font-size: 0.8rem; color: var(--nc-dim); line-height: 1.6; margin: 8px 0 0; }
    .nc-prose { font-size: 0.9rem; color: var(--nc-muted); line-height: 1.7; margin: 0 0 20px; }
    .nc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 40px; margin-bottom: 24px; }
    .nc-grid-item { display: flex; gap: 12px; padding: 4px 0; font-size: 0.875rem; }
    .nc-grid-label { color: var(--nc-text); font-weight: 500; min-width: 80px; }
    .nc-grid-desc { color: var(--nc-muted); }
    .nc-ep-list { background: var(--nc-surface); border: 1px solid var(--nc-border); border-radius: 10px; overflow: hidden; margin-bottom: 8px; }
    .nc-ep { display: flex; align-items: baseline; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--nc-border); font-size: 0.875rem; }
    .nc-ep:last-child { border-bottom: none; }
    .nc-ep-method { font-size: 0.75rem; font-weight: 600; font-family: 'DM Mono', monospace; min-width: 36px; }
    .nc-ep-method-get { color: #2d8a4e; }
    .nc-ep-method-post { color: var(--nc-text); }
    .nc-ep-path { font-family: 'DM Mono', monospace; font-weight: 500; }
    .nc-ep-desc { color: var(--nc-dim); margin-left: auto; text-align: right; }
    .nc-ep-auth { font-size: 0.7rem; color: var(--nc-dim); background: var(--nc-bg); padding: 1px 6px; border-radius: 4px; }
    .nc-app { background: var(--nc-surface); border: 1px solid var(--nc-border); border-radius: 12px; padding: 20px 24px; margin-bottom: 12px; }
    .nc-app-placeholder { background: transparent; border-style: dashed; }
    .nc-app a { font-size: 0.9rem; font-weight: 500; }
    .nc-app p { font-size: 0.85rem; color: var(--nc-muted); line-height: 1.6; margin: 6px 0 0; }
    .nc-stability { background: var(--nc-cream); border-radius: 10px; padding: 20px 24px; margin: 16px 0 40px; font-size: 0.875rem; line-height: 1.7; }
    .nc-footer { border-top: 1px solid var(--nc-border); padding-top: 24px; display: flex; flex-wrap: wrap; gap: 10px 24px; align-items: center; font-size: 0.8rem; }
    .nc-footer a, .nc-footer span { color: var(--nc-muted); text-decoration: none; }
    .nc-footer a:hover { text-decoration: underline; }
    @media (max-width: 640px) {
      .nc-hero h1 { font-size: 1.75rem; }
      .nc-ctas { grid-template-columns: 1fr; }
      .nc-grid { grid-template-columns: 1fr; }
      .nc-ep-desc { display: none; }
    }
  </style>
</head>
<body>
  <div class="nc-page">
    <header class="nc-header">
      <div class="nc-header-inner">
        <span style="font-weight:600;">Neighborhood Commons</span>
      </div>
    </header>
    <main class="nc-landing">

      <div class="nc-hero">
        <div class="nc-label">neighborhood commons &middot; v1.0.0</div>
        <h1>An open layer for everything that happens in a neighborhood.</h1>
        <p>
          Events. Organizations. Places. Broadcasts. Curated lists. Six types of public facts every neighborhood app can read, mix, and remix &mdash; the typed substrate under the next generation of community tooling.
          ${statsLine ? `<span class="nc-stats">${statsLine}</span>` : ''}
        </p>
      </div>

      <div class="nc-case">
        <div class="nc-case-point">
          <div class="nc-case-heading">Read free. Build with confidence.</div>
          <p>Every endpoint is open. No API key required to read. No rate-limit gating. The spec is locked at 1.0.0 and committed to <strong>additive-only stability</strong> &mdash; future versions add types and fields without breaking existing consumers. If you build against this contract today, the same code should work in 18 months.</p>
        </div>
        <div class="nc-case-point">
          <div class="nc-case-heading">Apps don&rsquo;t compete with the Commons. They compete on what they show.</div>
          <p>The Commons isn&rsquo;t a destination. Each app composes its own slice through opt-in filters: by verifier, by contributor, by proximity, by type. Same data, different editorial. A neighborhood with one Yelp is fragile. A neighborhood with twenty different surfaces over the same open substrate is alive.</p>
        </div>
        <div class="nc-case-point">
          <div class="nc-case-heading">Verify once. Recognized everywhere.</div>
          <p>When a business gets verified through one app on the network, every other app can honor that verification &mdash; or filter it out. The reputation graph is public; verifiers earn or lose trust based on the quality of their approvals. No central referee. The market polices itself.</p>
        </div>
      </div>

      <div class="nc-ctas">
        <div class="nc-cta">
          <div class="nc-cta-label">Build a consumer app</div>
          <p>Read every endpoint without authentication. Curl examples below. Generate a typed client from <a href="${baseUrl}/openapi.json">openapi.json</a> or install the SDK: <code>npm install neighborhood-commons</code>.</p>
          <a href="${baseUrl}/llms.txt" class="nc-btn nc-btn-primary">Read the Guide</a>
        </div>
        <div class="nc-cta">
          <div class="nc-cta-label">Contribute through an integration</div>
          <p>Service-tier write access is operator-issued, with brand-configured verification and a public reputation track record. Email us with what you&rsquo;re building and how you&rsquo;ll verify.</p>
          <a href="mailto:hi@neighborhood-commons.org?subject=Service-tier%20integration" class="nc-btn nc-btn-secondary">Apply for a service key</a>
        </div>
      </div>

      <div class="nc-label">Try it now</div>
      <div class="nc-code">$ curl "${baseUrl}/api/v1/events?near=39.97,-75.14&radius_km=2"

# Verified businesses near a point
$ curl "${baseUrl}/api/v1/organizations?kind=local_business&verified=true"

# What&rsquo;s being broadcast right now
$ curl "${baseUrl}/api/v1/broadcasts?near=39.97,-75.14&radius_km=1"

# The reputation graph &mdash; who verifies whom, with full track record
$ curl "${baseUrl}/api/v1/verifiers"</div>
      <p class="nc-dim-note">No authentication required. Schema.org-aligned JSON responses. Calendar feeds also available at <code>/api/v1/events.ics</code> and <code>/api/v1/events.rss</code>.</p>

      <div class="nc-label">What&rsquo;s in the substrate</div>
      <p class="nc-prose">Six types of public facts. Each maps to a Schema.org concept &mdash; the open vocabulary the rest of the web already uses for events, places, and organizations. Apps compose them however they want.</p>
      <div class="nc-grid">
        <div class="nc-grid-item"><span class="nc-grid-label">Place</span><span class="nc-grid-desc">Physical locations. Address, coordinates, identified by Google Places ID.</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">Organization</span><span class="nc-grid-desc">Businesses, community groups, nonprofits, curators, collectives.</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">Person</span><span class="nc-grid-desc">DJs, performers, curators, individual organizers.</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">Event</span><span class="nc-grid-desc">Activities at a time, hosted by an Organization or Person, at a Place.</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">Broadcast</span><span class="nc-grid-desc">Ephemeral signals from verified businesses. Maximum 24h lifetime.</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">List</span><span class="nc-grid-desc">Curatorial selections of events, organizations, or places.</span></div>
      </div>
      <p class="nc-dim-note">Every response is self-contained. Verified state and provenance ride along with every record &mdash; consumers compose their own trust policy via <code>verified_by</code>, <code>not_verified_by</code>, and <code>created_by_contributor</code> filters.</p>

      <div class="nc-label">Read API</div>
      <div class="nc-ep-list">
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/events</span><span class="nc-ep-desc">Events &mdash; filter, search, paginate</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/places</span><span class="nc-ep-desc">Physical locations</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/organizations</span><span class="nc-ep-desc">Businesses, community groups, curators</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/persons</span><span class="nc-ep-desc">Individuals &mdash; performers, curators, hosts</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/broadcasts</span><span class="nc-ep-desc">Ephemeral signals, active only</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/lists</span><span class="nc-ep-desc">Curatorial selections</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/verifiers</span><span class="nc-ep-desc">Reputation graph &mdash; per-app verification track records</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/events.ics</span><span class="nc-ep-desc">iCalendar feed</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/meta</span><span class="nc-ep-desc">Metadata, stats, regions, categories</span></div>
      </div>
      <p class="nc-dim-note">Rate limit: 1,000 requests/hour per IP (or per API key). Full surface in <a href="${baseUrl}/openapi.json">openapi.json</a>.</p>

      <div class="nc-label">Verification &amp; reputation</div>
      <p class="nc-prose">Verification is a process the Commons orchestrates and an attribute apps consume &mdash; not a permission gate. When an app verifies a business through email-loop or in-person review, every other app on the network sees the verification, who issued it, and that verifier&rsquo;s public track record. Apps compose <code>verified_by</code> filters that match their own trust policy.</p>
      <div class="nc-code">$ curl "${baseUrl}/api/v1/verifiers"

# Filter to organizations verified by trusted apps
$ curl "${baseUrl}/api/v1/organizations?verified_by=Holler,Merrie"

# Audit a verifier&rsquo;s recent approvals
$ curl "${baseUrl}/api/v1/verifiers/Holler/recent_approvals"</div>
      <p class="nc-dim-note">Verify once, recognized everywhere apps choose to honor. Sloppy verification is filtered out by other apps. Market discipline replaces central authority.</p>

      <div class="nc-label">Real-time webhooks</div>
      <p class="nc-prose">
        Subscribe to <code>event.created</code>, <code>event.updated</code>, and <code>event.deleted</code>.
        HMAC-SHA256 signed. Automatic retries. More event types are added as the substrate grows.
        Setup via the API: <code>POST /api/v1/webhooks</code>.
      </p>

      <div class="nc-label">Expressions of the Commons</div>
      <p class="nc-prose">The substrate is open. Apps build different experiences on it. These are some of the surfaces in flight.</p>
      <div class="nc-app"><a href="https://merrie.co" target="_blank" rel="noopener">merrie.co &nearr;</a><p>The publishing tool for curators and venue operators. Surfaces events for browsing, lets curators build editorial lists, generates venue pages automatically.</p></div>
      <div class="nc-app"><a href="https://joinfiber.app" target="_blank" rel="noopener">Fiber &nearr;</a><p>The social mobile app. Browse what&rsquo;s on tonight, share plans with friends, see what&rsquo;s nearby. Same data, social-first surface.</p></div>
      <div class="nc-app"><span style="font-size:0.9rem;font-weight:500;">Holler &middot; in development</span><p>Verified businesses broadcast real-time signals into nearby feeds &mdash; "kitchen open late," "half off sandwiches." Holler does in-person business verification, and other apps consume the verified businesses through the public reputation graph.</p></div>
      <div class="nc-app nc-app-placeholder"><span style="font-size:0.9rem;font-weight:500;color:var(--nc-dim);">Yours</span><p>A neighborhood newsletter. A civic dashboard. A nightlife guide. A walking tour. A "free stuff in Fishtown" filter. Whatever your audience, the substrate is here.</p></div>

      <div class="nc-label">How this is built</div>
      <p class="nc-prose">The Commons is thin on purpose. It stores typed atoms and serves them. It doesn&rsquo;t editorialize, recommend, or curate &mdash; those are the concerns of the apps that build on top. The Commons is plumbing, and good plumbing doesn&rsquo;t change with the winds.</p>
      <p class="nc-prose" style="color:var(--nc-dim);">Schema.org-aligned response shapes. Row Level Security on every table. Zod validation on every input. Images re-encoded through Sharp. No ORMs, no magic. Every behavior is traceable from the route handler to the database query to the response. The <a href="https://github.com/joinfiber/neighborhood-commons" target="_blank" rel="noopener">source is open</a> and written to be read by skeptics.</p>

      <div class="nc-stability">
        <strong>The 1.0.0 spec is stable.</strong> Future minor versions add types, fields, and endpoints additively. Removals or renames require 2.0.0 with strong justification &mdash; measured in years, not months. Watch <a href="https://github.com/joinfiber/neighborhood-commons/blob/master/CHANGELOG.md" target="_blank" rel="noopener">the Log</a> for every change.
      </div>

      <div class="nc-footer">
        <a href="/portal#/developers">API Reference</a>
        <a href="/llms.txt">AI-Readable Docs</a>
        <a href="https://github.com/The-Relational-Technology-Project/neighborhood-api" target="_blank" rel="noopener">Neighborhood API Spec</a>
        <a href="https://github.com/joinfiber/neighborhood-commons" target="_blank" rel="noopener">GitHub</a>
        <a href="/portal#/login">Contributor Sign In</a>
        <div style="flex:1"></div>
        <span style="color:var(--nc-dim);">CC BY 4.0 &middot; MIT &middot; hi@neighborhood-commons.org</span>
      </div>
    </main>
  </div>
</body>
</html>`);
    } catch (err) {
      next(err);
    }
  });

  // ─── .well-known discovery ───────────────────────────────────────
  app.get('/.well-known/neighborhood', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({
      name: 'Neighborhood Commons',
      version: '0.2',
      license: 'CC-BY-4.0',
      events_url: `${config.apiBaseUrl}/api/v1/events`,
      ical_url: `${config.apiBaseUrl}/api/v1/events.ics`,
      rss_url: `${config.apiBaseUrl}/api/v1/events.rss`,
      terms_url: `${config.apiBaseUrl}/api/v1/events/terms`,
    });
  });

  // ─── Error handler (API errors) ──────────────────────────────────
  app.use(errorHandler);

  // ─── Public static assets (CSS, widget, badges) ────────────────
  const publicDir = path.resolve(__dirname, '../public');
  app.use('/pages.css', express.static(path.join(publicDir, 'pages.css'), { maxAge: '1d', immutable: true }));
  app.use('/widget', express.static(path.join(publicDir, 'widget'), { maxAge: '1h' }));

  // ─── Public HTML pages (events, venues) ────────────────────────
  // Must be before portal SPA fallback so /events/:id and /venues/:slug
  // are handled by server-rendered pages, not the React SPA.
  app.use(pageRoutes);

  // ─── Portal SPA (static files) ─────────────────────────────────
  // Serve the built portal frontend. Must be after API routes and pages
  // so /api/* and /events/* are handled first.
  //
  // Vite produces hashed filenames (index-Ab12Cd.js) — safe to cache
  // forever since the hash changes on every build. But index.html must
  // never be cached: it's the entry point that references the current hash.
  // Without no-cache on index.html, browsers/CDNs serve stale HTML that
  // points to an old JS bundle, and UI changes don't land after deploy.
  const portalDir = path.resolve(__dirname, '../portal');
  app.use('/assets', express.static(path.join(portalDir, 'assets'), { maxAge: '365d', immutable: true }));
  // index: false prevents express.static from serving portal/index.html for "/"
  // — the server-rendered homepage handles that route explicitly above
  app.use(express.static(portalDir, { maxAge: 0, index: false }));

  // SPA fallback: any non-API, non-page route serves index.html
  // (supports client-side hash routing)
  app.get('*', (_req, res, next) => {
    if (_req.path === '/' || _req.path.startsWith('/api/') || _req.path.startsWith('/events/') || _req.path.startsWith('/venues/')) return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(portalDir, 'index.html'), (err) => {
      if (err) next(); // portal not built yet — 404 is fine
    });
  });

  return app;
}
