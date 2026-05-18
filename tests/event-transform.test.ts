/**
 * Event Transform Tests — Neighborhood API v0.2 Spec Compliance
 *
 * These tests verify that toNeighborhoodEvent() produces output
 * conforming to the Neighborhood API event schema. If these fail,
 * consumers of the public API are getting the wrong shape.
 */

import { describe, it, expect } from 'vitest';
import { toNeighborhoodEvent, toIso, slugifyCategory, toRRule, type PortalEventRow } from '../src/lib/event-transform.js';
import { validateTags } from '../src/lib/tags.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// v2 fixture: the legacy `portal_accounts: { business_name, wheelchair_accessible }`
// join is replaced by `organizations: { id, slug, name, portal_accounts: { status } }`.
// Organizer name comes from `organizations.name`; wheelchair_accessible is event-only.
function makeRow(overrides: Partial<PortalEventRow> = {}): PortalEventRow {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    content: 'Jazz Night',
    description: 'Live jazz trio every Friday.',
    place_name: 'South Jazz Kitchen',
    venue_address: '600 N Broad St, Philadelphia',
    place_id: 'ChIJ_test',
    latitude: 39.9632,
    longitude: -75.1551,
    event_at: '2026-03-14T23:00:00.000Z',
    end_time: '2026-03-15T02:00:00.000Z',
    event_timezone: 'America/New_York',
    category: 'live_music',
    custom_category: null,
    recurrence: 'weekly',
    series_id: null,
    series_instance_number: null,
    open_window: false,
    capacity: null,
    rsvp: null,
    tags: ['outdoor', 'free'],
    wheelchair_accessible: null,
    price: 'Free',
    link_url: 'https://example.com/tickets',
    event_image_url: 'https://images.example.com/jazz.jpg',
    created_at: '2026-03-10T12:00:00.000Z',
    source_method: 'self_asserted',
    source_feed_url: null,
    source_contributor_url: null,
    source_contributor_name: null,
    first_party: false,
    tmdb_id: null,
    organizer_org_id: 'org-uuid-jazz',
    organizations: {
      id: 'org-uuid-jazz',
      slug: 'south-jazz-kitchen',
      name: 'South Jazz Kitchen',
      portal_accounts: null,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toNeighborhoodEvent — output shape
// ---------------------------------------------------------------------------

describe('toNeighborhoodEvent', () => {
  it('returns all required Neighborhood API fields', () => {
    const event = toNeighborhoodEvent(makeRow());
    const keys = Object.keys(event);
    expect(keys).toContain('id');
    expect(keys).toContain('name');
    expect(keys).toContain('start');
    expect(keys).toContain('end');
    expect(keys).toContain('timezone');
    expect(keys).toContain('description');
    expect(keys).toContain('category');
    expect(keys).toContain('place_id');
    expect(keys).toContain('location');
    expect(keys).toContain('url');
    expect(keys).toContain('images');
    expect(keys).toContain('organizer');
    expect(keys).toContain('cost');
    expect(keys).toContain('recurrence');
    expect(keys).toContain('source');
  });

  it('maps content → name (spec uses "name", not "title")', () => {
    const event = toNeighborhoodEvent(makeRow({ content: 'Open Mic Night' }));
    expect(event.name).toBe('Open Mic Night');
  });

  it('wraps category in an array', () => {
    const event = toNeighborhoodEvent(makeRow({ category: 'live_music' }));
    expect(Array.isArray(event.category)).toBe(true);
    expect(event.category).toEqual(['live-music']);
  });

  it('nests location as { name, address, lat, lng }', () => {
    const event = toNeighborhoodEvent(makeRow());
    expect(event.location).toEqual({
      name: 'South Jazz Kitchen',
      address: '600 N Broad St, Philadelphia',
      lat: 39.9632,
      lng: -75.1551,
    });
  });

  it('wraps images in an array', () => {
    const event = toNeighborhoodEvent(makeRow({ event_image_url: 'https://img.test/a.jpg' }));
    expect(Array.isArray(event.images)).toBe(true);
    expect(event.images.length).toBe(1);
  });

  it('returns empty images array when no image', () => {
    const event = toNeighborhoodEvent(makeRow({ event_image_url: null }));
    expect(event.images).toEqual([]);
  });

  it('includes organizer with v2 shape (id, slug, name, verified, phone)', () => {
    const event = toNeighborhoodEvent(makeRow());
    expect(event.organizer).toEqual({
      id: 'org-uuid-jazz',
      slug: 'south-jazz-kitchen',
      name: 'South Jazz Kitchen',
      verified: false,
      phone: null,
    });
  });

  it('falls back to place_name for organizer when organizations join is null (pre-migration-081 data)', () => {
    const event = toNeighborhoodEvent(makeRow({ organizations: null, organizer_org_id: null }));
    expect(event.organizer.name).toBe('South Jazz Kitchen');
    expect(event.organizer.id).toBe('');
    expect(event.organizer.slug).toBe('');
  });

  it('marks organizer.verified=true when the organizer is in the hydrated verified set', () => {
    const event = toNeighborhoodEvent(makeRow(), new Set(['org-uuid-jazz']));
    expect(event.organizer.verified).toBe(true);
  });

  it('includes series_id and series_instance_number when present', () => {
    const event = toNeighborhoodEvent(makeRow({
      series_id: 'series-uuid-abc',
      series_instance_number: 3,
    }));
    expect(event.series_id).toBe('series-uuid-abc');
    expect(event.series_instance_number).toBe(3);
  });

  it('returns null for series fields on non-series events', () => {
    const event = toNeighborhoodEvent(makeRow());
    expect(event.series_id).toBeNull();
    expect(event.series_instance_number).toBeNull();
    expect(event.series_instance_count).toBeNull();
  });

  it('passes through open_window (default false)', () => {
    const event = toNeighborhoodEvent(makeRow());
    expect(event.open_window).toBe(false);
  });

  it('passes through open_window = true', () => {
    const event = toNeighborhoodEvent(makeRow({ open_window: true }));
    expect(event.open_window).toBe(true);
  });

  it('passes through capacity and rsvp signals', () => {
    const event = toNeighborhoodEvent(makeRow({ capacity: 50, rsvp: 'required' }));
    expect(event.capacity).toBe(50);
    expect(event.rsvp).toBe('required');
  });

  it('defaults capacity and rsvp to null', () => {
    const event = toNeighborhoodEvent(makeRow());
    expect(event.capacity).toBeNull();
    expect(event.rsvp).toBeNull();
  });

  it('wraps recurrence as { rrule } object', () => {
    const event = toNeighborhoodEvent(makeRow({ recurrence: 'weekly' }));
    expect(event.recurrence).toEqual({ rrule: 'FREQ=WEEKLY' });
  });

  it('returns null recurrence for "none"', () => {
    const event = toNeighborhoodEvent(makeRow({ recurrence: 'none' }));
    expect(event.recurrence).toBeNull();
  });

  it('always includes source with required fields (four-role shape)', () => {
    // Post-085: no `publisher` field — organizer.name fills the role.
    // source carries method + url + contributor + collected_at + license.
    const event = toNeighborhoodEvent(makeRow());
    expect(event.source).toEqual({
      method: 'self_asserted',
      url: null,
      contributor: null,
      collected_at: '2026-03-10T12:00:00.000Z',
      license: 'CC BY 4.0',
    });
    // The organizer.name carries the "who is this from?" role.
    expect(event.organizer.name).toBe('South Jazz Kitchen');
  });

  it('surfaces source_feed_url as source.url on proxied events', () => {
    const event = toNeighborhoodEvent(makeRow({
      source_method: 'proxied',
      source_feed_url: 'https://johnnybrendas.com/calendar',
    }));
    expect(event.source.method).toBe('proxied');
    expect(event.source.url).toBe('https://johnnybrendas.com/calendar');
  });

  it('clears source.url for non-proxied methods even if source_feed_url is set', () => {
    // Defensive: source_feed_url has historically been overloaded (e.g. api-key:<id>).
    // The public response only surfaces it as source.url when method is proxied.
    const event = toNeighborhoodEvent(makeRow({
      source_method: 'self_asserted',
      source_feed_url: 'api-key:abc123',
    }));
    expect(event.source.url).toBeNull();
  });

  // -------------------------------------------------------------------------
  // source.contributor — frozen snapshot of source_contributor_name / url.
  // No publisher fallback; null when the columns are null.
  // -------------------------------------------------------------------------

  describe('source.contributor', () => {
    it('reads source_contributor_name + url when set', () => {
      const event = toNeighborhoodEvent(makeRow({
        source_method: 'self_asserted',
        source_contributor_name: 'Go There',
        source_contributor_url: 'https://gothere.bike',
      }));
      expect(event.source.contributor).toEqual({
        name: 'Go There',
        url: 'https://gothere.bike',
      });
    });

    it('accepts null url when name is set', () => {
      const event = toNeighborhoodEvent(makeRow({
        source_method: 'self_asserted',
        source_contributor_name: 'Go There',
        source_contributor_url: null,
      }));
      expect(event.source.contributor).toEqual({ name: 'Go There', url: null });
    });

    it('returns null when source_contributor_name is null', () => {
      // The legacy fallback that used source_publisher as a stand-in for
      // contributor is retired — null is the honest answer when the column
      // is null. service/events.ts auto-fills source_contributor_name on
      // write from the calling key's brand identity, so this null state
      // only persists on pre-cleanup rows.
      const event = toNeighborhoodEvent(makeRow({
        source_method: 'self_asserted',
        source_contributor_name: null,
        source_contributor_url: null,
      }));
      expect(event.source.contributor).toBeNull();
    });

    it('returns null contributor on proxied events without override', () => {
      const event = toNeighborhoodEvent(makeRow({
        source_method: 'proxied',
        source_feed_url: 'https://philly.gov/calendar.rss',
      }));
      expect(event.source.contributor).toBeNull();
    });
  });

  it('maps price → cost', () => {
    const event = toNeighborhoodEvent(makeRow({ price: '$15' }));
    expect(event.cost).toBe('$15');
  });

  it('maps link_url → url', () => {
    const event = toNeighborhoodEvent(makeRow({ link_url: 'https://tickets.test' }));
    expect(event.url).toBe('https://tickets.test');
  });

  it('returns null for optional fields when absent', () => {
    const event = toNeighborhoodEvent(makeRow({
      end_time: null,
      description: null,
      place_id: null,
      link_url: null,
      price: null,
    }));
    expect(event.end).toBeNull();
    expect(event.description).toBeNull();
    expect(event.place_id).toBeNull();
    expect(event.url).toBeNull();
    expect(event.cost).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toIso — timezone conversion
// ---------------------------------------------------------------------------

describe('toIso', () => {
  it('converts UTC timestamp to timezone-offset ISO 8601', () => {
    const result = toIso('2026-03-14T23:00:00.000Z', 'America/New_York');
    // March 14 is EDT (UTC-4), so 23:00 UTC = 19:00 EDT
    expect(result).toMatch(/2026-03-14T19:00:00-04:00/);
  });

  it('returns original string for invalid dates', () => {
    expect(toIso('not-a-date', 'America/New_York')).toBe('not-a-date');
  });

  it('handles half-hour timezone offsets (Asia/Kolkata = +05:30)', () => {
    const result = toIso('2026-03-14T12:00:00.000Z', 'Asia/Kolkata');
    // 12:00 UTC = 17:30 IST (+05:30)
    expect(result).toBe('2026-03-14T17:30:00+05:30');
  });

  it('handles 45-minute timezone offsets (Asia/Kathmandu = +05:45)', () => {
    const result = toIso('2026-03-14T12:00:00.000Z', 'Asia/Kathmandu');
    // 12:00 UTC = 17:45 NPT (+05:45)
    expect(result).toBe('2026-03-14T17:45:00+05:45');
  });

  it('produces EST offset (-05:00) for January dates', () => {
    const result = toIso('2026-01-15T22:00:00.000Z', 'America/New_York');
    // January = EST (UTC-5), so 22:00 UTC = 17:00 EST
    expect(result).toBe('2026-01-15T17:00:00-05:00');
  });

  it('falls back gracefully for unknown timezone', () => {
    const result = toIso('2026-03-14T23:00:00.000Z', 'Invalid/Timezone');
    // Should return the original string without crashing
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// slugifyCategory
// ---------------------------------------------------------------------------

describe('slugifyCategory', () => {
  it('converts underscored categories to hyphenated slugs', () => {
    expect(slugifyCategory('live_music', null)).toEqual(['live-music']);
  });

  it('uses custom_category for "other" category', () => {
    expect(slugifyCategory('other', 'Pottery Class')).toEqual(['pottery-class']);
  });

  it('returns the category as-is when no mapping found', () => {
    expect(slugifyCategory('unknown_cat', null)).toEqual(['unknown_cat']);
  });
});

// ---------------------------------------------------------------------------
// toRRule — recurrence mapping
// ---------------------------------------------------------------------------

describe('toRRule', () => {
  it('maps "daily" to FREQ=DAILY', () => {
    expect(toRRule('daily')).toBe('FREQ=DAILY');
  });

  it('maps "weekly" to FREQ=WEEKLY', () => {
    expect(toRRule('weekly')).toBe('FREQ=WEEKLY');
  });

  it('maps "biweekly" to FREQ=WEEKLY;INTERVAL=2', () => {
    expect(toRRule('biweekly')).toBe('FREQ=WEEKLY;INTERVAL=2');
  });

  it('maps "monthly" to FREQ=MONTHLY', () => {
    expect(toRRule('monthly')).toBe('FREQ=MONTHLY');
  });

  it('maps ordinal_weekday patterns', () => {
    expect(toRRule('ordinal_weekday:1:friday')).toBe('FREQ=MONTHLY;BYDAY=1FR');
    expect(toRRule('ordinal_weekday:3:tuesday')).toBe('FREQ=MONTHLY;BYDAY=3TU');
  });

  it('maps weekly_days patterns to BYDAY', () => {
    expect(toRRule('weekly_days:mon,tue,wed,thu')).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH');
    expect(toRRule('weekly_days:fri,sat')).toBe('FREQ=WEEKLY;BYDAY=FR,SA');
    expect(toRRule('weekly_days:sun')).toBe('FREQ=WEEKLY;BYDAY=SU');
  });

  it('returns null for "none"', () => {
    expect(toRRule('none')).toBeNull();
  });

  it('returns null for unknown patterns', () => {
    expect(toRRule('yearly')).toBeNull();
  });

  it('appends COUNT when count is provided', () => {
    expect(toRRule('weekly', 8)).toBe('FREQ=WEEKLY;COUNT=8');
    expect(toRRule('daily', 30)).toBe('FREQ=DAILY;COUNT=30');
    expect(toRRule('biweekly', 12)).toBe('FREQ=WEEKLY;INTERVAL=2;COUNT=12');
    expect(toRRule('monthly', 6)).toBe('FREQ=MONTHLY;COUNT=6');
  });

  it('appends COUNT to complex patterns', () => {
    expect(toRRule('weekly_days:mon,tue,wed,thu', 26)).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH;COUNT=26');
    expect(toRRule('ordinal_weekday:3:tuesday', 12)).toBe('FREQ=MONTHLY;BYDAY=3TU;COUNT=12');
  });

  it('omits COUNT when count is 0 or undefined', () => {
    expect(toRRule('weekly', 0)).toBe('FREQ=WEEKLY');
    expect(toRRule('weekly', undefined)).toBe('FREQ=WEEKLY');
  });
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

describe('toNeighborhoodEvent — tags', () => {
  it('passes through tags array', () => {
    const event = toNeighborhoodEvent(makeRow({ tags: ['outdoor', 'free', 'all-ages'] }));
    expect(event.tags).toEqual(['outdoor', 'free', 'all-ages']);
  });

  it('returns empty array when tags is null', () => {
    const event = toNeighborhoodEvent(makeRow({ tags: null }));
    expect(event.tags).toEqual([]);
  });

  it('returns empty array when tags is empty', () => {
    const event = toNeighborhoodEvent(makeRow({ tags: [] }));
    expect(event.tags).toEqual([]);
  });
});

describe('validateTags', () => {
  it('accepts prescribed and custom tags for any category', () => {
    const result = validateTags(['outdoor', 'free', 'tasting', 'jazz-crawl-2026'], 'live_music');
    expect(result).toContain('outdoor');
    expect(result).toContain('free');
    expect(result).toContain('tasting');
    expect(result).toContain('jazz-crawl-2026');
  });

  it('rejects invalid tag formats', () => {
    const result = validateTags(['good-tag', 'BAD TAG', 'also bad!', '123-ok'], 'live_music');
    expect(result).toEqual(['good-tag', '123-ok']);
  });

  it('enforces age tag mutual exclusivity', () => {
    const result = validateTags(['all-ages', '21-plus', 'outdoor'], 'live_music');
    expect(result.filter((t) => ['all-ages', '18-plus', '21-plus'].includes(t))).toHaveLength(1);
    expect(result).toContain('outdoor');
  });

  it('allows all tags for "other" category', () => {
    const result = validateTags(['outdoor', 'tasting', 'volunteer', 'acoustic'], 'other');
    expect(result).toEqual(['outdoor', 'tasting', 'volunteer', 'acoustic']);
  });

  it('returns empty array for empty input', () => {
    expect(validateTags([], 'live_music')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wheelchair accessibility — resolution logic
// ---------------------------------------------------------------------------

describe('toNeighborhoodEvent — wheelchair_accessible', () => {
  // v2: wheelchair_accessible is event-level only. The legacy fallback
  // to portal_accounts.wheelchair_accessible was retired with migration 082.
  it('returns null when the event-level value is null', () => {
    const event = toNeighborhoodEvent(makeRow());
    expect(event.wheelchair_accessible).toBeNull();
  });

  it('uses event-level true when set', () => {
    const event = toNeighborhoodEvent(makeRow({ wheelchair_accessible: true }));
    expect(event.wheelchair_accessible).toBe(true);
  });

  it('uses event-level false when set', () => {
    const event = toNeighborhoodEvent(makeRow({ wheelchair_accessible: false }));
    expect(event.wheelchair_accessible).toBe(false);
  });
});
