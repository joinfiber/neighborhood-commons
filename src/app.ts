/**
 * Neighborhood Commons — Express Application
 *
 * Open neighborhood event data service.
 * CC BY 4.0.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import express, { Express } from 'express';
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
import internalRoutes from './routes/internal.js';
import cronRoutes from './routes/cron.js';
import placesRoutes from './routes/places.js';
import developerRoutes from './routes/developers.js';
import contributeRoutes from './routes/contribute.js';
import serviceRoutes from './routes/service.js';
import pageRoutes from './routes/pages.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'neighborhood-commons', timestamp: new Date().toISOString() });
  });

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

  // ─── Internal (service-to-service sync) ──────────────────────────
  app.use('/api/internal', internalRoutes);

  // ─── Cron jobs ───────────────────────────────────────────────────
  app.use('/api/cron', cronRoutes);

  // ─── Developer Registration ─────────────────────────────────────
  app.use('/api/v1/developers', developerRoutes);

  // ─── Contribute API (external app writes) ─────────────────────
  app.use('/api/v1/contribute', contributeRoutes);
  app.use('/api/v1/service', serviceRoutes);

  // ─── Places (venue search for portal) ──────────────────────────
  app.use('/api/places', placesRoutes);

  // ─── Landing page (API domain root) ──────────────────────────────
  // ─── Cached landing page stats (refresh hourly, not per-request) ────
  let cachedStats = { totalEvents: 0, totalVenues: 0, regionName: '', fetchedAt: 0 };
  const STATS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
        ? `<p class="nc-stats">Currently serving <strong>${totalEvents.toLocaleString()} events</strong> across <strong>${totalVenues.toLocaleString()} venues</strong>${regionName ? ` in <strong>${regionName}</strong>` : ''}.</p>`
        : '';

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Neighborhood Commons — Open Event Data Infrastructure</title>
  <meta name="description" content="Every event in the neighborhood, available to every app. Open data infrastructure, CC BY 4.0.">
  <meta property="og:title" content="Neighborhood Commons">
  <meta property="og:description" content="Every event in the neighborhood, available to every app. Open data, free API, CC BY 4.0.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${baseUrl}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/pages.css">
  <style>
    .nc-landing { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; }
    .nc-landing h1 { font-size: 2rem; font-weight: 600; margin-bottom: 12px; line-height: 1.3; }
    .nc-landing .nc-tagline { color: var(--nc-muted); font-size: 1.05rem; margin-bottom: 12px; line-height: 1.6; }
    .nc-landing .nc-stats { color: var(--nc-text); font-size: 1rem; margin-bottom: 40px; }
    .nc-landing .nc-stats strong { color: var(--nc-accent); }
    .nc-landing h2 { font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--nc-dim); margin: 40px 0 16px; }
    .nc-code { background: var(--nc-accent); color: #e8e6e1; border-radius: var(--nc-radius); padding: 20px 24px; font-family: 'DM Mono', monospace; font-size: 0.85rem; line-height: 1.7; overflow-x: auto; margin: 12px 0 24px; }
    .nc-code .nc-dim { color: #9c9791; }
    .nc-code .nc-url { color: #a3d9a5; }
    .nc-endpoints { list-style: none; padding: 0; }
    .nc-endpoints li { padding: 12px 0; border-bottom: 1px solid var(--nc-border); display: flex; gap: 12px; align-items: baseline; }
    .nc-endpoints li:last-child { border-bottom: none; }
    .nc-endpoints code { font-family: 'DM Mono', monospace; font-size: 0.85rem; white-space: nowrap; }
    .nc-endpoints .nc-method { color: var(--nc-dim); font-weight: 500; min-width: 36px; }
    .nc-endpoints .nc-path { font-weight: 500; }
    .nc-endpoints .nc-desc { color: var(--nc-muted); font-size: 0.9rem; margin-left: auto; }
    .nc-links { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0; }
    .nc-links a { display: inline-flex; align-items: center; gap: 6px; padding: 10px 20px; border-radius: var(--nc-radius-sm); font-size: 0.9rem; font-weight: 500; transition: background 0.15s; }
    .nc-links .nc-primary { background: var(--nc-accent); color: #fff; }
    .nc-links .nc-primary:hover { background: #444; text-decoration: none; }
    .nc-links .nc-secondary { background: var(--nc-surface); border: 1px solid var(--nc-border); color: var(--nc-text); }
    .nc-links .nc-secondary:hover { background: var(--nc-cream); text-decoration: none; }
    .nc-stability { background: var(--nc-cream); border-radius: var(--nc-radius); padding: 24px 28px; margin: 16px 0; font-size: 0.9rem; line-height: 1.7; color: var(--nc-text); }
    .nc-stability strong { font-weight: 600; }
    .nc-stability p { margin: 0 0 8px; }
    .nc-stability p:last-child { margin-bottom: 0; }
    .nc-license { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--nc-border); color: var(--nc-muted); font-size: 0.85rem; line-height: 1.6; }
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
      <h1>Every event in the neighborhood, available to every app.</h1>
      <p class="nc-tagline">Open event data infrastructure. Contributed by community members, developers, and organizers. Licensed CC&nbsp;BY&nbsp;4.0 because public facts shouldn't be locked up.</p>
      ${statsLine}

      <h2>Try It Now</h2>
      <div class="nc-code"><span class="nc-dim">$</span> curl <span class="nc-url">"${baseUrl}/api/v1/events?limit=3"</span></div>
      <p style="color:var(--nc-muted);font-size:0.9rem;">No authentication required. Returns JSON. Every event in the commons, right now.</p>

      <h2>Read API</h2>
      <ul class="nc-endpoints">
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/events</span></code> <span class="nc-desc">List events (filter, search, paginate)</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/events/:id</span></code> <span class="nc-desc">Single event</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/events.ics</span></code> <span class="nc-desc">iCalendar feed</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/events.rss</span></code> <span class="nc-desc">RSS feed</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/accounts</span></code> <span class="nc-desc">Search venues (with events via ?include=events)</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/groups</span></code> <span class="nc-desc">Community groups, orgs, curators</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/meta</span></code> <span class="nc-desc">Feed metadata, stats, regions, categories</span></li>
      </ul>

      <h2>Contribute API</h2>
      <p style="color:var(--nc-muted);font-size:0.9rem;margin-bottom:12px;">Push events into the commons with a free API key. Self-service registration&nbsp;&mdash; no approval required.</p>
      <ul class="nc-endpoints">
        <li><code><span class="nc-method">POST</span> <span class="nc-path">/api/v1/contribute</span></code> <span class="nc-desc">Submit an event</span></li>
        <li><code><span class="nc-method">POST</span> <span class="nc-path">/api/v1/contribute/batch</span></code> <span class="nc-desc">Submit up to 50 events</span></li>
        <li><code><span class="nc-method">POST</span> <span class="nc-path">/api/v1/developers/register/send-otp</span></code> <span class="nc-desc">Get your API key</span></li>
      </ul>

      <h2>Contribute Data</h2>
      <p style="color:var(--nc-muted);font-size:0.9rem;margin-bottom:12px;">Have event data to share? Upload a CSV or use the API. Community contributors, developers, and organizers welcome.</p>
      <div class="nc-links">
        <a href="/portal" class="nc-primary">Contributor Portal</a>
        <a href="/llms.txt" class="nc-secondary">API Guide</a>
      </div>

      <h2>Documentation</h2>
      <div class="nc-links">
        <a href="/llms.txt" class="nc-primary">Complete Guide</a>
        <a href="/api/v1/openapi.json" class="nc-secondary">OpenAPI Spec</a>
        <a href="https://github.com/joinfiber/neighborhood-commons" class="nc-secondary">GitHub</a>
      </div>

      <h2>Real-Time</h2>
      <p style="color:var(--nc-muted);font-size:0.9rem;margin-bottom:12px;">Subscribe to event changes via webhooks. HMAC-SHA256 signed. Automatic retries.</p>
      <ul class="nc-endpoints">
        <li><code><span class="nc-method">POST</span> <span class="nc-path">/api/v1/webhooks</span></code> <span class="nc-desc">Create subscription</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/.well-known/neighborhood</span></code> <span class="nc-desc">Auto-discovery</span></li>
      </ul>

      <h2>Stability</h2>
      <div class="nc-stability">
        <p><strong>The v1 API is stable.</strong> We will not make breaking changes to <code>/api/v1/*</code> endpoints without at least 90 days notice. Response shapes, query parameters, and authentication requirements are locked.</p>
        <p>Extension APIs (<code>/portal/*</code>, <code>/service/*</code>) may evolve with shorter notice. These are for operators, not public consumers.</p>
        <p>If we need to break something, we'll bump to v2 and keep v1 running. Your integration won't break overnight.</p>
      </div>

      <h2>Fork It</h2>
      <p style="color:var(--nc-muted);font-size:0.9rem;line-height:1.6;">This is infrastructure designed to be cloned and run by any city. Clone the <a href="https://github.com/joinfiber/neighborhood-commons">repo</a>, stand up a Supabase instance, run the migrations, seed your data. Full setup instructions in the README. If your neighborhood needs a commons, you can have one running today.</p>

      <div class="nc-license">
        <strong>Data:</strong> Creative Commons Attribution 4.0 International (CC BY 4.0)<br>
        <strong>Code:</strong> MIT License<br>
        <strong>Spec:</strong> <a href="https://github.com/The-Relational-Technology-Project/neighborhood-api">Neighborhood API v0.2</a><br>
        <strong>Contact:</strong> hello@joinfiber.app
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
  app.use(express.static(portalDir, { maxAge: 0 }));

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
