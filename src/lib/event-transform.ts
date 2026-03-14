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

/** Events table row with portal_accounts join (for public API / webhook use) */
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
  start_time_required: boolean;
  tags: string[] | null;
  wheelchair_accessible: boolean | null;
  price: string | null;
  link_url: string | null;
  event_image_url: string | null;
  created_at: string;
  portal_accounts: { business_name: string; wheelchair_accessible?: boolean | null } | null;
}

export interface NeighborhoodEvent {
  id: string;
  name: string;
  start: string;
  end: string | null;
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
  organizer: {
    name: string;
    phone: null;
  };
  cost: string | null;
  series_id: string | null;
  series_instance_number: number | null;
  series_instance_count: number | null;
  start_time_required: boolean;
  tags: string[];
  wheelchair_accessible: boolean | null;
  recurrence: { rrule: string } | null;
  source: {
    publisher: string;
    collected_at: string;
    method: 'portal';
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
      const match = offsetPart.value.match(/GMT([+-]\d+)/);
      if (match?.[1]) {
        const hours = parseInt(match[1], 10);
        const sign = hours >= 0 ? '+' : '-';
        const abs = Math.abs(hours).toString().padStart(2, '0');
        return `${dateStr}T${timeStr}${sign}${abs}:00`;
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

/** Transform an events table row (with portal_accounts join) to Neighborhood API v0.2 format */
export function toNeighborhoodEvent(row: PortalEventRow): NeighborhoodEvent {
  const tz = row.event_timezone || 'America/New_York';
  const rrule = toRRule(row.recurrence);
  return {
    id: row.id,
    name: row.content,
    start: toIso(row.event_at, tz),
    end: row.end_time ? toIso(row.end_time, tz) : null,
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
    organizer: {
      name: row.portal_accounts?.business_name || row.place_name,
      phone: null,
    },
    cost: row.price || null,
    series_id: row.series_id || null,
    series_instance_number: row.series_instance_number || null,
    series_instance_count: null,
    start_time_required: row.start_time_required ?? true,
    tags: row.tags || [],
    wheelchair_accessible: row.wheelchair_accessible ?? row.portal_accounts?.wheelchair_accessible ?? null,
    recurrence: rrule ? { rrule } : null,
    source: {
      publisher: row.portal_accounts?.business_name || 'Neighborhood Commons',
      collected_at: row.created_at,
      method: 'portal',
      license: 'CC BY 4.0',
    },
  };
}
