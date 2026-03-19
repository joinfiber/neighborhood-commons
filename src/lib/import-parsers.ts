/**
 * Import Parsers — Neighborhood Commons
 *
 * Parse external event feeds (iCal, Eventbrite) into a common format
 * that can be previewed and then saved to the events table.
 *
 * No external dependencies — iCal is parsed as text, Eventbrite via JSON-LD.
 */

// =============================================================================
// TYPES
// =============================================================================

export type ImportSourceType = 'ical' | 'eventbrite';

export interface ImportedEvent {
  name: string;
  start: string;           // ISO 8601 with offset
  end: string | null;       // ISO 8601 with offset
  timezone: string;         // IANA timezone name
  venue_name: string | null;
  address: string | null;
  description: string | null;
  url: string | null;
  cost: string | null;
  image_url: string | null;
  external_id: string | null;
  recurrence: string;       // Our format: none | daily | weekly | etc.
}

// Max events to parse from a single feed (prevent abuse)
const MAX_EVENTS = 200;

// =============================================================================
// FORMAT DETECTION
// =============================================================================

/** Detect the format of a fetched response based on URL pattern, content-type, and content. */
export function detectFormat(url: string, contentType: string, content: string): ImportSourceType | 'unknown' {
  // URL-based detection
  if (/eventbrite\.(com|co\.\w+)/i.test(url)) return 'eventbrite';
  if (/\.ics(\?|$)/i.test(url)) return 'ical';

  // Content-type detection
  if (contentType.includes('text/calendar')) return 'ical';

  // Content sniffing (first 500 chars)
  const head = content.slice(0, 500);
  if (head.includes('BEGIN:VCALENDAR')) return 'ical';
  if (head.includes('application/ld+json') || head.includes('"@type":"Event"')) return 'eventbrite';

  return 'unknown';
}

// =============================================================================
// ICAL PARSER
// =============================================================================

/**
 * Parse an iCal (.ics) feed into ImportedEvent[].
 *
 * Handles:
 * - VEVENT blocks with SUMMARY, DTSTART, DTEND, LOCATION, DESCRIPTION, URL, UID
 * - DTSTART with TZID parameter (e.g., DTSTART;TZID=America/New_York:20260315T190000)
 * - DTSTART in UTC (ending with Z)
 * - DTSTART as DATE-only (all-day events: 20260315)
 * - RRULE to our recurrence format (best-effort mapping)
 * - Folded lines (RFC 5545 §3.1: continuation lines start with space/tab)
 */
export function parseIcalFeed(icalText: string, fallbackTimezone: string = 'America/New_York'): ImportedEvent[] {
  // Unfold continuation lines (RFC 5545 §3.1)
  const unfolded = icalText.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const events: ImportedEvent[] = [];
  let inEvent = false;
  let current: Record<string, string> = {};

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      current = {};
      continue;
    }

    if (line === 'END:VEVENT') {
      inEvent = false;
      const parsed = icalEventToImported(current, fallbackTimezone);
      if (parsed) events.push(parsed);
      if (events.length >= MAX_EVENTS) break;
      continue;
    }

    if (!inEvent) continue;

    // Parse property: NAME;PARAMS:VALUE
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;

    const propFull = line.substring(0, colonIdx);
    const value = line.substring(colonIdx + 1);

    // Store with full property name (including params) for DTSTART;TZID=... parsing
    // But also store the base property name for simple lookups
    const baseProp = propFull.split(';')[0];
    if (baseProp) {
      // For DTSTART/DTEND, keep the full property to preserve TZID params
      if (baseProp === 'DTSTART' || baseProp === 'DTEND') {
        current[propFull] = value;
        current[baseProp] = value;
        current[baseProp + '_FULL'] = propFull;
      } else if (baseProp === 'ATTACH') {
        // Keep full property for FMTTYPE detection
        current['ATTACH'] = value;
        current['ATTACH_FULL'] = propFull;
      } else {
        current[baseProp] = value;
      }
    }
  }

  return events;
}

/** Convert a single iCal VEVENT to ImportedEvent */
function icalEventToImported(props: Record<string, string>, fallbackTimezone: string): ImportedEvent | null {
  const summary = unescapeIcal(props['SUMMARY'] || '');
  if (!summary) return null;

  const dtStartFull = props['DTSTART_FULL'] || 'DTSTART';
  const dtStartVal = props['DTSTART'] || '';
  if (!dtStartVal) return null;

  const dtEndFull = props['DTEND_FULL'] || 'DTEND';
  const dtEndVal = props['DTEND'] || '';

  const timezone = extractTzid(dtStartFull) || fallbackTimezone;
  const start = parseIcalDateTime(dtStartVal, timezone);
  const end = dtEndVal ? parseIcalDateTime(dtEndVal, extractTzid(dtEndFull) || timezone) : null;

  if (!start) return null;

  // Parse location: may be "Venue Name, 123 Main St" or just "Venue Name"
  const rawLocation = unescapeIcal(props['LOCATION'] || '');
  let venue_name: string | null = null;
  let address: string | null = null;
  if (rawLocation) {
    const parts = rawLocation.split(',').map(s => s.trim());
    if (parts.length >= 2) {
      venue_name = parts[0] || null;
      address = parts.slice(1).join(', ');
    } else {
      venue_name = rawLocation;
    }
  }

  return {
    name: summary.slice(0, 200),
    start,
    end,
    timezone,
    venue_name,
    address,
    description: unescapeIcal(props['DESCRIPTION'] || '') || null,
    url: props['URL'] || null,
    cost: null,
    image_url: extractAttachImage(props) || null,
    external_id: props['UID'] || null,
    recurrence: mapRruleToRecurrence(props['RRULE'] || ''),
  };
}

/** Extract image URL from ATTACH property (e.g., ATTACH;FMTTYPE=image/jpeg:https://...) */
function extractAttachImage(props: Record<string, string>): string | null {
  const url = props['ATTACH'];
  if (!url) return null;
  const full = props['ATTACH_FULL'] || '';
  // Only extract if it's an image FMTTYPE or looks like an image URL
  if (/FMTTYPE=image\//i.test(full) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) {
    return url;
  }
  return null;
}

/** Extract TZID from a property string like "DTSTART;TZID=America/New_York" */
function extractTzid(propFull: string): string | null {
  const match = propFull.match(/TZID=([^;:]+)/);
  return match ? match[1] : null;
}

/**
 * Parse an iCal datetime value to ISO 8601.
 *
 * Formats:
 * - 20260315T190000Z  → UTC
 * - 20260315T190000   → local time in given timezone
 * - 20260315          → all-day (midnight in timezone)
 */
function parseIcalDateTime(value: string, timezone: string): string | null {
  const v = value.trim();

  // UTC format: 20260315T190000Z
  if (v.endsWith('Z')) {
    const d = parseIcalDateParts(v.slice(0, -1));
    if (!d) return null;
    return d.toISOString();
  }

  // Local format: 20260315T190000 or date-only: 20260315
  const parts = parseIcalDateComponents(v);
  if (!parts) return null;

  // Build an ISO string with the timezone offset
  const { year, month, day, hour, minute, second } = parts;
  const dateStr = `${year}-${pad(month)}-${pad(day)}`;
  const timeStr = `${pad(hour)}:${pad(minute)}:${pad(second)}`;

  // Use Intl to compute the offset for this specific date in this timezone
  // Date.UTC avoids implementation-dependent parsing of naive datetime strings
  const tempDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    });
    const formatterParts = formatter.formatToParts(tempDate);
    const offsetPart = formatterParts.find(p => p.type === 'timeZoneName');
    if (offsetPart) {
      const match = offsetPart.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
      if (match) {
        const sign = match[1];
        const hours = (match[2] as string).padStart(2, '0');
        const minutes = match[3] || '00';
        return `${dateStr}T${timeStr}${sign}${hours}:${minutes}`;
      }
    }
  } catch {
    // Invalid timezone — fall through
  }

  return `${dateStr}T${timeStr}`;
}

/** Parse iCal date components: 20260315T190000 or 20260315 */
function parseIcalDateComponents(v: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  // With time: 20260315T190000
  const dtMatch = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (dtMatch) {
    return {
      year: parseInt(dtMatch[1]),
      month: parseInt(dtMatch[2]),
      day: parseInt(dtMatch[3]),
      hour: parseInt(dtMatch[4]),
      minute: parseInt(dtMatch[5]),
      second: parseInt(dtMatch[6]),
    };
  }

  // Date only: 20260315
  const dMatch = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dMatch) {
    return {
      year: parseInt(dMatch[1]),
      month: parseInt(dMatch[2]),
      day: parseInt(dMatch[3]),
      hour: 0, minute: 0, second: 0,
    };
  }

  return null;
}

/** Parse iCal datetime string to Date object (UTC assumed or local) */
function parseIcalDateParts(v: string): Date | null {
  const parts = parseIcalDateComponents(v);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Unescape iCal text values */
function unescapeIcal(text: string): string {
  return text
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * Map an iCal RRULE string to our internal recurrence format.
 *
 * Supported mappings:
 * - FREQ=DAILY → daily
 * - FREQ=WEEKLY (no BYDAY or single day) → weekly
 * - FREQ=WEEKLY;INTERVAL=2 → biweekly
 * - FREQ=MONTHLY → monthly
 * - FREQ=WEEKLY;BYDAY=MO,TU,WE → weekly_days:mon,tue,wed
 * - FREQ=MONTHLY;BYDAY=1MO → ordinal_weekday:1:monday
 *
 * Unsupported RRULEs return 'none' (treated as single event).
 */
export function mapRruleToRecurrence(rrule: string): string {
  if (!rrule) return 'none';

  const parts: Record<string, string> = {};
  for (const segment of rrule.split(';')) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx > 0) {
      parts[segment.substring(0, eqIdx)] = segment.substring(eqIdx + 1);
    }
  }

  const freq = parts['FREQ'];
  const interval = parseInt(parts['INTERVAL'] || '1');
  const byday = parts['BYDAY'];

  if (freq === 'DAILY' && interval === 1) return 'daily';

  if (freq === 'WEEKLY') {
    if (interval === 2 && !byday) return 'biweekly';
    if (interval === 1 && byday) {
      // Map BYDAY=MO,TU,WE to weekly_days:mon,tue,wed
      const dayMap: Record<string, string> = {
        SU: 'sun', MO: 'mon', TU: 'tue', WE: 'wed', TH: 'thu', FR: 'fri', SA: 'sat',
      };
      const days = byday.split(',').map(d => dayMap[d]).filter(Boolean);
      if (days.length === 1) return 'weekly'; // Single day = plain weekly
      if (days.length > 1) return `weekly_days:${days.join(',')}`;
    }
    if (interval === 1) return 'weekly';
  }

  if (freq === 'MONTHLY') {
    if (byday) {
      // BYDAY=1MO → ordinal_weekday:1:monday
      const ordMatch = byday.match(/^(\d)(SU|MO|TU|WE|TH|FR|SA)$/);
      if (ordMatch) {
        const dayMap: Record<string, string> = {
          SU: 'sunday', MO: 'monday', TU: 'tuesday', WE: 'wednesday',
          TH: 'thursday', FR: 'friday', SA: 'saturday',
        };
        const dayName = dayMap[ordMatch[2]];
        if (dayName) return `ordinal_weekday:${ordMatch[1]}:${dayName}`;
      }
    }
    if (interval === 1) return 'monthly';
  }

  // Unsupported RRULE — treat as single event
  return 'none';
}

// =============================================================================
// EVENTBRITE PARSER
// =============================================================================

/**
 * Parse an Eventbrite page's HTML to extract events from JSON-LD structured data.
 *
 * Eventbrite embeds Schema.org Event objects as `<script type="application/ld+json">`.
 * This parser extracts those, handling both single events and organizer pages
 * with multiple events.
 */
export function parseEventbritePage(html: string, sourceUrl: string, fallbackTimezone: string = 'America/New_York'): ImportedEvent[] {
  const events: ImportedEvent[] = [];

  // Extract all JSON-LD blocks
  const jsonLdBlocks = extractJsonLd(html);

  for (const block of jsonLdBlocks) {
    if (events.length >= MAX_EVENTS) break;

    try {
      const items = Array.isArray(block) ? block : [block];
      for (const item of items) {
        if (events.length >= MAX_EVENTS) break;
        if (item['@type'] === 'Event' || item['@type']?.includes?.('Event')) {
          const parsed = jsonLdEventToImported(item, sourceUrl, fallbackTimezone);
          if (parsed) events.push(parsed);
        }
      }
    } catch {
      // Skip malformed JSON-LD blocks
    }
  }

  // Fallback: if events have no image, try og:image from the page HTML
  if (events.length > 0) {
    const ogImage = extractOgImage(html);
    if (ogImage) {
      for (const ev of events) {
        if (!ev.image_url) ev.image_url = ogImage;
      }
    }
  }

  return events;
}

/** Extract og:image URL from HTML meta tags */
function extractOgImage(html: string): string | null {
  const match = html.match(/<meta[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["']/i);
  return match?.[1] || null;
}

/** Extract all JSON-LD script blocks from HTML */
function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  const regex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      blocks.push(parsed);
    } catch {
      // Skip malformed JSON
    }
  }

  return blocks;
}

/** Convert a Schema.org Event JSON-LD object to ImportedEvent */
function jsonLdEventToImported(item: Record<string, unknown>, sourceUrl: string, fallbackTimezone: string): ImportedEvent | null {
  const name = String(item['name'] || '').trim();
  if (!name) return null;

  const startDate = String(item['startDate'] || '');
  if (!startDate) return null;

  // Parse timezone from the startDate ISO string or fall back
  const timezone = extractTimezoneFromIso(startDate) || fallbackTimezone;

  // Location
  let venue_name: string | null = null;
  let address: string | null = null;
  const location = item['location'] as Record<string, unknown> | undefined;
  if (location) {
    venue_name = String(location['name'] || '') || null;
    const addr = location['address'] as Record<string, unknown> | string | undefined;
    if (typeof addr === 'string') {
      address = addr;
    } else if (addr && typeof addr === 'object') {
      // Schema.org PostalAddress
      const parts = [
        addr['streetAddress'],
        addr['addressLocality'],
        addr['addressRegion'],
        addr['postalCode'],
      ].filter(Boolean);
      address = parts.join(', ') || null;
    }
  }

  // Price
  let cost: string | null = null;
  const offers = item['offers'] as Record<string, unknown> | Record<string, unknown>[] | undefined;
  if (offers) {
    const offer = Array.isArray(offers) ? offers[0] : offers;
    if (offer) {
      const price = offer['price'];
      const currency = offer['priceCurrency'] || 'USD';
      if (price === '0' || price === 0) {
        cost = 'Free';
      } else if (price != null) {
        cost = `${currency} ${price}`;
      }
    }
  }

  // Image — try JSON-LD image field first
  let image_url: string | null = null;
  const img = item['image'];
  if (typeof img === 'string') {
    image_url = img;
  } else if (Array.isArray(img) && typeof img[0] === 'string') {
    image_url = img[0];
  } else if (img && typeof img === 'object' && 'url' in (img as Record<string, unknown>)) {
    image_url = String((img as Record<string, unknown>)['url']);
  }
  // ImageObject with contentUrl (some Eventbrite pages use this)
  if (!image_url && img && typeof img === 'object' && 'contentUrl' in (img as Record<string, unknown>)) {
    image_url = String((img as Record<string, unknown>)['contentUrl']);
  }

  // External ID from URL
  const eventUrl = String(item['url'] || sourceUrl);
  // Match Eventbrite URLs: /e/slug-123456, /e/123456, /e/slug-123456?aff=...
  const ebIdMatch = eventUrl.match(/eventbrite\.\w+\/e\/(?:[^/]*?-)?(\d+)(?:\?|$)/);
  const external_id = ebIdMatch ? `eventbrite:${ebIdMatch[1]}` : eventUrl;

  return {
    name: name.slice(0, 200),
    start: startDate,
    end: item['endDate'] ? String(item['endDate']) : null,
    timezone,
    venue_name,
    address,
    description: truncateText(stripHtml(String(item['description'] || '')), 2000),
    url: eventUrl || null,
    cost,
    image_url,
    external_id,
    recurrence: 'none', // Eventbrite doesn't expose RRULE in JSON-LD
  };
}

/** Try to extract an IANA timezone from an ISO 8601 datetime string */
function extractTimezoneFromIso(iso: string): string | null {
  // Some Eventbrite dates include timezone name in brackets: 2026-03-15T19:00:00-04:00[America/New_York]
  const tzMatch = iso.match(/\[([A-Za-z_/]+)\]$/);
  if (tzMatch) return tzMatch[1];
  return null;
}

/** Strip HTML tags from a string */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Truncate text to max length at word boundary */
function truncateText(text: string, max: number): string | null {
  if (!text) return null;
  if (text.length <= max) return text;
  const truncated = text.slice(0, max);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > max * 0.8 ? truncated.slice(0, lastSpace) + '...' : truncated + '...';
}
