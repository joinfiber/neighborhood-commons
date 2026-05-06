/**
 * Service-tier Places API — Neighborhood Commons 1.0.0
 *
 * Idempotent on googlePlaceId. If a Place with that external ID exists,
 * returns it (200). Otherwise creates a new Place row and returns 201.
 *
 * Base: /api/v1/service/places
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest } from '../../lib/helpers.js';
import { formatPlace } from '../v1-places.js';

const router: ReturnType<typeof Router> = Router();

const placeInputSchema = z.object({
  name: z.string().min(1).max(200),
  googlePlaceId: z.string().max(500).optional(),
  address: z
    .object({
      streetAddress: z.string().max(500).optional(),
      addressLocality: z.string().max(200).optional(),
      addressRegion: z.string().max(100).optional(),
      postalCode: z.string().max(20).optional(),
      addressCountry: z.string().max(2).default('US').optional(),
    })
    .optional(),
  geo: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
});

const PLACE_SELECT = `
  id, google_place_id, name,
  street_address, address_locality, address_region, postal_code, address_country,
  latitude, longitude, region_id,
  created_at, updated_at
`;

// ---------------------------------------------------------------------------
// POST /service/places
// ---------------------------------------------------------------------------

router.post('/places', async (req, res, next) => {
  try {
    const body = validateRequest(placeInputSchema, req.body);

    // Idempotent: if googlePlaceId already exists, return it.
    if (body.googlePlaceId) {
      const { data: existing } = await supabaseAdmin
        .from('places')
        .select(PLACE_SELECT)
        .eq('google_place_id', body.googlePlaceId)
        .maybeSingle();

      if (existing) {
        res.status(200).json({ place: formatPlace(existing) });
        return;
      }
    }

    const insertRow = {
      google_place_id: body.googlePlaceId || null,
      name: body.name,
      street_address: body.address?.streetAddress || null,
      address_locality: body.address?.addressLocality || null,
      address_region: body.address?.addressRegion || null,
      postal_code: body.address?.postalCode || null,
      address_country: body.address?.addressCountry || 'US',
      latitude: body.geo.latitude,
      longitude: body.geo.longitude,
    };

    const { data: created, error } = await supabaseAdmin
      .from('places')
      .insert(insertRow)
      .select(PLACE_SELECT)
      .single();

    if (error || !created) {
      console.error('[SERVICE:PLACES] Insert error:', error?.message);
      throw createError('Failed to create place', 500, 'SERVER_ERROR');
    }

    res.status(201).json({ place: formatPlace(created) });
  } catch (err) {
    next(err);
  }
});

export default router;
