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
import { globalLimiter, writeLimiter, metaLimiter } from './middleware/rate-limit.js';

// Routes
import publicRoutes from './routes/public.js';
import v1Routes, { v1Limiter, icsHandler, rssHandler } from './routes/v1.js';
import v1PlacesRoutes, { placesLimiter as v1PlacesLimiter } from './routes/v1-places.js';
import v1OrganizationsRoutes, { organizationsLimiter } from './routes/v1-organizations.js';
import v1PublishersRoutes, { publishersLimiter } from './routes/v1-publishers.js';
import v1BroadcastsRoutes, { broadcastsLimiter } from './routes/v1-broadcasts.js';
import v1ListsRoutes, { listsLimiter } from './routes/v1-lists.js';
import v1ContributorsRoutes, { contributorsLimiter } from './routes/v1-contributors.js';
import v1SeriesRoutes, { seriesLimiter } from './routes/v1-series.js';
import webhookRoutes from './routes/webhooks.js';
import metaRoutes from './routes/meta.js';
import cronRoutes from './routes/cron.js';
import serviceRoutes from './routes/service.js';
import pageRoutes from './routes/pages.js';
import dmcaRoutes, { dmcaHtmlHandler } from './routes/dmca.js';
import reportRoutes from './routes/report.js';
import developersRoutes from './routes/developers.js';
import operatorRoutes from './routes/operator.js';
import docsRoutes from './routes/docs.js';


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

  // Canonical host is the apex: neighborhood-commons.org. The api.* subdomain
  // exists for back-compat (1.0 SDK consumers, anyone who pinned the old
  // URL) — every request to api.* gets a 308 permanent redirect to the
  // apex, preserving method and body. The browser / fetch / curl -L all
  // follow it transparently. Once consumers update their base URLs at
  // their own pace, the redirect never fires.
  //
  // Has to run early — before route handlers and body parsing — so we
  // don't waste work on requests we're about to redirect.
  app.use((req, res, next) => {
    if (req.hostname === 'api.neighborhood-commons.org') {
      return res.redirect(308, `https://neighborhood-commons.org${req.originalUrl}`);
    }
    next();
  });

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Every Commons-served HTML surface (homepage, developer/operator
          // portals, docs) self-hosts its fonts from /fonts/*.woff2, which
          // 'self' covers — so no Google Fonts origins are listed. Don't
          // re-add a Google Fonts <link> to any of these pages; self-host via
          // src/lib/self-hosted-fonts.ts instead (the woff2 files are there).
          // jsdelivr is allowed for the /spec page's Scalar API reference:
          //   script-src   the bundle itself
          //   style-src    Scalar injects a runtime stylesheet
          //   font-src     Inter + JetBrains Mono shipped inside the bundle
          //   connect-src  Scalar fetches companion assets lazily
          styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
          fontSrc: ["'self'", 'https://cdn.jsdelivr.net'],
          scriptSrc: ["'self'", 'https://challenges.cloudflare.com', 'https://static.cloudflareinsights.com', 'https://cdn.jsdelivr.net'],
          frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
          connectSrc: ["'self'", config.supabase.url, 'https://places.googleapis.com', 'https://cdn.jsdelivr.net'],
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
  app.use('/llms.txt', publicCors);
  // Widget JS and badges must load from any origin
  app.use('/widget', publicCors);
  app.use('/pages.css', publicCors);
  // The embeddable widget runs on third-party pages and self-hosts DM Sans via
  // an @font-face pointing at this origin's /fonts/*.woff2. Cross-origin font
  // fetches are always CORS-mode, so the font response needs Access-Control-
  // Allow-Origin (CORP, set globally via helmet, is not enough). Without this
  // the embedded widget would fall back to system fonts on every host page.
  app.use('/fonts', publicCors);

  // Restricted CORS for webhooks, internal, cron routes
  app.use('/api/webhooks', privateCors);
  app.use('/api/internal', privateCors);
  app.use('/api/cron', privateCors);

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
  // Two routes for the same file: /openapi.json is the conventional
  // location (and what every link in the homepage points at);
  // /api/v1/openapi.json is kept for backward-compatibility with any
  // consumer that already pinned the versioned path. Without an
  // explicit /openapi.json route, the request falls through to the
  // Portal SPA catch-all and serves an HTML "login page," which was
  // confusing every visitor who clicked the "Spec" link.
  const openapiHandler = (_req: import('express').Request, res: import('express').Response) => {
    res.sendFile(path.join(__dirname, '../public/openapi.json'), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  app.get('/openapi.json', openapiHandler);
  app.get('/api/v1/openapi.json', openapiHandler);

  // ─── Rendered spec viewer (human-readable) ──────────────────────
  // /spec is the human-friendly view: a Scalar-rendered, navigable
  // version of the spec. /openapi.json stays as the raw JSON for
  // tooling. The homepage's "Spec" topnav link points at /spec so
  // visitors land on something legible.
  app.get('/spec', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/spec.html'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  });

  // ─── Public Data API ─────────────────────────────────────────────
  app.use('/api/events', publicRoutes);

  // ─── Neighborhood API v2 ─────────────────────────────────────────
  // v2 surface: 5 typed primitives (places, organizations, events,
  // broadcasts, lists) plus the publishers view (organizations that
  // have published something). Person, verifiers, groups, accounts,
  // contribute routes were retired in v2.
  app.use('/api/v1/events', v1Limiter, v1Routes);
  app.use('/api/v1/places', v1PlacesLimiter, v1PlacesRoutes);
  app.use('/api/v1/organizations', organizationsLimiter, v1OrganizationsRoutes);
  app.use('/api/v1/publishers', publishersLimiter, v1PublishersRoutes);
  app.use('/api/v1/broadcasts', broadcastsLimiter, v1BroadcastsRoutes);
  app.use('/api/v1/lists', listsLimiter, v1ListsRoutes);
  app.use('/api/v1/contributors', contributorsLimiter, v1ContributorsRoutes);
  app.use('/api/v1/series', seriesLimiter, v1SeriesRoutes);

  // iCal + RSS feeds (mounted at /api/v1/ level)
  app.get('/api/v1/events.ics', icsHandler);
  app.get('/api/v1/events.rss', rssHandler);

  // ─── Meta (regions, categories) ──────────────────────────────────
  app.use('/api/v1/meta', metaLimiter, metaRoutes);
  app.use('/api/meta', metaLimiter, metaRoutes);

  // ─── Webhooks ────────────────────────────────────────────────────
  app.use('/api/v1/webhooks', webhookRoutes);
  app.use('/api/webhooks', webhookRoutes);

  // ─── Cron jobs ───────────────────────────────────────────────────
  app.use('/api/cron', cronRoutes);

  // ─── Service API (external app writes) ─────────────────────
  // Registrations go through /api/v1/service/register/*; writes through
  // /api/v1/service/* with organizer authority enforcement.
  app.use('/api/v1/service', serviceRoutes);

  // ─── DMCA / takedown surfaces ─────────────────────────────────
  // /dmca renders the human-readable HTML page; /api/v1/dmca returns
  // the same content as JSON for tooling. /api/v1/report accepts
  // public, captcha-gated takedown reports — anyone can file (no API
  // key required), which is the right shape for safe-harbor.
  app.get('/dmca', dmcaHtmlHandler);
  app.use('/api/v1/dmca', dmcaRoutes);
  app.use('/api/v1/report', writeLimiter, reportRoutes);

  // ─── Developer Portal (server-rendered HTML) ─────────────────────
  // Self-service registration, OTP verify, dashboard. The foundation
  // (PR 1) added the schema + public read at /v1/contributors. PR 2
  // (this) adds the user-facing form flow at /developers/*.
  app.use('/developers', developersRoutes);

  // ─── Operator Portal (server-rendered HTML, env-var gated) ─────
  // Internal review surface for the operator(s) listed in
  // COMMONS_OPERATOR_EMAIL. Returns 404 to anyone not on the allowlist
  // — the route's existence is not leaked. Approves/rejects pending
  // service-tier registrations.
  app.use('/operator', operatorRoutes);

  // ─── Public docs (server-rendered markdown) ─────────────────────
  // /docs/:slug renders an allowlisted file from /docs/{slug}.md.
  // Listed under "what's public" in src/routes/docs.ts — internal
  // design docs (onboarding-redesign, launch-runbook) stay off the list.
  app.use('/docs', docsRoutes);

  // ─── Landing page (server-rendered, instant load, no JS) ───────────
  let cachedStats = {
    totalEvents: 0,
    firstPartyEvents: 0,
    totalOrganizations: 0,
    verifiedOrganizations: 0,
    totalPlaces: 0,
    regionName: '',
    fetchedAt: 0,
  };
  const STATS_TTL_MS = 24 * 60 * 60 * 1000;

  async function getLandingStats() {
    if (Date.now() - cachedStats.fetchedAt < STATS_TTL_MS) return cachedStats;
    try {
      const [eventResult, firstPartyResult, orgResult, placeResult, regionResult, verifiedRows] = await Promise.all([
        supabaseAdmin.from('events').select('id', { count: 'exact', head: true }).eq('status', 'published'),
        supabaseAdmin.from('events').select('id', { count: 'exact', head: true }).eq('status', 'published').eq('first_party', true),
        supabaseAdmin.from('organizations').select('id', { count: 'exact', head: true }),
        supabaseAdmin.from('places').select('id', { count: 'exact', head: true }),
        supabaseAdmin.from('regions').select('name').eq('is_active', true).limit(1).maybeSingle(),
        supabaseAdmin.from('organization_verifications').select('organization_id').eq('status', 'active'),
      ]);
      const verifiedOrgIds = new Set(((verifiedRows.data || []) as Array<{ organization_id: string }>).map(r => r.organization_id));
      cachedStats = {
        totalEvents: eventResult.count || 0,
        firstPartyEvents: firstPartyResult.count || 0,
        totalOrganizations: orgResult.count || 0,
        verifiedOrganizations: verifiedOrgIds.size,
        totalPlaces: placeResult.count || 0,
        regionName: regionResult.data?.name || '',
        fetchedAt: Date.now(),
      };
    } catch { /* stats are optional — stale cache is fine */ }
    return cachedStats;
  }

  // Load the homepage template once at boot. The template lives in
  // public/index.html and uses {{baseUrl}} / {{statsLine}} / {{specVersion}}
  // placeholders; all are substituted per request.
  const indexTemplatePath = path.resolve(__dirname, '../public/index.html');
  let indexTemplate = '';
  try {
    indexTemplate = readFileSync(indexTemplatePath, 'utf-8');
  } catch (err) {
    console.warn('[LANDING] Failed to read public/index.html:', err);
  }

  // Single source of truth for the displayed spec version: read info.version
  // from openapi.json at boot rather than hardcoding it in the HTML. The
  // hardcoded value silently drifted once (sat at 3.0.0 through the entire
  // 3.1.x line). openapi.json only changes on deploy and the server restarts
  // on deploy, so a boot-time read always matches the served spec.
  let specVersion = '';
  try {
    const openapiRaw = readFileSync(path.resolve(__dirname, '../public/openapi.json'), 'utf-8');
    specVersion = (JSON.parse(openapiRaw)?.info?.version as string) ?? '';
  } catch (err) {
    console.warn('[LANDING] Failed to read spec version from openapi.json:', err);
  }

  app.get('/', async (_req, res, next) => {
    try {
      const baseUrl = config.apiBaseUrl || 'https://neighborhood-commons.org';
      const {
        totalEvents,
        firstPartyEvents,
        totalOrganizations,
        verifiedOrganizations,
        totalPlaces,
        regionName,
      } = await getLandingStats();

      // Surface the two-tier reality honestly: aggregate count first, then a
      // dim sub-line breaking it into public-facts vs first-party. The
      // breakdown converts what would otherwise read as embarrassment ("0
      // verified businesses!") into a visible roadmap state ("first-party
      // tier is bootstrapping — early apps welcome").
      const publicFactsEvents = Math.max(0, totalEvents - firstPartyEvents);
      const statsLine = totalEvents > 0
        ? `<span class="nc-stats">Currently serving <strong>${totalEvents.toLocaleString()} events</strong> across <strong>${totalOrganizations.toLocaleString()} organizations</strong> and <strong>${totalPlaces.toLocaleString()} places</strong>${regionName ? ` in <strong>${regionName}</strong>` : ''}.</span>` +
          `<span class="nc-stats nc-stats-tier">${publicFactsEvents.toLocaleString()} public-facts · ${firstPartyEvents.toLocaleString()} first-party · ${verifiedOrganizations.toLocaleString()} verified businesses. First-party tier is bootstrapping — early apps welcome.</span>`
        : '';

      if (!indexTemplate) {
        // Template unavailable — render a minimal fallback so the route
        // still responds. Should only happen if public/index.html went missing.
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!DOCTYPE html><html><head><title>Neighborhood Commons</title></head><body style="font-family:system-ui;max-width:640px;margin:80px auto;padding:0 24px;color:#37352f;"><h1>Neighborhood Commons</h1><p>Open neighborhood data infrastructure. The homepage is temporarily unavailable. The API is at <code>${baseUrl}/api/v1/events</code> and the spec is at <a href="/openapi.json">/openapi.json</a>.</p></body></html>`);
        return;
      }

      const html = indexTemplate
        .replace(/\{\{baseUrl\}\}/g, baseUrl)
        .replace('{{statsLine}}', statsLine)
        .replace(/\{\{specVersion\}\}/g, specVersion);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(html);
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
  // Self-hosted woff2 fonts (DM Sans / DM Mono / DM Serif Display, latin
  // subsets only). Filenames are stable — bumping a font version means
  // replacing the file, which is rare. 1y immutable cache because the
  // homepage CSS hard-references the filename, so any swap will show up
  // as a `git diff` and be easy to reason about.
  app.use('/fonts', express.static(path.join(publicDir, 'fonts'), { maxAge: '1y', immutable: true }));

  // ─── Public HTML pages (events, venues) ────────────────────────
  // Must be before portal SPA fallback so /events/:id and /venues/:slug
  // are handled by server-rendered pages, not the React SPA.
  app.use(pageRoutes);

  // 404 fallback: any request that didn't match a route above gets a
  // proper 404, not the Portal SPA. Skips /api/* — those are handled by
  // the global error handler with the canonical { error } shape.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.status(404).setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '../public/404.html'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }, (err) => {
      if (err) next();
    });
  });

  return app;
}
