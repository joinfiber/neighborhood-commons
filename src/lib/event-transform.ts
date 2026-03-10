/**
 * Neighborhood API v0.2 — Event Transform
 *
 * Single source of truth for transforming events table rows (source='portal')
 * to the Neighborhood API event format.
 *
 * Used by:
 * - routes/v1/events.ts (public API responses)
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
  price: string | null;
  link_url: string | null;
  event_image_url: string | null;
  created_at: string;
  portal_accounts: { business_name: string } | null;
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
  recurrence: { rrule: string } | null;
  source: {
    publisher: 'fiber';
    collected_at: string;
    method: 'portal';
    license: 'free-use-with-attribution';
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

/** Map recurrence to iCal RRULE */
export function toRRule(recurrence: string): string | null {
  switch (recurrence) {
    case 'daily': return 'FREQ=DAILY';
    case 'weekly': return 'FREQ=WEEKLY';
    case 'biweekly': return 'FREQ=WEEKLY;INTERVAL=2';
    case 'monthly': return 'FREQ=MONTHLY';
    default: {
      const match = recurrence.match(/^ordinal_weekday:(\d):(\w+)$/);
      if (match) {
        const dayMap: Record<string, string> = {
          monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH',
          friday: 'FR', saturday: 'SA', sunday: 'SU',
        };
        const day = match[2] ? dayMap[match[2]] : undefined;
        if (day) return `FREQ=MONTHLY;BYDAY=${match[1]}${day}`;
      }
      return null;
    }
  }
}

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
    recurrence: rrule ? { rrule } : null,
    source: {
      publisher: 'fiber',
      collected_at: row.created_at,
      method: 'portal',
      license: 'free-use-with-attribution',
    },
  };
}
