/**
 * CSV Helpers — Neighborhood Commons
 *
 * Simple RFC 4180 CSV parser, column auto-detection, and category mapping
 * lookup for the portal CSV contribution flow.
 */

import { supabaseAdmin } from './supabase.js';
import { EVENT_CATEGORY_KEYS } from './categories.js';

// =============================================================================
// CSV PARSING
// =============================================================================

/**
 * Parse a CSV string into headers + rows. Handles quoted fields, escaped
 * quotes (""), and CRLF/LF line endings per RFC 4180.
 */
export function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  // Strip BOM
  const cleaned = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

  const lines = splitCSVLines(cleaned);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = parseCSVRow(lines[0]!).map(h => h.trim());
  if (lines.length < 2) {
    return { headers, rows: [] };
  }
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;

    const values = parseCSVRow(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = (values[j] || '').trim();
    }
    rows.push(row);
  }

  return { headers, rows };
}

/** Split CSV text into logical lines, respecting quoted fields that span multiple lines */
function splitCSVLines(text: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      lines.push(current);
      current = '';
      // Skip \r\n pair
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Parse a single CSV row into field values */
function parseCSVRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++; // Skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// =============================================================================
// COLUMN AUTO-DETECTION
// =============================================================================

/**
 * Known header synonyms → database field mapping.
 * Keys are lowercased, trimmed header names from contributor CSVs.
 */
const HEADER_SYNONYMS: Record<string, string> = {
  // name / title → content (event name)
  'name': 'name',
  'title': 'name',
  'event': 'name',
  'event name': 'name',
  'event_name': 'name',
  'event title': 'name',
  'event_title': 'name',

  // date
  'date': 'date',
  'event date': 'date',
  'event_date': 'date',
  'start date': 'date',
  'start_date': 'date',

  // start time
  'time': 'start_time',
  'start time': 'start_time',
  'start_time': 'start_time',
  'starts': 'start_time',
  'starts at': 'start_time',

  // end time
  'end time': 'end_time',
  'end_time': 'end_time',
  'ends': 'end_time',
  'ends at': 'end_time',

  // start (combined datetime)
  'start': 'start',
  'start_at': 'start',
  'starts_at': 'start',
  'begin': 'start',

  // end (combined datetime)
  'end': 'end',
  'end_at': 'end',
  'ends_at': 'end',

  // venue / location
  'venue': 'venue_name',
  'venue name': 'venue_name',
  'venue_name': 'venue_name',
  'location': 'venue_name',
  'location name': 'venue_name',
  'location_name': 'venue_name',
  'place': 'venue_name',
  'place name': 'venue_name',
  'place_name': 'venue_name',

  // address
  'address': 'address',
  'venue address': 'address',
  'venue_address': 'address',
  'street address': 'address',
  'location address': 'address',

  // category
  'category': 'category',
  'type': 'category',
  'event type': 'category',
  'event_type': 'category',
  'event category': 'category',

  // description
  'description': 'description',
  'details': 'description',
  'about': 'description',
  'summary': 'description',

  // price / cost
  'price': 'price',
  'cost': 'price',
  'ticket price': 'price',
  'admission': 'price',

  // url
  'url': 'ticket_url',
  'link': 'ticket_url',
  'ticket url': 'ticket_url',
  'ticket_url': 'ticket_url',
  'website': 'ticket_url',
  'event url': 'ticket_url',
  'event_url': 'ticket_url',

  // image
  'image': 'image_url',
  'image url': 'image_url',
  'image_url': 'image_url',
  'photo': 'image_url',
  'photo url': 'image_url',

  // latitude/longitude
  'latitude': 'latitude',
  'lat': 'latitude',
  'longitude': 'longitude',
  'lng': 'longitude',
  'lon': 'longitude',
};

/** DB fields that can be mapped to from CSV columns */
export const MAPPABLE_FIELDS = [
  'name', 'date', 'start_time', 'end_time', 'start', 'end',
  'venue_name', 'address', 'category', 'description',
  'price', 'ticket_url', 'image_url', 'latitude', 'longitude',
] as const;

export type MappableField = typeof MAPPABLE_FIELDS[number];

/**
 * Auto-detect column mapping from CSV headers.
 * Returns { csvHeader: dbField } for recognized headers.
 */
export function autoDetectMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const usedFields = new Set<string>();

  for (const header of headers) {
    const normalized = header.toLowerCase().trim();
    const field = HEADER_SYNONYMS[normalized];
    if (field && !usedFields.has(field)) {
      mapping[header] = field;
      usedFields.add(field);
    }
  }
  return mapping;
}

// =============================================================================
// CATEGORY MAPPING
// =============================================================================

const categorySet = new Set<string>(EVENT_CATEGORY_KEYS);

/**
 * Look up category terms in the shared category_mappings table.
 * Returns { sourceTerm: canonicalCategory } for known terms.
 * Terms that are already valid category keys are returned directly.
 */
export async function lookupCategoryMappings(
  terms: string[],
): Promise<{ mapped: Record<string, string>; unmapped: string[] }> {
  const mapped: Record<string, string> = {};
  const needsLookup: string[] = [];

  for (const term of terms) {
    const normalized = term.toLowerCase().trim();
    if (!normalized) continue;

    // Direct match against EVENT_CATEGORY_KEYS
    if (categorySet.has(normalized)) {
      mapped[term] = normalized;
    } else {
      needsLookup.push(term);
    }
  }

  if (needsLookup.length > 0) {
    const normalizedTerms = needsLookup.map(t => t.toLowerCase().trim());
    const { data } = await supabaseAdmin
      .from('category_mappings')
      .select('source_term, canonical_category')
      .in('source_term', normalizedTerms);

    if (data) {
      const lookupMap = new Map(data.map(r => [r.source_term, r.canonical_category]));
      for (const term of needsLookup) {
        const canonical = lookupMap.get(term.toLowerCase().trim());
        if (canonical) {
          mapped[term] = canonical;
        }
      }
    }
  }

  const unmapped = terms.filter(t => !mapped[t] && t.trim());
  return { mapped, unmapped };
}

/**
 * Save new category mappings contributed by a user.
 * Skips terms that already have a mapping (UNIQUE constraint).
 */
export async function saveCategoryMappings(
  mappings: Record<string, string>,
  accountId: string,
): Promise<void> {
  const rows = Object.entries(mappings)
    .filter(([, canonical]) => categorySet.has(canonical))
    .map(([term, canonical]) => ({
      source_term: term.toLowerCase().trim(),
      canonical_category: canonical,
      confidence: 'contributor' as const,
      created_by_account_id: accountId,
    }));

  if (rows.length === 0) return;

  // Upsert: don't overwrite confirmed mappings
  const { error } = await supabaseAdmin
    .from('category_mappings')
    .upsert(rows, { onConflict: 'source_term', ignoreDuplicates: true });

  if (error) {
    console.error('[CSV] Failed to save category mappings:', error.message);
  }
}

// =============================================================================
// ROW VALIDATION
// =============================================================================

interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate a mapped contribution row. Returns errors (empty = valid).
 * Uses the same rules as event creation but adapted for CSV data.
 */
export function validateContributionRow(
  mapped: Record<string, string>,
  category: string | null,
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Name is required
  const name = mapped['name'];
  if (!name || !name.trim()) {
    errors.push({ field: 'name', message: 'Event name is required' });
  } else if (name.length > 200) {
    errors.push({ field: 'name', message: 'Event name must be 200 characters or less' });
  }

  // Date or start datetime is required
  const date = mapped['date'];
  const start = mapped['start'];
  if (!date && !start) {
    errors.push({ field: 'date', message: 'Event date is required' });
  } else if (date) {
    // Attempt to parse various date formats
    const parsed = parseFlexibleDate(date);
    if (!parsed) {
      errors.push({ field: 'date', message: `Could not parse date: "${date}". Use YYYY-MM-DD, MM/DD/YYYY, or similar.` });
    }
  } else if (start) {
    const d = new Date(start);
    if (isNaN(d.getTime())) {
      errors.push({ field: 'start', message: `Could not parse start datetime: "${start}"` });
    }
  }

  // Category must be valid (either already mapped or a known key)
  if (category && !categorySet.has(category)) {
    errors.push({ field: 'category', message: `Unknown category: "${category}"` });
  }

  // Venue name: optional but validated if present
  const venueName = mapped['venue_name'];
  if (venueName && venueName.length > 200) {
    errors.push({ field: 'venue_name', message: 'Venue name must be 200 characters or less' });
  }

  // Description length
  const description = mapped['description'];
  if (description && description.length > 5000) {
    errors.push({ field: 'description', message: 'Description must be 5000 characters or less' });
  }

  // Coordinates
  const lat = mapped['latitude'];
  const lng = mapped['longitude'];
  if (lat) {
    const n = parseFloat(lat);
    if (isNaN(n) || n < -90 || n > 90) {
      errors.push({ field: 'latitude', message: 'Latitude must be between -90 and 90' });
    }
  }
  if (lng) {
    const n = parseFloat(lng);
    if (isNaN(n) || n < -180 || n > 180) {
      errors.push({ field: 'longitude', message: 'Longitude must be between -180 and 180' });
    }
  }

  return errors;
}

// =============================================================================
// DATE PARSING
// =============================================================================

/** Validate that a YYYY-MM-DD string represents an actual calendar date (handles leap years etc.) */
function isValidCalendarDate(dateStr: string): boolean {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return false;
  // Check that the parsed date matches the input (catches Feb 29 on non-leap years, Apr 31, etc.)
  return d.toISOString().startsWith(dateStr);
}

/**
 * Parse a date string in various common formats.
 * Returns YYYY-MM-DD string or null if unparseable.
 */
export function parseFlexibleDate(input: string): string | null {
  const trimmed = input.trim();

  // YYYY-MM-DD (ISO)
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed + 'T00:00:00');
    return isNaN(d.getTime()) ? null : trimmed;
  }

  // MM/DD/YYYY or M/D/YYYY
  const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, m, d, y] = usMatch;
    const dateStr = `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
    if (!isValidCalendarDate(dateStr)) return null;
    return dateStr;
  }

  // DD-MM-YYYY or DD.MM.YYYY
  const euMatch = trimmed.match(/^(\d{1,2})[.\-](\d{1,2})[.\-](\d{4})$/);
  if (euMatch) {
    const [, d, m, y] = euMatch;
    const dateStr = `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
    if (!isValidCalendarDate(dateStr)) return null;
    return dateStr;
  }

  // ISO 8601 datetime — extract date portion
  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoMatch) {
    const d = new Date(isoMatch[1]! + 'T00:00:00');
    return isNaN(d.getTime()) ? null : isoMatch[1]!;
  }

  // Fallback: try Date.parse
  const fallback = new Date(trimmed);
  if (!isNaN(fallback.getTime())) {
    return fallback.toISOString().split('T')[0]!;
  }

  return null;
}

/**
 * Parse a time string in various formats.
 * Returns HH:MM (24-hour) or null.
 */
export function parseFlexibleTime(input: string): string | null {
  const trimmed = input.trim();

  // HH:MM or HH:MM:SS (24-hour)
  const time24 = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (time24) {
    const h = parseInt(time24[1]!);
    const m = parseInt(time24[2]!);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }

  // 12-hour format: 7:30 PM, 7:30PM, 7:30pm
  const time12 = trimmed.match(/^(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)$/);
  if (time12) {
    let h = parseInt(time12[1]!);
    const m = parseInt(time12[2]!);
    const ampm = time12[3]!.toLowerCase();
    if (ampm === 'pm' && h !== 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }

  return null;
}
