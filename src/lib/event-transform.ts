/**
 * Event Transforms — Neighborhood Commons
 *
 * Single source of truth for transforming events table rows to API response formats.
 * Every public-facing event response shape is defined and produced here.
 *
 * Used by:
 * - routes/v1.ts (Neighborhood API responses)
 * - routes/portal.ts (webhook payloads)
 * - lib/webhook-delivery.ts (webhook retry payloads)
 */

import { EVENT_CATEGORIES, type EventCategory } from './categories.js';
import { resolveEventImageUrl } from './helpers.js';
import { config } from '../config.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Events table row with organizations join (for public API / webhook use).
 *
 * v2: organizer comes from the joined `organizations` row via
 * `organizer_org_id`. The legacy `portal_accounts` join (which used to
 * supply `business_name` as the organizer name) is gone — that column
 * was dropped from portal_accounts in migration 082.
 *
 * The suspended-status visibility check now traverses
 * organizations.owner_account_id → portal_accounts.status. Organizations
 * without an owning portal account (e.g., admin-created via Studio) skip
 * the suspension check entirely.
 */
export interface PortalEventRow {
  id: string;
  content: string;
  description: string | null;
  place_name: string;
  venue_address: string | null;
  place_id: string | null;
  latitude: number | null;
  longitude: number | null;
  event_at: string;
  end_time: string | null;
  event_timezone: string;
  category: string;
  custom_category: string | null;
  recurrence: string;
  series_id: string | null;
  series_instance_number: number | null;
  open_window: boolean;
  capacity: number | null;
  rsvp: 'recommended' | 'required' | null;
  tags: string[] | null;
  wheelchair_accessible: boolean | null;
  price: string | null;
  link_url: string | null;
  event_image_url: string | null;
  created_at: string;
  // Contributor tracking (migrations 020, 045, 062)
  source_method: string | null;
  source_publisher: string | null;
  source_contributor_url: string | null;
  source_contributor_name: string | null;
  // First-party flag (migration 054; semantics finalized in 73c4bce)
  first_party: boolean;
  // TMDB film ID for cross-theater clustering (migration 063)
  tmdb_id: string | null;
  // v2: organizer derived from organizations join via organizer_org_id (migration 067).
  // The nested portal_accounts (via owner_account_id) is for the suspended-status
  // visibility check; it's not exposed in the public response.
  organizer_org_id: string | null;
  organizations: {
    id: string;
    slug: string;
    name: string;
    portal_accounts: { status: string } | null;
  } | null;
}

export interface NeighborhoodEvent {
  id: string;
  name: string;
  start: string;
  end: string | null;
  timezone: string;
  description: string | null;
  category: string[];
  place_id: string | null;
  location: {
    name: string;
    address: string | null;
    lat: number | null;
    lng: number | null;
  };
  url: string | null;
  images: string[];
  event_image_focal_y: number;
  organizer: {
    // v2: organizer is always an organization reference (no Person variant).
    // Post-migration 081, events.organizer_org_id is NOT NULL, so id and slug
    // are always present in the response. The "Unknown Organizer" placeholder
    // catches any historical orphans.
    id: string;              // org UUID, always present
    slug: string;             // org slug, always present
    name: string;             // org name (falls back to place_name only in pre-migration data)
    verified: boolean;        // hydrated from organization_verifications
    phone: null;              // legacy field, kept for backward compat; always null
  };
  cost: string | null;
  series_id: string | null;
  series_instance_number: number | null;
  series_instance_count: number | null;
  open_window: boolean;
  capacity: number | null;
  rsvp: 'recommended' | 'required' | null;
  tags: string[];
  wheelchair_accessible: boolean | null;
  first_party: boolean;
  tmdb_id: string | null;
  recurrence: { rrule: string } | null;
  source: {
    publisher: string;
    collected_at: string;
    // v2: extended to include 'witnessed' for the Fiber Community OCR path
    method: 'portal' | 'import' | 'api' | 'witnessed';
    contributor: { name: string; url: string | null } | null;
    license: 'CC BY 4.0';
  };
}

// =============================================================================
// HELPERS
// =============================================================================

/** Convert event_at (timestamptz) to ISO 8601 with timezone offset */
export function toIso(eventAt: string, timezone: string): string {
  try {
    const d = new Date(eventAt);
    if (isNaN(d.getTime())) return eventAt;
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: timezone });
    const timeStr = d.toLocaleTimeString('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(d);
    const offsetPart = parts.find((p) => p.type === 'timeZoneName');
    if (offsetPart) {
      // Handle whole-hour (GMT-5) and fractional (GMT+5:30, GMT+5:45) offsets
      const match = offsetPart.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
      if (match) {
        const sign = match[1];
        const hours = (match[2] as string).padStart(2, '0');
        const minutes = match[3] || '00';
        return `${dateStr}T${timeStr}${sign}${hours}:${minutes}`;
      }
    }
    return `${dateStr}T${timeStr}`;
  } catch {
    return eventAt;
  }
}

/** Slugify a category for the public API */
export function slugifyCategory(category: string, customCategory: string | null): string[] {
  if (category === 'other' && customCategory) {
    return [customCategory.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')];
  }
  const cat = EVENT_CATEGORIES[category as EventCategory];
  if (cat) {
    return [category.replace(/_/g, '-')];
  }
  return [category];
}

/** Map recurrence to iCal RRULE. When count is provided, appends ;COUNT=N for bounded rules. */
export function toRRule(recurrence: string, count?: number): string | null {
  const suffix = count && count > 0 ? `;COUNT=${count}` : '';

  switch (recurrence) {
    case 'daily': return `FREQ=DAILY${suffix}`;
    case 'weekly': return `FREQ=WEEKLY${suffix}`;
    case 'biweekly': return `FREQ=WEEKLY;INTERVAL=2${suffix}`;
    case 'monthly': return `FREQ=MONTHLY${suffix}`;
    default: {
      const dayMap: Record<string, string> = {
        monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH',
        friday: 'FR', saturday: 'SA', sunday: 'SU',
      };
      const abbrMap: Record<string, string> = {
        sun: 'SU', mon: 'MO', tue: 'TU', wed: 'WE', thu: 'TH', fri: 'FR', sat: 'SA',
      };

      // weekly_days:mon,tue,wed,thu → FREQ=WEEKLY;BYDAY=MO,TU,WE,TH
      const wdMatch = recurrence.match(/^weekly_days:([a-z,]+)$/);
      if (wdMatch && wdMatch[1]) {
        const rruleDays = wdMatch[1].split(',').map(d => abbrMap[d]).filter(Boolean);
        if (rruleDays.length > 0) return `FREQ=WEEKLY;BYDAY=${rruleDays.join(',')}${suffix}`;
      }

      const match = recurrence.match(/^ordinal_weekday:(\d):(\w+)$/);
      if (match) {
        const day = match[2] ? dayMap[match[2]] : undefined;
        if (day) return `FREQ=MONTHLY;BYDAY=${match[1]}${day}${suffix}`;
      }
      return null;
    }
  }
}

// =============================================================================
// NEIGHBORHOOD API TRANSFORM
// =============================================================================

/**
 * Transform an events table row (with organizations join) to Neighborhood API format.
 *
 * v2 changes from v1:
 *   - organizer is derived from the joined `organizations` row, not from
 *     portal_accounts.business_name (which was dropped in migration 082)
 *   - organizer.{id, slug, verified} are new fields; phone stays as null
 *     for backward compat with consumers reading {name, phone}
 *   - source.method extended to include 'witnessed' (Fiber Community OCR path)
 *
 * The `verifiedOrgIds` parameter is an optional Set of organization UUIDs
 * known to be verified. Callers that hydrate verifications in batch pass
 * this; callers that don't get `verified: false` on every organizer.
 */
export function toNeighborhoodEvent(
  row: PortalEventRow,
  verifiedOrgIds?: ReadonlySet<string>,
): NeighborhoodEvent {
  const tz = row.event_timezone || 'America/New_York';
  const rrule = toRRule(row.recurrence);
  const org = row.organizations;
  // Post-migration 081 every event has an organizer. The empty-string fallbacks
  // here are belt-and-suspenders for the brief window when 081 hasn't applied yet;
  // they'll never trigger in production once v2 ships.
  const organizerId = org?.id ?? '';
  const organizerSlug = org?.slug ?? '';
  const organizerName = org?.name || row.place_name;
  const isVerified = !!(org?.id && verifiedOrgIds?.has(org.id));
  return {
    id: row.id,
    name: row.content,
    start: toIso(row.event_at, tz),
    end: row.end_time ? toIso(row.end_time, tz) : null,
    timezone: tz,
    description: row.description,
    category: slugifyCategory(row.category, row.custom_category),
    place_id: row.place_id || null,
    location: {
      name: row.place_name,
      address: row.venue_address,
      lat: row.latitude,
      lng: row.longitude,
    },
    url: row.link_url || null,
    images: row.event_image_url ? [resolveEventImageUrl(row.event_image_url, config.apiBaseUrl) as string] : [],
    event_image_focal_y: (row as unknown as { event_image_focal_y?: number }).event_image_focal_y ?? 0.5,
    organizer: {
      id: organizerId,
      slug: organizerSlug,
      name: organizerName,
      verified: isVerified,
      phone: null,
    },
    cost: row.price || null,
    series_id: row.series_id || null,
    series_instance_number: row.series_instance_number || null,
    series_instance_count: null,
    open_window: row.open_window ?? false,
    capacity: row.capacity ?? null,
    rsvp: row.rsvp ?? null,
    tags: row.tags || [],
    wheelchair_accessible: row.wheelchair_accessible ?? null,
    first_party: row.first_party,
    tmdb_id: row.tmdb_id ?? null,
    recurrence: rrule ? { rrule } : null,
    source: {
      // API/import/witnessed events: source_publisher is the canonical publisher (the external source).
      // Portal events: organization name is the publisher.
      publisher: (row.source_method && row.source_method !== 'portal' && row.source_publisher)
        ? row.source_publisher
        : (organizerName || row.source_publisher || 'Neighborhood Commons'),
      collected_at: row.created_at,
      method: (row.source_method || 'portal') as 'portal' | 'import' | 'api' | 'witnessed',
      // v2.1: contributor is just `source_contributor_name` (and url) when
      // set, null otherwise. The pre-v2 fallback that used source_publisher
      // as a stand-in for contributor on api-method events conflated the
      // two slots — publisher (who the event is FROM) vs. contributor
      // (which app pushed it IN). Service API writes now auto-fill
      // source_contributor_name from the calling key's brand_config.app_name
      // when the caller didn't supply one, so the fallback is no longer
      // needed and was producing wrong-slot data for v2 service events.
      contributor: row.source_contributor_name
        ? { name: row.source_contributor_name, url: row.source_contributor_url || null }
        : null,
      license: 'CC BY 4.0',
    },
  };
}
