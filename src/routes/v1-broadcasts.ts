/**
 * Public Broadcasts API — Neighborhood Commons 1.0.0
 *
 * Read-only public API for ephemeral signals from Organizations, pinned to
 * Places. Active broadcasts only (status='active' policy at the table level).
 *
 * No authentication required. Optional API key for dedicated rate limit.
 *
 * Base: /api/v1/broadcasts
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, validateUuidParam } from '../lib/helpers.js';
import { optionalApiKey } from '../middleware/api-key.js';
import { hydrateVerificationsFor, resolveVerificationIdFilter } from '../lib/verification-hydrate.js';
import { formatPlace } from './v1-places.js';
import { formatOrganization } from './v1-organizations.js';

const router: ReturnType<typeof Router> = Router();
router.use(optionalApiKey);

export const broadcastsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.apiKeyInfo?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded (1000/hr).' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const BROADCAST_SELECT = `
  id, organization_id, place_id, message, expires_at, status, source, created_at,
  organizations!broadcasts_organization_id_fkey(
    id, slug, name, legal_name, kind, description, url, logo_url, image_url,
    telephone, email, same_as, keywords, opening_hours_specification,
    primary_place_id, created_at, updated_at
  ),
  places!broadcasts_place_id_fkey(
    id, google_place_id, name,
    street_address, address_locality, address_region, postal_code, address_country,
    latitude, longitude, region_id, created_at, updated_at
  )
`;

const listSchema = z.object({
  near: z.string().regex(/^-?\d+\.?\d*,-?\d+\.?\d*$/).optional(),
  radius_km: z.coerce.number().min(0.1).max(100).optional(),
  organization_id: z.string().uuid().optional(),
  verified: z.enum(['true', 'false']).optional(),
  verified_by: z.string().max(500).optional(),
  not_verified_by: z.string().max(500).optional(),
  created_by_contributor: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/v1/broadcasts
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(listSchema, req.query);
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    // Pre-resolve verification filters into the set of organization IDs
    // whose broadcasts are allowed/disallowed. Pushes the filter into SQL
    // so meta.total reflects the filtered count.
    const verifFilter = await resolveVerificationIdFilter('organization', {
      verified: params.verified,
      verified_by: params.verified_by,
      not_verified_by: params.not_verified_by,
    });
    if ('empty' in verifFilter && verifFilter.empty) {
      res.set('Cache-Control', 'public, max-age=15');
      res.json({ meta: buildMeta(0, limit, offset), broadcasts: [] });
      return;
    }

    let query = supabaseAdmin
      .from('broadcasts')
      .select(BROADCAST_SELECT, { count: 'exact' })
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if ('includeIds' in verifFilter) query = query.in('organization_id', verifFilter.includeIds);
    if ('excludeIds' in verifFilter) {
      query = query.not('organization_id', 'in', `(${verifFilter.excludeIds.join(',')})`);
    }

    if (params.organization_id) {
      query = query.eq('organization_id', params.organization_id);
    }

    if (params.created_by_contributor) {
      // source is JSONB; PostgREST supports JSON path filters via cs (contains)
      query = query.contains('source', { contributor: params.created_by_contributor });
    }

    const { data: broadcasts, error, count } = await query;
    if (error) {
      console.error('[V1:BROADCASTS] Query error:', error.message);
      throw createError('Failed to fetch broadcasts', 500, 'SERVER_ERROR');
    }

    // Hydrate verifications for the embedded organizations (still needed
    // for the `verification` block on each broadcast's organization)
    const orgIds = Array.from(new Set(
      (broadcasts || []).map(b => (b as Record<string, unknown>).organization_id as string)
    ));
    const verifications = await hydrateVerificationsFor('organization', orgIds);

    let formatted = (broadcasts || []).map(b => formatBroadcast(b as Record<string, unknown>, verifications));

    // Geo filter (post-fetch on the embedded place)
    if (params.near && params.radius_km) {
      const [lat, lng] = params.near.split(',').map(Number);
      if (!isNaN(lat) && !isNaN(lng)) {
        const latDelta = params.radius_km / 111;
        const lngDelta = params.radius_km / (111 * Math.cos((lat * Math.PI) / 180));
        formatted = formatted.filter(b => {
          const pLat = b.location?.geo?.latitude;
          const pLng = b.location?.geo?.longitude;
          if (typeof pLat !== 'number' || typeof pLng !== 'number') return false;
          return (
            pLat >= lat - latDelta && pLat <= lat + latDelta &&
            pLng >= lng - lngDelta && pLng <= lng + lngDelta
          );
        });
      }
    }

    res.set('Cache-Control', 'public, max-age=15');
    res.json({
      meta: buildMeta(count || 0, limit, offset),
      broadcasts: formatted,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/broadcasts/:id
// ---------------------------------------------------------------------------

router.get('/:id', async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');

    const { data: broadcast, error } = await supabaseAdmin
      .from('broadcasts')
      .select(BROADCAST_SELECT)
      .eq('id', req.params.id)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      console.error('[V1:BROADCASTS] Query error:', error.message);
      throw createError('Failed to fetch broadcast', 500, 'SERVER_ERROR');
    }
    if (!broadcast) {
      throw createError('Broadcast not found', 404, 'NOT_FOUND');
    }

    const orgId = (broadcast as Record<string, unknown>).organization_id as string;
    const verifications = await hydrateVerificationsFor('organization', [orgId]);

    res.set('Cache-Control', 'public, max-age=15');
    res.json({ broadcast: formatBroadcast(broadcast as Record<string, unknown>, verifications) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Format Broadcast for API response
// ---------------------------------------------------------------------------

function formatBroadcast(
  row: Record<string, unknown>,
  verifications: ReturnType<typeof hydrateVerificationsFor> extends Promise<infer T> ? T : never
) {
  const orgRow = row.organizations as Record<string, unknown> | null;
  const placeRow = row.places as Record<string, unknown> | null;

  // For the embedded organization: build a minimal placesById map for formatOrganization.
  // Broadcasts always have place_id set, but the org's primary_place may be different;
  // we don't fetch the org's primary_place inline here. So pass an empty map — the
  // org will surface without a `location` block. Consumers can hit /v1/organizations/:id
  // for the full org with location.
  const orgPlacesById = new Map<string, Record<string, unknown>>();

  return {
    id: row.id,
    message: row.message,
    datePosted: row.created_at,
    expires: row.expires_at,
    status: row.status,
    organization: orgRow ? formatOrganization(orgRow, orgPlacesById, verifications) : null,
    location: placeRow ? formatPlace(placeRow) : null,
    source: row.source,
  };
}

function buildMeta(total: number, limit: number, offset: number) {
  return {
    total,
    limit,
    offset,
    spec: 'neighborhood-api-v0.2',
    license: 'CC-BY-4.0',
  };
}

export default router;
