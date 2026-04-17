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
  let cachedStats = { totalEvents: 0, totalVenues: 0, regionName: '', fetchedAt: 0 };
  const STATS_TTL_MS = 24 * 60 * 60 * 1000;

  async function getLandingStats() {
    if (Date.now() - cachedStats.fetchedAt < STATS_TTL_MS) return cachedStats;
    try {
      const [eventResult, venueResult, regionResult] = await Promise.all([
        supabaseAdmin.from('events').select('id', { count: 'exact', head: true }).eq('status', 'published'),
        supabaseAdmin.from('portal_accounts').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        supabaseAdmin.from('regions').select('name').eq('is_active', true).limit(1).maybeSingle(),
      ]);
      cachedStats = {
        totalEvents: eventResult.count || 0,
        totalVenues: venueResult.count || 0,
        regionName: regionResult.data?.name || '',
        fetchedAt: Date.now(),
      };
    } catch { /* stats are optional — stale cache is fine */ }
    return cachedStats;
  }

  app.get('/', async (_req, res, next) => {
    try {
      const baseUrl = config.apiBaseUrl || 'https://api.neighborhood-commons.org';
      const { totalEvents, totalVenues, regionName } = await getLandingStats();

      const statsLine = totalEvents > 0
        ? `Currently serving <strong>${totalEvents.toLocaleString()} events</strong> across <strong>${totalVenues.toLocaleString()} venues</strong>${regionName ? ` in <strong>${regionName}</strong>` : ''}.`
        : '';

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Neighborhood Commons — Open Event Data</title>
  <meta name="description" content="A public database of neighborhood events. Read for free. Contribute via CSV or API. CC BY 4.0.">
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
        <div class="nc-label">neighborhood commons</div>
        <h1>The neighborhood&rsquo;s event data, available to everyone.</h1>
        <p>
          A band plays at a bar on Thursday. A yoga class meets in the park on Saturday. A food pantry opens its doors every other Wednesday. These are public facts. The Commons collects them so anyone can build with them.
          ${statsLine ? `<span class="nc-stats">${statsLine}</span>` : ''}
        </p>
      </div>

      <div class="nc-case">
        <div class="nc-case-point">
          <div class="nc-case-heading">Public data is already public</div>
          <p>Every event posted to a venue&rsquo;s Instagram, a community board, or a ticketing site is already out there. The question isn&rsquo;t whether this information should be available &mdash; it&rsquo;s whether a hundred apps should each scrape it separately, or whether we can assemble it once and share.</p>
        </div>
        <div class="nc-case-point">
          <div class="nc-case-heading">Shared data makes neighborhoods more capable</div>
          <p>When event data flows freely, a developer can build a nightlife guide. A newspaper can power a community calendar. A civic group can track neighborhood vitality. A parent can find every story time within walking distance. None of these require permission from a platform &mdash; just access to the facts.</p>
        </div>
        <div class="nc-case-point">
          <div class="nc-case-heading">Contributing is participation, not sacrifice</div>
          <p>Adding your data to the Commons doesn&rsquo;t diminish it. It connects it. Your events reach audiences you&rsquo;d never reach alone, through apps you didn&rsquo;t build and channels you didn&rsquo;t know existed. The more complete the picture, the more alive the neighborhood feels to everyone in it.</p>
        </div>
      </div>

      <div class="nc-ctas">
        <div class="nc-cta">
          <div class="nc-cta-label">Upload data</div>
          <p>Have a spreadsheet of events, food pantries, or community resources? Upload a CSV &mdash; we'll map the columns and you confirm.</p>
          <a href="/portal#/login" class="nc-btn nc-btn-primary">Sign in to upload</a>
        </div>
        <div class="nc-cta">
          <div class="nc-cta-label">Build with the API</div>
          <p>Pull events into your app. Push events back. No API key required to read.</p>
          <a href="/portal#/developers" class="nc-btn nc-btn-secondary">Get an API key</a>
        </div>
      </div>

      <div class="nc-label">Try it now</div>
      <div class="nc-code">$ curl "${baseUrl}/api/v1/events?limit=3"

# By category
$ curl "${baseUrl}/api/v1/events?category=live-music"

# Near a location
$ curl "${baseUrl}/api/v1/events?near=39.97,-75.14&radius_km=2"

# Calendar feed
${baseUrl}/api/v1/events.ics</div>
      <p class="nc-dim-note">No authentication required. Returns JSON. Also available as .ics and .rss feeds.</p>

      <div class="nc-label">What's in the data</div>
      <p class="nc-prose">An event is a public fact. Something happens, somewhere, at some time. The Commons stores the essentials and serves them to anyone who asks.</p>
      <div class="nc-grid">
        <div class="nc-grid-item"><span class="nc-grid-label">What</span><span class="nc-grid-desc">Name and description</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">Where</span><span class="nc-grid-desc">Venue, address, coordinates</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">When</span><span class="nc-grid-desc">Start time, end time, timezone</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">How much</span><span class="nc-grid-desc">Free, $10, $5&ndash;15</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">Category</span><span class="nc-grid-desc">One of 20 structured types</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">Link</span><span class="nc-grid-desc">Event page, tickets, or listing URL</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">Image</span><span class="nc-grid-desc">Cover photo per event, logo per venue</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">Recurrence</span><span class="nc-grid-desc">Weekly, monthly, custom patterns</span></div>
        <div class="nc-grid-item"><span class="nc-grid-label">Tags</span><span class="nc-grid-desc">Access, vibe, format descriptors</span></div>
      </div>
      <p class="nc-dim-note">Every event response is self-contained. No joins, no implicit knowledge, no extra calls.</p>

      <div class="nc-label">Read API</div>
      <div class="nc-ep-list">
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/events</span><span class="nc-ep-desc">List events (filter, search, paginate)</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/events/:id</span><span class="nc-ep-desc">Single event by ID</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/events.ics</span><span class="nc-ep-desc">iCalendar feed</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/events.rss</span><span class="nc-ep-desc">RSS 2.0 feed</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/accounts</span><span class="nc-ep-desc">Search venues</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/groups</span><span class="nc-ep-desc">Community groups and orgs</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/meta</span><span class="nc-ep-desc">Metadata, stats, regions, categories</span></div>
      </div>
      <p class="nc-dim-note">Rate limit: 1,000 requests/hour per IP (or per API key). <a href="/portal#/developers">Full API reference &rarr;</a></p>

      <div class="nc-label">Contribute API</div>
      <p class="nc-prose">Push events into the commons with your API key. New keys start at <strong>pending</strong> (events enter review). Upgrades to auto-publish are manual.</p>
      <div class="nc-ep-list">
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-post">POST</span><span class="nc-ep-path">/api/v1/contribute</span><span class="nc-ep-auth">key</span><span class="nc-ep-desc">Submit an event</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-post">POST</span><span class="nc-ep-path">/api/v1/contribute/batch</span><span class="nc-ep-auth">key</span><span class="nc-ep-desc">Submit up to 50 events</span></div>
        <div class="nc-ep"><span class="nc-ep-method nc-ep-method-get">GET</span><span class="nc-ep-path">/api/v1/contribute/mine</span><span class="nc-ep-auth">key</span><span class="nc-ep-desc">List your submitted events</span></div>
      </div>
      <div class="nc-code">curl -X POST ${baseUrl}/api/v1/contribute \\
  -H "X-API-Key: nc_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Open Mic Night",
    "start": "2026-04-15T19:00:00-04:00",
    "timezone": "America/New_York",
    "category": "open-mic",
    "location": { "name": "The Coffee Shop" }
  }'</div>
      <p class="nc-dim-note"><a href="/portal#/developers">Full contribute docs &rarr;</a></p>

      <div class="nc-label">Real-time webhooks</div>
      <p class="nc-prose">
        Subscribe to <code>event.created</code>, <code>event.updated</code>, and <code>event.deleted</code>.
        HMAC-SHA256 signed. Automatic retries.
        <a href="/portal#/developers">Webhook setup guide &rarr;</a>
      </p>

      <div class="nc-label">Expressions of the Commons</div>
      <p class="nc-prose">The data is open and the use cases are unlimited. These are some of the ways it's already being put to work.</p>
      <div class="nc-app"><a href="https://merrie.co" target="_blank" rel="noopener">merrie.co &nearr;</a><p>Curators discover and organize events. Venue pages are built automatically. The easiest way for non-developers to interact with Commons data.</p></div>
      <div class="nc-app"><a href="https://joinfiber.app" target="_blank" rel="noopener">Fiber &nearr;</a><p>A mobile app for social event discovery. Browse feeds, share plans with friends, find what's on tonight. Same data, different experience.</p></div>
      <div class="nc-app nc-app-placeholder"><span style="font-size:0.9rem;font-weight:500;color:var(--nc-dim);">Yours</span><p>A nightlife guide. A community calendar. A civic dashboard. A newsletter. Whatever your audience, the data is here.</p></div>

      <div class="nc-label">How this is built</div>
      <p class="nc-prose">The Commons is thin on purpose. It stores data and serves it. It doesn&rsquo;t editorialize, recommend, or curate. Those are the concerns of the apps that build on top. The Commons is plumbing &mdash; and good plumbing doesn&rsquo;t change with the winds.</p>
      <p class="nc-prose" style="color:var(--nc-dim);">Row Level Security on every table. Zod validation on every input. Images re-encoded through Sharp. No ORMs, no magic. Every behavior is traceable from the route handler to the database query to the response. The <a href="https://github.com/joinfiber/neighborhood-commons" target="_blank" rel="noopener">source is open</a> and written to be read by skeptics.</p>

      <div class="nc-stability">
        <strong>The v1 API is stable.</strong> Breaking changes to <code>/api/v1/*</code> require 90+ days notice. Response shapes, query parameters, and auth requirements are locked.
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
