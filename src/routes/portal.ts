/**
 * Portal Routes — Neighborhood Commons
 *
 * Re-exports the composed portal router from portal/index.ts.
 * Route handlers live in portal/auth.ts, portal/account.ts,
 * portal/events.ts, portal/images.ts, and portal/import.ts.
 *
 * Shared business logic lives in lib/event-operations.ts,
 * lib/event-series.ts, lib/image-processing.ts, and lib/portal-helpers.ts.
 */

export { default } from './portal/index.js';
