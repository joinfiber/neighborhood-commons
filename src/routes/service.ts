/**
 * Service API — Neighborhood Commons
 *
 * Re-exports the composed service router from service/index.ts.
 * Route handlers live in service/accounts.ts, service/events.ts,
 * service/series.ts, service/images.ts, service/groups.ts, and
 * service/admin-ops.ts. Shared helpers in service/helpers.ts.
 *
 * Auth: X-API-Key header with contributor_tier='service'
 * Base: /api/v1/service
 */

export { default } from './service/index.js';
