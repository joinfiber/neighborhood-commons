/**
 * Admin Routes — Neighborhood Commons
 *
 * Composes admin sub-routers into a single router mounted at /api/admin.
 * All routes require Commons Admin authentication (JWT + admin user ID check).
 */

import { Router } from 'express';
import { requireCommonsAdmin } from '../../middleware/auth.js';

import accountRoutes from './accounts.js';
import eventRoutes from './events.js';
import apiKeyRoutes from './api-keys.js';
import ingestionRoutes from './ingestion.js';

const router: ReturnType<typeof Router> = Router();

// All admin routes require Commons Admin auth
router.use(requireCommonsAdmin);

router.use(accountRoutes);
router.use(eventRoutes);
router.use(apiKeyRoutes);
router.use(ingestionRoutes);

export default router;
