/**
 * The Fiber Commons — Express Application
 *
 * Standalone public events data service.
 * Serves structured, openly accessible event data for a place.
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
import browseRoutes from './routes/browse.js';
import portalRoutes from './routes/portal.js';
import adminRoutes from './routes/admin.js';
import v1Routes, { v1Limiter, icsHandler, rssHandler } from './routes/v1.js';
import webhookRoutes from './routes/webhooks.js';
import metaRoutes from './routes/meta.js';
import internalRoutes from './routes/internal.js';
import cronRoutes from './routes/cron.js';
import placesRoutes from './routes/places.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();

  // Trust proxy (Railway/cloud)
  app.set('trust proxy', 1);

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
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

  // CORS
  app.use(
    cors({
      origin: config.cors.origins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Cron-Secret'],
      credentials: true,
    })
  );

  // Response compression
  app.use(compression());

  // Body parsing
  app.use(express.json({ limit: '5mb' }));

  // Global rate limit
  app.use(globalLimiter);

  // ─── Health check (no auth) ──────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'fiber-commons', timestamp: new Date().toISOString() });
  });

  // ─── Public Data API ─────────────────────────────────────────────
  app.use('/api/events', publicRoutes);

  // ─── Browse (anonymous counters) ─────────────────────────────────
  app.use('/api/browse', browseRoutes);

  // ─── Portal (business CRUD) ──────────────────────────────────────
  app.use('/api/portal', portalRoutes);

  // ─── Commons Admin ───────────────────────────────────────────────
  app.use('/api/admin', adminRoutes);

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

  // ─── Places (venue search for portal) ──────────────────────────
  app.use('/api/places', placesRoutes);

  // ─── .well-known discovery ───────────────────────────────────────
  app.get('/.well-known/neighborhood', (_req, res) => {
    res.json({
      name: 'Fiber Commons',
      version: '0.2',
      events_url: `${config.apiBaseUrl}/api/v1/events`,
      ical_url: `${config.apiBaseUrl}/api/v1/events.ics`,
      rss_url: `${config.apiBaseUrl}/api/v1/events.rss`,
      terms_url: `${config.apiBaseUrl}/api/v1/events/terms`,
      docs_url: `${config.apiBaseUrl}/api/v1/developers`,
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
