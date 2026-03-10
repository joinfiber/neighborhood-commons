/**
 * Browse Routes (Public — No Authentication Required)
 *
 * Serves curated events for the unauthenticated browse screen.
 * This is the Commons API's primary public data surface.
 *
 * Security:
 * - blockDatacenterIps on all routes (prevents bot scraping)
 * - IP-based rate limiting (no user ID available)
 * - No user data in responses (only admin-curated event metadata)
 * - IP hashes for dedup use auditSalt (never stored raw)
 * - Dedup rows auto-deleted after 24h by cron
 */

import { Router, type Request } from 'express';
import { createHash } from 'crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { blockDatacenterIps } from '../middleware/ip-filter.js';
import { config } from '../config.js';
import { validateUuidParam, validateRequest, parseLocation, resolveEventImageUrl } from '../lib/helpers.js';

const router: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// Rate limiters (IP-only — no authenticated user context)
// ---------------------------------------------------------------------------

const browseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const browseWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const browseQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(25).default(25),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hash IP + event_id + date for dedup. Uses auditSalt to avoid storing raw IPs. */
function hashForDedup(ip: string, eventId: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return createHash('sha256')
    .update(`${config.security.auditSalt}:${ip}:${eventId}:${date}`)
    .digest('hex')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// GET /events — List curated events (public)
// ---------------------------------------------------------------------------

router.get(
  '/events',
  blockDatacenterIps,
  browseLimiter,
  async (req, res, next) => {
    try {
      const { limit, latitude, longitude } = validateRequest(browseQuerySchema, req.query);
      const hasCoords = latitude !== undefined && longitude !== undefined;

      // Fetch published, non-expired events
      // Always select approximate_location (lightweight point column) — only used when hasCoords
      const { data: events, error } = await supabaseAdmin
        .from('events')
        .select('id, content, description, place_name, event_at, end_time, link_url, category, mode, visibility, event_image_url, event_image_focal_y, approximate_location, region:regions!inner (name, slug, timezone)')
        .eq('visibility', 'public')
        .eq('status', 'published')
        .is('ended_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('event_at', { ascending: true })
        .limit(limit);

      if (error) {
        console.error('[BROWSE] Failed to fetch events:', error.message);
        throw createError('Failed to fetch events', 500, 'DATABASE_ERROR');
      }

      const eventIds = (events || []).map(e => e.id);

      // Batch-fetch RSVP counts from event_analytics
      let rsvpMap = new Map<string, number>();
      if (eventIds.length > 0) {
        const { data: analytics } = await supabaseAdmin
          .from('event_analytics')
          .select('event_id, coming_count, shown_up_count')
          .in('event_id', eventIds);

        if (analytics) {
          for (const row of analytics) {
            rsvpMap.set(row.event_id, (row.coming_count || 0) + (row.shown_up_count || 0));
          }
        }
      }

      // Batch-fetch calendar-add counts
      let calendarMap = new Map<string, number>();
      if (eventIds.length > 0) {
        const { data: calendarCounts } = await supabaseAdmin
          .from('event_calendar_adds')
          .select('event_id, count')
          .in('event_id', eventIds);

        if (calendarCounts) {
          for (const row of calendarCounts) {
            calendarMap.set(row.event_id, row.count || 0);
          }
        }
      }

      // Build public response — NO user data, NO raw coordinates
      const publicEvents = (events || []).map(event => {
        const region = event.region as unknown as { name: string; slug: string; timezone: string } | null;

        // Compute distance when viewer coords are provided (transient, never stored)
        let distanceMeters: number | null = null;
        if (hasCoords) {
          const loc = parseLocation((event as unknown as { approximate_location?: unknown }).approximate_location);
          if (loc) {
            const R = 6371000;
            const dLat = (loc.latitude - latitude!) * Math.PI / 180;
            const dLng = (loc.longitude - longitude!) * Math.PI / 180;
            const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(latitude! * Math.PI / 180) * Math.cos(loc.latitude * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
            distanceMeters = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
          }
        }

        return {
          id: event.id,
          content: event.content,
          description: event.description || null,
          place_name: event.place_name || null,
          event_at: event.event_at || null,
          end_time: event.end_time || null,
          link_url: (event as unknown as { link_url?: string }).link_url || null,
          region_name: region?.name || null,
          event_timezone: region?.timezone || null,
          rsvp_count: rsvpMap.get(event.id) || 0,
          calendar_add_count: calendarMap.get(event.id) || 0,
          category: event.category || null,
          mode: (event as unknown as { mode?: string }).mode || null,
          event_image_url: resolveEventImageUrl(event.event_image_url, config.apiBaseUrl),
          event_image_focal_y: (event as unknown as { event_image_focal_y?: number }).event_image_focal_y ?? 0.5,
          ...(distanceMeters !== null ? { distance_meters: distanceMeters } : {}),
        };
      });

      // Sort by proximity when coordinates are provided
      if (hasCoords) {
        publicEvents.sort((a: any, b: any) => {
          const aDist = a.distance_meters ?? Infinity;
          const bDist = b.distance_meters ?? Infinity;
          return aDist - bDist;
        });
      }

      res.set('Cache-Control', hasCoords ? 'private, max-age=30' : 'public, max-age=60');
      res.json({ events: publicEvents });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /events/:id/calendar-add — Anonymous calendar-add counter
// ---------------------------------------------------------------------------

router.post(
  '/events/:id/calendar-add',
  blockDatacenterIps,
  browseWriteLimiter,
  async (req, res, next) => {
    try {
      validateUuidParam(req.params.id, 'event id');
      const eventId = req.params.id;
      const ipHash = hashForDedup(req.ip || 'unknown', eventId);

      await supabaseAdmin.rpc('increment_calendar_add', {
        p_event_id: eventId,
        p_ip_hash: ipHash,
      });

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /events/:id/interested — Anonymous interested counter (admin analytics)
// ---------------------------------------------------------------------------

router.post(
  '/events/:id/interested',
  blockDatacenterIps,
  browseWriteLimiter,
  async (req, res, next) => {
    try {
      validateUuidParam(req.params.id, 'event id');
      const eventId = req.params.id;
      const ipHash = hashForDedup(req.ip || 'unknown', eventId);

      await supabaseAdmin.rpc('increment_event_interested', {
        p_event_id: eventId,
        p_ip_hash: ipHash,
      });

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /events/:id/view — Anonymous detail-view counter
// ---------------------------------------------------------------------------

router.post(
  '/events/:id/view',
  blockDatacenterIps,
  browseWriteLimiter,
  async (req, res, next) => {
    try {
      validateUuidParam(req.params.id, 'event id');
      const eventId = req.params.id;
      const ipHash = hashForDedup(req.ip || 'unknown', eventId);

      await supabaseAdmin.rpc('increment_event_view_deduped', {
        p_event_id: eventId,
        p_ip_hash: ipHash,
      });

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
