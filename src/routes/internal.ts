/**
 * Internal Routes — The Fiber Commons
 *
 * Service-to-service endpoints for sync consumers (e.g., Fiber social API).
 * Authenticated via COMMONS_SERVICE_KEY (Bearer token).
 *
 * Also serves the public health check endpoint.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireServiceKey } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest } from '../lib/helpers.js';

const router: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const syncQuerySchema = z.object({
  since: z.string().datetime({ message: 'since must be a valid ISO 8601 timestamp' }),
  region: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// ---------------------------------------------------------------------------
// GET /api/internal/events/sync — Bulk sync for consumers
// ---------------------------------------------------------------------------

router.get(
  '/events/sync',
  requireServiceKey,
  async (req, res, next) => {
    try {
      const { since, region, limit } = validateRequest(syncQuerySchema, req.query);

      // Fetch events updated after the given cursor
      let query = supabaseAdmin
        .from('events')
        .select('*, region:regions (name, slug, timezone)')
        .gt('updated_at', since)
        .eq('status', 'published')
        .order('updated_at', { ascending: true })
        .limit(limit);

      // Filter by region slug if provided
      if (region) {
        // Join through regions table to filter by slug
        query = supabaseAdmin
          .from('events')
          .select('*, region:regions!inner (name, slug, timezone)')
          .gt('updated_at', since)
          .eq('status', 'published')
          .eq('regions.slug', region)
          .order('updated_at', { ascending: true })
          .limit(limit);
      }

      const { data: events, error } = await query;

      if (error) {
        console.error('[INTERNAL] Sync query failed:', error.message);
        throw createError('Failed to fetch events for sync', 500, 'DATABASE_ERROR');
      }

      // Fetch deleted event IDs (events that ended since the cursor)
      const { data: endedEvents, error: endedError } = await supabaseAdmin
        .from('events')
        .select('id')
        .gt('ended_at', since)
        .not('ended_at', 'is', null);

      if (endedError) {
        console.error('[INTERNAL] Deleted events query failed:', endedError.message);
        // Non-fatal: proceed without deleted_ids
      }

      const deletedIds = (endedEvents || []).map(e => e.id);

      // Determine sync cursor (latest updated_at from returned events)
      const syncCursor = events && events.length > 0
        ? events[events.length - 1].updated_at
        : since;

      // has_more is true when we returned exactly `limit` rows
      const hasMore = (events || []).length >= limit;

      res.json({
        events: events || [],
        deleted_ids: deletedIds,
        sync_cursor: syncCursor,
        has_more: hasMore,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /health — Health check
// ---------------------------------------------------------------------------

router.get('/health', async (_req, res) => {
  try {
    // Verify DB connectivity with a simple query
    const { error } = await supabaseAdmin
      .from('regions')
      .select('id')
      .limit(1);

    if (error) {
      console.error('[HEALTH] DB check failed:', error.message);
      res.status(503).json({
        status: 'error',
        timestamp: new Date().toISOString(),
        version: '0.1.0',
        error: 'Database connection failed',
      });
      return;
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
    });
  } catch {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      error: 'Health check failed',
    });
  }
});

export default router;
