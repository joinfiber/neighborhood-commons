/**
 * Event Transform Tests — Neighborhood API v0.2 Spec Compliance
 *
 * These tests verify that toNeighborhoodEvent() produces output
 * conforming to the Neighborhood API event schema. If these fail,
 * consumers of the public API are getting the wrong shape.
 */

import { describe, it, expect } from 'vitest';
import { toNeighborhoodEvent, toIso, slugifyCategory, toRRule, type PortalEventRow } from '../src/lib/event-transform.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    price: 'Free',
    link_url: 'https://example.com/tickets',
    event_image_url: 'https://images.example.com/jazz.jpg',
    created_at: '2026-03-10T12:00:00.000Z',
    portal_accounts: { business_name: 'South Jazz Kitchen' },
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

  it('includes organizer with phone: null', () => {
    const event = toNeighborhoodEvent(makeRow());
    expect(event.organizer).toEqual({
      name: 'South Jazz Kitchen',
      phone: null,
    });
  });

  it('falls back to place_name for organizer when no portal account', () => {
    const event = toNeighborhoodEvent(makeRow({ portal_accounts: null }));
    expect(event.organizer.name).toBe('South Jazz Kitchen');
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
  });

  it('wraps recurrence as { rrule } object', () => {
    const event = toNeighborhoodEvent(makeRow({ recurrence: 'weekly' }));
    expect(event.recurrence).toEqual({ rrule: 'FREQ=WEEKLY' });
  });

  it('returns null recurrence for "none"', () => {
    const event = toNeighborhoodEvent(makeRow({ recurrence: 'none' }));
    expect(event.recurrence).toBeNull();
  });

  it('always includes source with required fields', () => {
    const event = toNeighborhoodEvent(makeRow());
    expect(event.source).toEqual({
      publisher: 'South Jazz Kitchen',
      collected_at: '2026-03-10T12:00:00.000Z',
      method: 'portal',
      license: 'CC BY 4.0',
    });
  });

  it('falls back to "Neighborhood Commons" for publisher when no account', () => {
    const event = toNeighborhoodEvent(makeRow({ portal_accounts: null }));
    expect(event.source.publisher).toBe('Neighborhood Commons');
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
});
