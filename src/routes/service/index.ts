/**
 * Service API — Router mounter
 *
 * Full CRUD for accounts, events, series, images, and groups via
 * service-tier API keys. Enables trusted external tools (Studio, Merrie,
 * partner admin apps) to manage the commons dataset without needing
 * Supabase JWT auth.
 *
 * Auth: X-API-Key header with contributor_tier='service'. Mounted once
 * at the top here; sub-routers inherit it.
 *
 * Base: /api/v1/service
 *
 * Sub-routers, one per resource (see service/*.ts):
 *   helpers.ts     — assertLinkedAccount, assertLinkedEvent (shared)
 *   accounts.ts    — /accounts/* (6 handlers + /accounts/link)
 *   events.ts      — /events/* single-event CRUD + batch
 *   series.ts      — /events/series/* bulk operations
 *   images.ts      — /events/:id/image, /accounts/:id/cover-image, /accounts/:id/logo
 *   groups.ts      — /groups/* + /groups/:id/venues/* + /events/:id/group
 *   admin-ops.ts   — /stats, /api-keys, /approved-domains, /migrate-image-urls (all isAdmin-gated)
 */

import { Router } from 'express';
import { requireServiceApiKey } from '../../middleware/api-key.js';

import accountsRoutes from './accounts.js';
import eventsRoutes from './events.js';
import seriesRoutes from './series.js';
import imagesRoutes from './images.js';
import groupsRoutes from './groups.js';
import adminOpsRoutes from './admin-ops.js';

const router: ReturnType<typeof Router> = Router();

// All service routes require a service-tier API key
router.use(requireServiceApiKey);

// Sub-routers — mounted at root; each defines its own paths.
// Order: series before events so /events/series/:seriesId matches before /events/:id.
router.use(seriesRoutes);
router.use(accountsRoutes);
router.use(eventsRoutes);
router.use(imagesRoutes);
router.use(groupsRoutes);
router.use(adminOpsRoutes);

export default router;
