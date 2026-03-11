/**
 * Places API — The Fiber Commons
 *
 * Google Places API proxy for portal venue search.
 * Authenticated (portal users only).
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { config } from '../config.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest } from '../lib/helpers.js';

const router: ReturnType<typeof Router> = Router();

const PLACES_API_BASE = 'https://places.googleapis.com/v1';

const TEXT_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.shortFormattedAddress',
  'places.formattedAddress',
  'places.location',
  'places.types',
].join(',');

interface NewApiPlace {
  id: string;
  displayName?: { text: string; languageCode?: string };
  formattedAddress?: string;
  shortFormattedAddress?: string;
  location?: { latitude: number; longitude: number };
  types?: string[];
}

function formatDistance(meters: number): string {
  const feet = meters * 3.28084;
  const miles = meters / 1609.34;
  if (miles < 0.1) return `${Math.round(feet)} ft`;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

function calculateDistanceMeters(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const placesLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests. Please try again later.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const searchSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  query: z.string().optional(),
  type: z.string().optional(),
  radius: z.number().min(100).max(50000).default(1000),
});

/**
 * POST /api/places/search — Venue search for portal event creation
 */
router.post('/search', placesLimiter, async (req, res, next) => {
  try {
    if (!config.google.placesApiKey) {
      throw createError('Places API not configured', 503, 'SERVICE_UNAVAILABLE');
    }

    const { latitude, longitude, query, type, radius } = validateRequest(searchSchema, req.body);

    let places: NewApiPlace[];

    if (query && query.trim().length >= 2) {
      const body: Record<string, unknown> = {
        textQuery: query.trim(),
        locationBias: {
          circle: {
            center: { latitude, longitude },
            radius,
          },
        },
        maxResultCount: 20,
      };
      if (type) body.includedType = type;

      const response = await fetch(`${PLACES_API_BASE}/places:searchText`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.google.placesApiKey,
          'X-Goog-FieldMask': TEXT_FIELD_MASK,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        console.log('[PLACES] Text Search error: status', response.status);
        throw createError('Places API error', 502, 'UPSTREAM_ERROR');
      }

      const data = await response.json() as { places?: NewApiPlace[] };
      places = data.places || [];
    } else {
      // Nearby Search (New) — location-only queries
      const body: Record<string, unknown> = {
        maxResultCount: 20,
        locationRestriction: {
          circle: {
            center: { latitude, longitude },
            radius,
          },
        },
        rankPreference: 'DISTANCE',
      };
      if (type) body.includedTypes = [type];

      const response = await fetch(`${PLACES_API_BASE}/places:searchNearby`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.google.placesApiKey,
          'X-Goog-FieldMask': TEXT_FIELD_MASK,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        console.log('[PLACES] Nearby Search error: status', response.status);
        places = [];
      } else {
        const data = await response.json() as { places?: NewApiPlace[] };
        places = data.places || [];
      }
    }

    const results = places.slice(0, 20).map((place) => {
      const placeLat = place.location?.latitude;
      const placeLng = place.location?.longitude;

      let distance: number | null = null;
      let distanceText: string | null = null;
      if (placeLat !== undefined && placeLng !== undefined) {
        distance = calculateDistanceMeters(latitude, longitude, placeLat, placeLng);
        distanceText = formatDistance(distance);
      }

      return {
        place_id: place.id,
        name: place.displayName?.text || '',
        address: place.shortFormattedAddress || place.formattedAddress,
        location: placeLat !== undefined && placeLng !== undefined
          ? { latitude: placeLat, longitude: placeLng }
          : null,
        types: place.types || [],
        distance,
        distanceText,
      };
    });

    res.json({ results });
  } catch (err) {
    next(err);
  }
});

export default router;
