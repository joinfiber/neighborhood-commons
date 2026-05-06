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

import registerRoutes from './register.js';
import accountsRoutes from './accounts.js';
import eventsRoutes from './events.js';
import seriesRoutes from './series.js';
import imagesRoutes from './images.js';
import groupsRoutes from './groups.js';
import adminOpsRoutes from './admin-ops.js';
// 1.0.0 type-system service routes
import placesRoutes from './places.js';
import organizationsRoutes from './organizations.js';
import personsRoutes from './persons.js';
import broadcastsRoutes from './broadcasts.js';
import listsRoutes from './lists.js';
import verificationsRoutes from './verifications.js';
import disputesRoutes from './disputes.js';

const router: ReturnType<typeof Router> = Router();

// Self-service registration is unauthenticated by design — it's the entry
// point for anyone applying for a service-tier key. Mounted BEFORE the
// service-tier auth check below.
router.use('/register', registerRoutes);

// Everything else requires an active service-tier API key.
router.use(requireServiceApiKey);

// Sub-routers — mounted at root; each defines its own paths.
// Order: series before events so /events/series/:seriesId matches before /events/:id.
// Verifications mounted early so /verifications/* matches before any wildcard.
router.use(verificationsRoutes);
router.use(disputesRoutes);
router.use(placesRoutes);
router.use(organizationsRoutes);
router.use(personsRoutes);
router.use(broadcastsRoutes);
router.use(listsRoutes);
router.use(seriesRoutes);
router.use(accountsRoutes);
router.use(eventsRoutes);
router.use(imagesRoutes);
router.use(groupsRoutes);
router.use(adminOpsRoutes);

export default router;
