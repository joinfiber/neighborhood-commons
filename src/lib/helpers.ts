/**
 * Shared Helper Functions — Neighborhood Commons
 *
 * Common utilities used across multiple route handlers.
 * Subset of the social API helpers, containing only what
 * the Commons service needs.
 */

import { type ZodType, type ZodTypeDef } from 'zod';
import { createError } from '../middleware/error-handler.js';

// =============================================================================
// REQUEST HELPERS
// =============================================================================

/**
 * Parse and validate input against a Zod schema.
 * Throws 400 VALIDATION_ERROR with the first field-level message on failure.
 */
export function validateRequest<Output, Def extends ZodTypeDef, Input>(
  schema: ZodType<Output, Def, Input>,
  data: unknown,
): Output {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.errors[0]?.message ?? 'Validation error';
    throw createError(msg, 400, 'VALIDATION_ERROR');
  }
  return result.data;
}

// =============================================================================
// UUID VALIDATION
// =============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a route parameter is a valid UUID. Throws 400 if missing or invalid.
 * Use in route handlers for user-supplied params/body values.
 * The type assertion narrows `unknown` to `string` after the call.
 */
export function validateUuidParam(value: unknown, name: string): asserts value is string {
  if (!value || typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw createError(`Invalid ${name}`, 400, 'VALIDATION_ERROR');
  }
}

// =============================================================================
// EVENT IMAGE URL HELPERS
// =============================================================================

/**
 * Resolve an event_image_url value to a client-loadable URL.
 *
 * Portal event images are stored as R2 keys (e.g., "portal-events/{id}/image").
 * External event images (DICE, etc.) are already full URLs.
 * This helper converts R2 keys to the serving endpoint URL.
 */
export function resolveEventImageUrl(raw: string | null | undefined, apiBaseUrl: string): string | null {
  if (!raw) return null;
  if (raw.startsWith('portal-events/')) {
    const id = raw.replace('portal-events/', '').replace('/image', '');
    return `${apiBaseUrl}/api/portal/events/${id}/image`;
  }
  return raw;
}

// =============================================================================
// GEOGRAPHY HELPERS
// =============================================================================

/**
 * Parse a PostGIS POINT from various formats:
 * - WKT string: "POINT(longitude latitude)"
 * - WKB hex string: "0101000020E6100000..." (returned by PostGIS SELECT)
 * - GeoJSON: { type: 'Point', coordinates: [lng, lat] }
 */
export function parseLocation(location: unknown): { latitude: number; longitude: number } | null {
  if (!location) return null;

  if (typeof location === 'string') {
    // Handle WKT format: "POINT(lng lat)"
    const wktMatch = location.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/i);
    if (wktMatch && wktMatch[1] && wktMatch[2]) {
      return {
        longitude: parseFloat(wktMatch[1]),
        latitude: parseFloat(wktMatch[2]),
      };
    }

    // Handle WKB hex format (what PostgreSQL returns for geography columns)
    // Format: 01 (little endian) + 20000001 (Point with SRID) + E6100000 (SRID 4326) + 16 bytes coords
    // Or:     0101000020E6100000 + 16 bytes coords (combined header)
    if (/^[0-9A-Fa-f]+$/.test(location) && location.length >= 50) {
      try {
        // Check for Point with SRID header (little endian)
        // 01 = little endian, 01000020 = point with SRID, E6100000 = SRID 4326
        const header = location.substring(0, 18).toUpperCase();
        if (header === '0101000020E6100000') {
          // Extract coordinates (16 bytes each for X and Y, starting at byte 9 = char 18)
          const xHex = location.substring(18, 34);
          const yHex = location.substring(34, 50);

          // Convert little-endian hex to double
          const xBytes = Buffer.from(xHex, 'hex');
          const yBytes = Buffer.from(yHex, 'hex');

          // Read as little-endian double
          const longitude = xBytes.readDoubleLE(0);
          const latitude = yBytes.readDoubleLE(0);

          if (!isNaN(longitude) && !isNaN(latitude)) {
            return { longitude, latitude };
          }
        }
      } catch {
        // Fall through to return null
      }
    }
  }

  // Handle GeoJSON format: { type: 'Point', coordinates: [lng, lat] }
  if (typeof location === 'object' && location !== null) {
    const geo = location as { type?: string; coordinates?: number[] };
    if (geo.type === 'Point' && Array.isArray(geo.coordinates) && geo.coordinates.length >= 2) {
      const lng = geo.coordinates[0];
      const lat = geo.coordinates[1];
      if (typeof lng === 'number' && typeof lat === 'number') {
        return { longitude: lng, latitude: lat };
      }
    }
  }

  return null;
}
