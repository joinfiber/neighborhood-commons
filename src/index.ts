/**
 * Neighborhood Commons — API Server
 *
 * Open neighborhood event data service.
 * CC BY 4.0.
 */

import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`[COMMONS] Neighborhood Commons running on port ${config.port}`);
  console.log(`[COMMONS] CORS origins: ${config.cors.origins.join(', ')}`);
  if (!config.captcha.enabled) {
    console.warn('[COMMONS] CAPTCHA disabled — registration protected by rate limiting only. Set CAPTCHA_ENABLED=true and TURNSTILE_SECRET_KEY for production.');
  }
});

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[COMMONS] ${signal} received, shutting down gracefully`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
