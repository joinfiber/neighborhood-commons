/**
 * The Fiber Commons — API Server
 *
 * Standalone public events data service.
 * Serves structured, openly accessible event data for a place.
 */

import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`[COMMONS] Fiber Commons API running on port ${config.port}`);
  console.log(`[COMMONS] CORS origins: ${config.cors.origins.join(', ')}`);
});

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[COMMONS] ${signal} received, shutting down gracefully`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
