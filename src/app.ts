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
import webhookRoutes from './routes/webhooks.js';
import metaRoutes from './routes/meta.js';
import internalRoutes from './routes/internal.js';
import cronRoutes from './routes/cron.js';
import placesRoutes from './routes/places.js';
import developerRoutes from './routes/developers.js';

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

  // ─── Public Data API ─────────────────────────────────────────────
  app.use('/api/events', publicRoutes);

  // ─── Portal (business CRUD) ──────────────────────────────────────
  app.use('/api/portal', portalRoutes);

  // ─── Commons Admin ───────────────────────────────────────────────
  app.use('/api/admin', adminRoutes);
  app.use('/api/portal/admin', adminRoutes);

  // ─── Neighborhood API v1 ─────────────────────────────────────────
  app.use('/api/v1/events', v1Limiter, v1Routes);

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

  // ─── Places (venue search for portal) ──────────────────────────
  app.use('/api/places', placesRoutes);

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

  // ─── Portal SPA (static files) ─────────────────────────────────
  // Serve the built portal frontend. Must be after API routes
  // so /api/* is handled by Express, not the SPA.
  const portalDir = path.resolve(__dirname, '../portal');
  app.use(express.static(portalDir, { maxAge: '1h' }));

  // SPA fallback: any non-API route serves index.html
  // (supports client-side hash routing)
  app.get('*', (_req, res, next) => {
    if (_req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(portalDir, 'index.html'), (err) => {
      if (err) next(); // portal not built yet — 404 is fine
    });
  });

  return app;
}
