/**
 * Public Places API — Neighborhood Commons 1.0.0
 *
 * Read-only public API for Schema.org Place records — physical locations
 * deduplicated by Google Places ID. Places are pure facts; identity is
 * the address. No verification (place exists or it doesn't).
 *
 * No authentication required. Optional API key for dedicated rate limit.
 *
 * Base: /api/v1/places
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, validateUuidParam, sanitizeSearchInput } from '../lib/helpers.js';
import { optionalApiKey } from '../middleware/api-key.js';

const router: ReturnType<typeof Router> = Router();
router.use(optionalApiKey);

export const placesLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.apiKeyInfo?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded (1000/hr).' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const PLACE_SELECT = `
  id, google_place_id, name,
  street_address, address_locality, address_region, postal_code, address_country,
  latitude, longitude, region_id,
  created_at, updated_at
`;

const listSchema = z.object({
  near: z.string().regex(/^-?\d+\.?\d*,-?\d+\.?\d*$/).optional(),
  radius_km: z.coerce.number().min(0.1).max(100).optional(),
  region: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/v1/places — list places
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(listSchema, req.query);
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    // Resolve region slug → id BEFORE building the places query, so the
    // schema-alignment scanner doesn't conflate the two tables.
    let regionId: string | null = null;
    if (params.region) {
      const { data: regionRow } = await supabaseAdmin
        .from('regions')
        .select('id')
        .eq('slug', params.region)
        .maybeSingle();
      if (!regionRow) {
        // Unknown region → empty result rather than 404
        res.json({ meta: buildMeta(0, limit, offset), places: [] });
        return;
      }
      regionId = regionRow.id as string;
    }

    let query = supabaseAdmin
      .from('places')
      .select(PLACE_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (regionId) query = query.eq('region_id', regionId);

    if (params.q) {
      const sanitized = sanitizeSearchInput(params.q);
      if (sanitized) {
        query = query.or(`name.ilike.%${sanitized}%,address_locality.ilike.%${sanitized}%`);
      }
    }

    if (params.near && params.radius_km) {
      const [lat, lng] = params.near.split(',').map(Number);
      if (!isNaN(lat) && !isNaN(lng)) {
        const latDelta = params.radius_km / 111;
        const lngDelta = params.radius_km / (111 * Math.cos((lat * Math.PI) / 180));
        query = query
          .gte('latitude', lat - latDelta)
          .lte('latitude', lat + latDelta)
          .gte('longitude', lng - lngDelta)
          .lte('longitude', lng + lngDelta);
      }
    }

    const { data: places, error, count } = await query;
    if (error) {
      console.error('[V1:PLACES] Query error:', error.message);
      throw createError('Failed to fetch places', 500, 'SERVER_ERROR');
    }

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      meta: buildMeta(count || 0, limit, offset),
      places: (places || []).map(formatPlace),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/places/:id — single place
// ---------------------------------------------------------------------------

router.get('/:id', async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');

    const { data: place, error } = await supabaseAdmin
      .from('places')
      .select(PLACE_SELECT)
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) {
      console.error('[V1:PLACES] Query error:', error.message);
      throw createError('Failed to fetch place', 500, 'SERVER_ERROR');
    }
    if (!place) {
      throw createError('Place not found', 404, 'NOT_FOUND');
    }

    res.set('Cache-Control', 'public, max-age=60');
    res.json({ place: formatPlace(place) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Format Place for API response (Schema.org Place + PostalAddress + GeoCoordinates)
// ---------------------------------------------------------------------------

export function formatPlace(row: Record<string, unknown>) {
  const hasAddress =
    row.street_address || row.address_locality || row.address_region || row.postal_code;

  const identifier: Array<{ propertyID: string; value: string }> = [];
  if (row.google_place_id) {
    identifier.push({ propertyID: 'googlePlaceId', value: row.google_place_id as string });
  }

  return {
    id: row.id,
    name: row.name,
    address: hasAddress
      ? {
          streetAddress: row.street_address || null,
          addressLocality: row.address_locality || null,
          addressRegion: row.address_region || null,
          postalCode: row.postal_code || null,
          addressCountry: row.address_country || 'US',
        }
      : null,
    geo: {
      latitude: row.latitude,
      longitude: row.longitude,
    },
    identifier,
    region_slug: null, // hydrated separately if needed; deferred for v1
    created_at: row.created_at,
    updated_at: row.updated_at,
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
