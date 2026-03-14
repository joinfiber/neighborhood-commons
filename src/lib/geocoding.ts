/**
 * Geocoding — Neighborhood Commons
 *
 * Two-tier address → coordinates resolution:
 * 1. Creator account default coordinates (no external call)
 * 2. Nominatim/OpenStreetMap geocoding (1 req/sec, free)
 *
 * Used fire-and-forget after event create/update to fill in
 * latitude/longitude when only a street address is provided.
 */

import { supabaseAdmin } from './supabase.js';

// ---------------------------------------------------------------------------
// Rate limiting — Nominatim requires max 1 request per second
// ---------------------------------------------------------------------------

let lastNominatimRequest = 0;

async function throttleNominatim(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastNominatimRequest;
  if (elapsed < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000 - elapsed));
  }
  lastNominatimRequest = Date.now();
}

// ---------------------------------------------------------------------------
// Address normalization
// ---------------------------------------------------------------------------

export function normalizeAddress(address: string): string {
  return address.toLowerCase().trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Nominatim geocoding
// ---------------------------------------------------------------------------

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'NeighborhoodCommons/1.0 (neighborhood event data)';

export async function nominatimGeocode(
  address: string,
): Promise<{ lat: number; lng: number } | null> {
  await throttleNominatim();

  const params = new URLSearchParams({
    q: normalizeAddress(address),
    format: 'json',
    limit: '1',
  });

  try {
    const response = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.error(`[GEOCODE] Nominatim HTTP ${response.status} for "${address}"`);
      return null;
    }

    const results = (await response.json()) as Array<{ lat: string; lon: string }>;
    if (!results.length) {
      console.log(`[GEOCODE] No results for "${address}"`);
      return null;
    }

    const lat = parseFloat(results[0]!.lat);
    const lng = parseFloat(results[0]!.lon);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      console.error(`[GEOCODE] Invalid coordinates from Nominatim for "${address}": ${lat}, ${lng}`);
      return null;
    }

    return { lat, lng };
  } catch (err) {
    console.error(
      `[GEOCODE] Nominatim error for "${address}":`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Account default coordinates lookup
// ---------------------------------------------------------------------------

async function getAccountDefaultCoords(
  accountId: string,
): Promise<{ lat: number; lng: number } | null> {
  const { data } = await supabaseAdmin
    .from('portal_accounts')
    .select('default_latitude, default_longitude')
    .eq('id', accountId)
    .maybeSingle();

  if (data?.default_latitude != null && data?.default_longitude != null) {
    return { lat: data.default_latitude as number, lng: data.default_longitude as number };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point — geocode an event if coordinates are missing
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget geocoding for a single event.
 * Checks account defaults first, then Nominatim.
 * Never overwrites existing coordinates.
 */
export async function geocodeEventIfNeeded(
  eventId: string,
  address: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
  creatorAccountId: string | null | undefined,
): Promise<void> {
  // Already has coordinates — nothing to do
  if (lat != null && lng != null) return;
  // No address to geocode
  if (!address || !address.trim()) return;

  try {
    // Tier 1: account default coordinates
    let coords: { lat: number; lng: number } | null = null;
    if (creatorAccountId) {
      coords = await getAccountDefaultCoords(creatorAccountId);
      if (coords) {
        console.log(`[GEOCODE] Using account defaults for event ${eventId}`);
      }
    }

    // Tier 2: Nominatim
    if (!coords) {
      coords = await nominatimGeocode(address);
      if (coords) {
        console.log(`[GEOCODE] Nominatim resolved event ${eventId}: ${coords.lat}, ${coords.lng}`);
      }
    }

    if (!coords) return;

    // Update the event row — the PostGIS trigger handles `location` automatically
    const { error } = await supabaseAdmin
      .from('events')
      .update({
        latitude: coords.lat,
        longitude: coords.lng,
        approximate_location: `POINT(${coords.lng} ${coords.lat})`,
      })
      .eq('id', eventId);

    if (error) {
      console.error(`[GEOCODE] Failed to update event ${eventId}:`, error.message);
    }
  } catch (err) {
    console.error(
      `[GEOCODE] Error geocoding event ${eventId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Geocode a single address and apply coordinates to multiple event IDs.
 * Used for series creation where all instances share the same address.
 */
export async function geocodeSeriesEvents(
  eventIds: string[],
  address: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
  creatorAccountId: string | null | undefined,
): Promise<void> {
  if (lat != null && lng != null) return;
  if (!address || !address.trim()) return;
  if (eventIds.length === 0) return;

  try {
    let coords: { lat: number; lng: number } | null = null;
    if (creatorAccountId) {
      coords = await getAccountDefaultCoords(creatorAccountId);
      if (coords) {
        console.log(`[GEOCODE] Using account defaults for ${eventIds.length} series events`);
      }
    }

    if (!coords) {
      coords = await nominatimGeocode(address);
      if (coords) {
        console.log(`[GEOCODE] Nominatim resolved ${eventIds.length} series events: ${coords.lat}, ${coords.lng}`);
      }
    }

    if (!coords) return;

    const { error } = await supabaseAdmin
      .from('events')
      .update({
        latitude: coords.lat,
        longitude: coords.lng,
        approximate_location: `POINT(${coords.lng} ${coords.lat})`,
      })
      .in('id', eventIds);

    if (error) {
      console.error(`[GEOCODE] Failed to update series events:`, error.message);
    }
  } catch (err) {
    console.error(
      `[GEOCODE] Error geocoding series events:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Batch geocoding for backfill
// ---------------------------------------------------------------------------

const BACKFILL_BATCH_SIZE = 50;

/**
 * Geocode a batch of events that have addresses but no coordinates.
 * Returns stats for the cron response.
 */
export async function geocodeBackfill(): Promise<{
  processed: number;
  geocoded: number;
  failed: number;
}> {
  const { data: events, error } = await supabaseAdmin
    .from('events')
    .select('id, venue_address, creator_account_id')
    .not('venue_address', 'is', null)
    .is('latitude', null)
    .limit(BACKFILL_BATCH_SIZE);

  if (error) {
    console.error('[GEOCODE] Backfill query error:', error.message);
    return { processed: 0, geocoded: 0, failed: 0 };
  }

  if (!events || events.length === 0) {
    console.log('[GEOCODE] Backfill: no events to geocode');
    return { processed: 0, geocoded: 0, failed: 0 };
  }

  let geocoded = 0;
  let failed = 0;

  for (const event of events) {
    const address = event.venue_address as string;
    const accountId = event.creator_account_id as string | null;

    // Tier 1: account defaults
    let coords: { lat: number; lng: number } | null = null;
    if (accountId) {
      coords = await getAccountDefaultCoords(accountId);
    }

    // Tier 2: Nominatim
    if (!coords) {
      coords = await nominatimGeocode(address);
    }

    if (coords) {
      const { error: updateErr } = await supabaseAdmin
        .from('events')
        .update({
          latitude: coords.lat,
          longitude: coords.lng,
          approximate_location: `POINT(${coords.lng} ${coords.lat})`,
        })
        .eq('id', event.id);

      if (updateErr) {
        console.error(`[GEOCODE] Backfill update failed for ${event.id}:`, updateErr.message);
        failed++;
      } else {
        console.log(`[GEOCODE] Backfill geocoded ${event.id}: ${coords.lat}, ${coords.lng}`);
        geocoded++;
      }
    } else {
      console.log(`[GEOCODE] Backfill: no coords found for ${event.id} ("${address}")`);
      failed++;
    }
  }

  return { processed: events.length, geocoded, failed };
}
