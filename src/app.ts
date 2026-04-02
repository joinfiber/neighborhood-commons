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
  app.get('/', (_req, res) => {
    const baseUrl = config.apiBaseUrl || 'https://api.neighborhood-commons.org';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Neighborhood Commons — Open Event Data Infrastructure</title>
  <meta name="description" content="A shared, open database of neighborhood events. Free to read, free to contribute. CC BY 4.0.">
  <meta property="og:title" content="Neighborhood Commons">
  <meta property="og:description" content="Open event data infrastructure. One API, every neighborhood event.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${baseUrl}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/pages.css">
  <style>
    .nc-landing { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; }
    .nc-landing h1 { font-size: 1.75rem; font-weight: 600; margin-bottom: 8px; }
    .nc-landing .nc-tagline { color: var(--nc-muted); font-size: 1.05rem; margin-bottom: 40px; line-height: 1.5; }
    .nc-landing h2 { font-size: 1rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--nc-dim); margin: 40px 0 16px; }
    .nc-landing h2:first-of-type { margin-top: 0; }
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
      <h1>Open Event Data Infrastructure</h1>
      <p class="nc-tagline">A shared, open database of neighborhood events. Not an app&nbsp;&mdash; plumbing.<br>Free to read. Free to contribute. All data is CC&nbsp;BY&nbsp;4.0.</p>

      <h2>Try It Now</h2>
      <div class="nc-code"><span class="nc-dim">$</span> curl <span class="nc-url">"${baseUrl}/api/v1/events?limit=3"</span></div>
      <p style="color:var(--nc-muted);font-size:0.9rem;">No authentication required. Returns JSON. Every event in the commons, right now.</p>

      <h2>Read API</h2>
      <ul class="nc-endpoints">
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/events</span></code> <span class="nc-desc">List events (filter, search, paginate)</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/events/:id</span></code> <span class="nc-desc">Single event</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/events.ics</span></code> <span class="nc-desc">iCalendar feed</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/events.rss</span></code> <span class="nc-desc">RSS feed</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/accounts</span></code> <span class="nc-desc">Search venues</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/api/v1/meta</span></code> <span class="nc-desc">Feed metadata, license, regions</span></li>
      </ul>

      <h2>Contribute API</h2>
      <p style="color:var(--nc-muted);font-size:0.9rem;margin-bottom:12px;">Push events into the commons with a free API key. Self-service registration&nbsp;&mdash; no approval required.</p>
      <ul class="nc-endpoints">
        <li><code><span class="nc-method">POST</span> <span class="nc-path">/api/v1/contribute</span></code> <span class="nc-desc">Submit an event</span></li>
        <li><code><span class="nc-method">POST</span> <span class="nc-path">/api/v1/contribute/batch</span></code> <span class="nc-desc">Submit up to 50 events</span></li>
        <li><code><span class="nc-method">POST</span> <span class="nc-path">/api/v1/developers/register/send-otp</span></code> <span class="nc-desc">Get your API key</span></li>
      </ul>

      <h2>Documentation</h2>
      <div class="nc-links">
        <a href="/llms.txt" class="nc-primary">Complete Guide (llms.txt)</a>
        <a href="/api/v1/openapi.json" class="nc-secondary">OpenAPI Spec</a>
        <a href="https://github.com/joinfiber/neighborhood-commons" class="nc-secondary">GitHub</a>
      </div>

      <h2>Real-Time</h2>
      <p style="color:var(--nc-muted);font-size:0.9rem;margin-bottom:12px;">Subscribe to event changes via webhooks. HMAC-SHA256 signed. Automatic retries.</p>
      <ul class="nc-endpoints">
        <li><code><span class="nc-method">POST</span> <span class="nc-path">/api/v1/webhooks</span></code> <span class="nc-desc">Create subscription</span></li>
        <li><code><span class="nc-method">GET</span> <span class="nc-path">/.well-known/neighborhood</span></code> <span class="nc-desc">Auto-discovery</span></li>
      </ul>

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
  });

  // ─── .well-known discovery ───────────────────────────────────────
  app.get('/.well-known/neighborhood', (_req, res) => {
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
