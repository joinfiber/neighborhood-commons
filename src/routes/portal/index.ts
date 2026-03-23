/**
 * Portal Routes — Neighborhood Commons
 *
 * Composes portal sub-routers into a single router mounted at /api/portal.
 * Auth middleware applied per-group: auth routes are public (rate-limited),
 * all other routes require portal authentication.
 */

import { Router } from 'express';
import { requirePortalAuth } from '../../middleware/auth.js';

import authRoutes from './auth.js';
import accountRoutes from './account.js';
import eventRoutes from './events.js';
import imageRoutes from './images.js';
import importRoutes from './import.js';

const router: ReturnType<typeof Router> = Router();

// Pre-auth routes (public, rate-limited)
router.use(authRoutes);

// Public image serving (no auth required — event images are public data)
// The image upload route inside imageRoutes uses requirePortalAuth per-handler
router.get('/events/:id/image', imageRoutes);

// All routes below require portal authentication
router.use(requirePortalAuth);
router.use(accountRoutes);
router.use(eventRoutes);
router.use(imageRoutes);
router.use(importRoutes);

export default router;
