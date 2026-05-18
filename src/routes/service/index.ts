/**
 * Service API — Router mounter (v2)
 *
 * CRUD over the v2 primitives: events, organizations, places, broadcasts,
 * lists, verifications, plus operational endpoints for accounts and
 * platform admin. Service-tier keys authorize via X-API-Key.
 *
 * Auth: X-API-Key header with contributor_tier='service'. Mounted once
 * at the top here; sub-routers inherit it.
 *
 * Base: /api/v1/service
 *
 * Sub-routers, one per resource (see service/*.ts):
 *   helpers.ts        — assertLinkedAccount, assertLinkedEvent
 *   helpers-v1.ts     — assertLinkedOrganization (org-scoped)
 *   accounts.ts       — /accounts/* operational (email + claim state)
 *   events.ts         — /events/* CRUD with organizer-org scope
 *   series.ts         — /events/series/* bulk operations
 *   images.ts         — /events/:id/image (org logos via /organizations/:id/logo)
 *   organizations.ts  — /organizations/* CRUD + linking
 *   admin-ops.ts      — /stats, /api-keys, /approved-domains (isAdmin-gated)
 */

import { Router } from 'express';
import { requireServiceApiKey } from '../../middleware/api-key.js';

// `accounts` is the operational tenant shell — email + claim state.
// Writeable scope lives in api_key_organization_links, established via
// /service/organizations/link.
import registerRoutes from './register.js';
import accountsRoutes from './accounts.js';
import eventsRoutes from './events.js';
import seriesRoutes from './series.js';
import imagesRoutes from './images.js';
import adminOpsRoutes from './admin-ops.js';
// v2 type-system service routes
import placesRoutes from './places.js';
import organizationsRoutes from './organizations.js';
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
router.use(broadcastsRoutes);
router.use(listsRoutes);
router.use(seriesRoutes);
router.use(accountsRoutes);
router.use(eventsRoutes);
router.use(imagesRoutes);
router.use(adminOpsRoutes);

export default router;
