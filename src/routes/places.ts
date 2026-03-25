/**
 * Places API — Neighborhood Commons
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
import { requirePortalAuth } from '../middleware/auth.js';

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
router.post('/search', requirePortalAuth, placesLimiter, async (req, res, next) => {
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

// =============================================================================
// BULK VENUE DISCOVERY — Scan a zip code for event-relevant venues
// =============================================================================

/** Place types likely to host events or have regular programming */
const VENUE_TYPES = [
  'bar', 'restaurant', 'night_club', 'cafe',
  'art_gallery', 'museum', 'movie_theater', 'performing_arts_theater',
  'bowling_alley', 'gym', 'yoga_studio', 'park',
  'library', 'community_center', 'church',
  'book_store', 'shopping_mall', 'brewery', 'winery',
  'spa', 'stadium', 'event_venue',
];

const FIELD_MASK_BULK = [
  'places.id',
  'places.displayName',
  'places.shortFormattedAddress',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.regularOpeningHours',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.googleMapsUri',
].join(',');

const scanSchema = z.object({
  query: z.string().min(3).max(100), // e.g. "19125" or "Fishtown Philadelphia"
  types: z.array(z.string()).min(1).max(10).optional(),
  // Optional: provide center + radius for strict geographic restriction
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  radius_km: z.number().min(0.5).max(10).default(1.5),
});

/**
 * POST /api/places/scan — Bulk venue discovery for admin venue import.
 * Queries Google Places Text Search for event-relevant venue types in an area.
 * Returns deduplicated results across multiple type queries.
 */
router.post('/scan', requirePortalAuth, placesLimiter, async (req, res, next) => {
  try {
    if (!config.google.placesApiKey) {
      throw createError('Places API not configured', 503, 'SERVICE_UNAVAILABLE');
    }

    const { query, types, latitude, longitude, radius_km } = validateRequest(scanSchema, req.body);
    const searchTypes = types || VENUE_TYPES;

    // Resolve center coordinates: use provided lat/lng, or geocode the query
    let centerLat = latitude;
    let centerLng = longitude;

    if (centerLat == null || centerLng == null) {
      // Geocode the query (zip code or area name) to get center coordinates
      const geoResponse = await fetch(`${PLACES_API_BASE}/places:searchText`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.google.placesApiKey,
          'X-Goog-FieldMask': 'places.location',
        },
        body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
      });

      if (geoResponse.ok) {
        const geoData = await geoResponse.json() as { places?: Array<{ location?: { latitude: number; longitude: number } }> };
        const loc = geoData.places?.[0]?.location;
        if (loc) {
          centerLat = loc.latitude;
          centerLng = loc.longitude;
        }
      }

      if (centerLat == null || centerLng == null) {
        throw createError('Could not geocode the specified area', 400, 'GEOCODE_FAILED');
      }
    }

    // Convert radius_km to a lat/lng bounding box for locationRestriction
    // 1 degree of latitude ≈ 111km
    const latDelta = radius_km / 111;
    const lngDelta = radius_km / (111 * Math.cos(centerLat * Math.PI / 180));

    const locationRestriction = {
      rectangle: {
        low: { latitude: centerLat - latDelta, longitude: centerLng - lngDelta },
        high: { latitude: centerLat + latDelta, longitude: centerLng + lngDelta },
      },
    };

    console.log(`[PLACES] Scan center: ${centerLat.toFixed(4)}, ${centerLng.toFixed(4)}, radius: ${radius_km}km`);

    // Query Google Places for each venue type in the area
    const seen = new Set<string>();
    const allPlaces: Array<{
      place_id: string;
      name: string;
      address: string | null;
      full_address: string | null;
      location: { latitude: number; longitude: number } | null;
      types: string[];
      primary_type: string | null;
      website: string | null;
      phone: string | null;
      google_maps_url: string | null;
      opening_hours: {
        weekday_text: string[];
        open_now?: boolean;
      } | null;
    }> = [];

    // Batch queries: search for each type in the restricted area
    for (const placeType of searchTypes) {
      const searchQuery = placeType.replace(/_/g, ' ');

      const response = await fetch(`${PLACES_API_BASE}/places:searchText`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.google.placesApiKey,
          'X-Goog-FieldMask': FIELD_MASK_BULK,
        },
        body: JSON.stringify({
          textQuery: searchQuery,
          locationRestriction,
          maxResultCount: 20,
        }),
      });

      if (!response.ok) {
        console.warn(`[PLACES] Scan query "${searchQuery}" failed: ${response.status}`);
        continue;
      }

      const data = await response.json() as { places?: NewApiPlace[] };
      for (const place of data.places || []) {
        if (seen.has(place.id)) continue;
        seen.add(place.id);

        const fullAddr = place.formattedAddress || null;
        allPlaces.push({
          place_id: place.id,
          name: place.displayName?.text || '',
          address: place.shortFormattedAddress || fullAddr || null,
          full_address: fullAddr,
          location: place.location
            ? { latitude: place.location.latitude, longitude: place.location.longitude }
            : null,
          types: place.types || [],
          primary_type: (place as unknown as Record<string, unknown>).primaryType as string | null,
          website: (place as unknown as Record<string, unknown>).websiteUri as string | null,
          phone: (place as unknown as Record<string, unknown>).nationalPhoneNumber as string | null,
          google_maps_url: (place as unknown as Record<string, unknown>).googleMapsUri as string | null,
          opening_hours: (() => {
            const hours = (place as unknown as Record<string, unknown>).regularOpeningHours as {
              weekdayDescriptions?: string[];
              openNow?: boolean;
            } | undefined;
            if (!hours?.weekdayDescriptions) return null;
            return { weekday_text: hours.weekdayDescriptions, open_now: hours.openNow };
          })(),
        });
      }
    }

    // Post-filter: if query looks like a zip code, filter by address containing it.
    // This is more accurate than radius — every Google address includes the zip.
    const isZipCode = /^\d{5}$/.test(query.trim());
    let withinArea: typeof allPlaces;

    if (isZipCode) {
      const zip = query.trim();
      withinArea = allPlaces.filter(p => {
        const addr = p.full_address || p.address || '';
        return addr.includes(zip);
      });
      console.log(`[PLACES] Zip filter "${zip}": ${withinArea.length} of ${allPlaces.length} matched`);
    } else {
      // Fallback to radius filter for non-zip queries
      const radiusMeters = radius_km * 1000;
      withinArea = allPlaces.filter(p => {
        if (!p.location) return false;
        const dist = calculateDistanceMeters(centerLat!, centerLng!, p.location.latitude, p.location.longitude);
        return dist <= radiusMeters;
      });
    }

    // Sort by name
    withinArea.sort((a, b) => a.name.localeCompare(b.name));

    console.log(`[PLACES] Scan "${query}": ${withinArea.length} venues within ${radius_km}km (${allPlaces.length} total before filter) from ${searchTypes.length} type queries`);
    res.json({ venues: withinArea, query, types_searched: searchTypes.length, radius_km });
  } catch (err) {
    next(err);
  }
});

export default router;
