/**
 * Import Parser Tests — Neighborhood Commons
 *
 * Tests for iCal and Eventbrite parsers (src/lib/import-parsers.ts).
 * Verifies that external feed data is correctly mapped to ImportedEvent shape.
 */

import { describe, it, expect } from 'vitest';
import { parseIcalFeed, parseEventbritePage, detectFormat, mapRruleToRecurrence } from '../src/lib/import-parsers.js';
import { toNeighborhoodEvent, type PortalEventRow } from '../src/lib/event-transform.js';

// =============================================================================
// FORMAT DETECTION
// =============================================================================

describe('detectFormat', () => {
  it('detects iCal from URL ending in .ics', () => {
    expect(detectFormat('https://example.com/events.ics', '', '')).toBe('ical');
  });

  it('detects iCal from .ics URL with query params', () => {
    expect(detectFormat('https://example.com/feed.ics?token=abc', '', '')).toBe('ical');
  });

  it('detects Eventbrite from URL domain', () => {
    expect(detectFormat('https://www.eventbrite.com/o/my-org-12345', '', '')).toBe('eventbrite');
  });

  it('detects iCal from content-type', () => {
    expect(detectFormat('https://example.com/feed', 'text/calendar; charset=utf-8', '')).toBe('ical');
  });

  it('detects iCal from content sniffing', () => {
    expect(detectFormat('https://example.com/feed', 'text/plain', 'BEGIN:VCALENDAR\nVERSION:2.0')).toBe('ical');
  });

  it('returns unknown for unrecognized format', () => {
    expect(detectFormat('https://example.com/page', 'text/html', '<html><body>Hello</body></html>')).toBe('unknown');
  });
});

// =============================================================================
// ICAL PARSER
// =============================================================================

const MINIMAL_ICAL = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
SUMMARY:Friday Jazz Night
DTSTART;TZID=America/New_York:20260320T190000
DTEND;TZID=America/New_York:20260320T220000
LOCATION:The Jazz Spot\\, 123 Main St
DESCRIPTION:Live jazz every Friday.\\nFree admission.
URL:https://example.com/jazz
UID:jazz-001@example.com
END:VEVENT
END:VCALENDAR`;

describe('parseIcalFeed', () => {
  it('parses a minimal iCal feed', () => {
    const events = parseIcalFeed(MINIMAL_ICAL);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.name).toBe('Friday Jazz Night');
    expect(e.timezone).toBe('America/New_York');
    expect(e.venue_name).toBe('The Jazz Spot');
    expect(e.address).toBe('123 Main St');
    expect(e.description).toContain('Live jazz every Friday.');
    expect(e.description).toContain('\n'); // Unescaped newline
    expect(e.url).toBe('https://example.com/jazz');
    expect(e.external_id).toBe('jazz-001@example.com');
    expect(e.recurrence).toBe('none');
  });

  it('parses UTC datetime (Z suffix)', () => {
    const ical = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:UTC Event
DTSTART:20260315T230000Z
UID:utc-001
END:VEVENT
END:VCALENDAR`;
    const events = parseIcalFeed(ical);
    expect(events).toHaveLength(1);
    expect(events[0].start).toContain('2026-03-15');
  });

  it('parses date-only (all-day) events', () => {
    const ical = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:All Day Market
DTSTART:20260321
UID:allday-001
END:VEVENT
END:VCALENDAR`;
    const events = parseIcalFeed(ical);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('All Day Market');
    expect(events[0].start).toContain('2026-03-21');
  });

  it('handles folded lines (RFC 5545 continuation)', () => {
    const ical = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:A very long event name that
 continues on the next line
DTSTART:20260315T190000Z
UID:fold-001
END:VEVENT
END:VCALENDAR`;
    const events = parseIcalFeed(ical);
    expect(events).toHaveLength(1);
    // RFC 5545 §3.1: folded lines start with a space which is part of the continuation
    expect(events[0].name).toBe('A very long event name thatcontinues on the next line');
  });

  it('handles missing optional fields gracefully', () => {
    const ical = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Bare Event
DTSTART:20260315T190000Z
UID:bare-001
END:VEVENT
END:VCALENDAR`;
    const events = parseIcalFeed(ical);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.end).toBeNull();
    expect(e.venue_name).toBeNull();
    expect(e.description).toBeNull();
    expect(e.url).toBeNull();
    expect(e.cost).toBeNull();
  });

  it('skips events with no SUMMARY', () => {
    const ical = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART:20260315T190000Z
UID:nosummary
END:VEVENT
END:VCALENDAR`;
    const events = parseIcalFeed(ical);
    expect(events).toHaveLength(0);
  });

  it('parses multiple events', () => {
    const ical = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Event One
DTSTART:20260315T190000Z
UID:multi-001
END:VEVENT
BEGIN:VEVENT
SUMMARY:Event Two
DTSTART:20260316T190000Z
UID:multi-002
END:VEVENT
BEGIN:VEVENT
SUMMARY:Event Three
DTSTART:20260317T190000Z
UID:multi-003
END:VEVENT
END:VCALENDAR`;
    const events = parseIcalFeed(ical);
    expect(events).toHaveLength(3);
    expect(events[0].name).toBe('Event One');
    expect(events[2].name).toBe('Event Three');
  });

  it('parses RRULE for recurring events', () => {
    const ical = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Weekly Trivia
DTSTART;TZID=America/New_York:20260315T200000
RRULE:FREQ=WEEKLY
UID:recurring-001
END:VEVENT
END:VCALENDAR`;
    const events = parseIcalFeed(ical);
    expect(events).toHaveLength(1);
    expect(events[0].recurrence).toBe('weekly');
  });

  it('uses fallback timezone when TZID not present', () => {
    const ical = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:No TZ Event
DTSTART:20260315T190000
UID:notz-001
END:VEVENT
END:VCALENDAR`;
    const events = parseIcalFeed(ical, 'America/Chicago');
    expect(events).toHaveLength(1);
    expect(events[0].timezone).toBe('America/Chicago');
  });

  it('handles empty feed', () => {
    const events = parseIcalFeed('BEGIN:VCALENDAR\nEND:VCALENDAR');
    expect(events).toHaveLength(0);
  });

  it('handles malformed content without crashing', () => {
    const events = parseIcalFeed('this is not ical data at all');
    expect(events).toHaveLength(0);
  });

  it('handles location without comma (no address split)', () => {
    const ical = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Simple Location
DTSTART:20260315T190000Z
LOCATION:The Bar
UID:loc-001
END:VEVENT
END:VCALENDAR`;
    const events = parseIcalFeed(ical);
    expect(events[0].venue_name).toBe('The Bar');
    expect(events[0].address).toBeNull();
  });
});

// =============================================================================
// RRULE MAPPING
// =============================================================================

describe('mapRruleToRecurrence', () => {
  it('maps FREQ=DAILY to daily', () => {
    expect(mapRruleToRecurrence('FREQ=DAILY')).toBe('daily');
  });

  it('maps FREQ=WEEKLY to weekly', () => {
    expect(mapRruleToRecurrence('FREQ=WEEKLY')).toBe('weekly');
  });

  it('maps FREQ=WEEKLY;INTERVAL=2 to biweekly', () => {
    expect(mapRruleToRecurrence('FREQ=WEEKLY;INTERVAL=2')).toBe('biweekly');
  });

  it('maps FREQ=MONTHLY to monthly', () => {
    expect(mapRruleToRecurrence('FREQ=MONTHLY')).toBe('monthly');
  });

  it('maps FREQ=WEEKLY;BYDAY=MO,WE,FR to weekly_days', () => {
    expect(mapRruleToRecurrence('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toBe('weekly_days:mon,wed,fri');
  });

  it('maps FREQ=WEEKLY;BYDAY=TH (single day) to weekly', () => {
    expect(mapRruleToRecurrence('FREQ=WEEKLY;BYDAY=TH')).toBe('weekly');
  });

  it('maps FREQ=MONTHLY;BYDAY=1MO to ordinal_weekday:1:monday', () => {
    expect(mapRruleToRecurrence('FREQ=MONTHLY;BYDAY=1MO')).toBe('ordinal_weekday:1:monday');
  });

  it('maps FREQ=MONTHLY;BYDAY=3FR to ordinal_weekday:3:friday', () => {
    expect(mapRruleToRecurrence('FREQ=MONTHLY;BYDAY=3FR')).toBe('ordinal_weekday:3:friday');
  });

  it('returns none for empty string', () => {
    expect(mapRruleToRecurrence('')).toBe('none');
  });

  it('returns none for unsupported FREQ=YEARLY', () => {
    expect(mapRruleToRecurrence('FREQ=YEARLY')).toBe('none');
  });
});

// =============================================================================
// EVENTBRITE PARSER
// =============================================================================

describe('parseEventbritePage', () => {
  const makeHtml = (jsonLd: unknown) => `
    <html><head>
      <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    </head><body></body></html>
  `;

  it('parses a single Event from JSON-LD', () => {
    const html = makeHtml({
      '@type': 'Event',
      name: 'Philly Comedy Night',
      startDate: '2026-03-20T20:00:00-04:00',
      endDate: '2026-03-20T22:00:00-04:00',
      location: {
        name: 'Good Good Comedy',
        address: {
          streetAddress: '215 N Broad St',
          addressLocality: 'Philadelphia',
          addressRegion: 'PA',
          postalCode: '19107',
        },
      },
      description: '<p>Stand-up comedy showcase.</p>',
      offers: { price: '15', priceCurrency: 'USD' },
      url: 'https://www.eventbrite.com/e/comedy-night-123456789',
      image: 'https://img.eventbrite.com/comedy.jpg',
    });

    const events = parseEventbritePage(html, 'https://www.eventbrite.com/e/comedy-night-123456789');
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.name).toBe('Philly Comedy Night');
    expect(e.start).toContain('2026-03-20');
    expect(e.venue_name).toBe('Good Good Comedy');
    expect(e.address).toContain('215 N Broad St');
    expect(e.description).toBe('Stand-up comedy showcase.');
    expect(e.cost).toBe('USD 15');
    expect(e.image_url).toBe('https://img.eventbrite.com/comedy.jpg');
    expect(e.external_id).toBe('eventbrite:123456789');
  });

  it('handles free events', () => {
    const html = makeHtml({
      '@type': 'Event',
      name: 'Free Show',
      startDate: '2026-03-20T20:00:00-04:00',
      offers: { price: '0', priceCurrency: 'USD' },
    });
    const events = parseEventbritePage(html, 'https://www.eventbrite.com/e/free-show-111');
    expect(events).toHaveLength(1);
    expect(events[0].cost).toBe('Free');
  });

  it('handles missing optional fields', () => {
    const html = makeHtml({
      '@type': 'Event',
      name: 'Minimal Event',
      startDate: '2026-03-20T20:00:00-04:00',
    });
    const events = parseEventbritePage(html, 'https://example.com');
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.venue_name).toBeNull();
    expect(e.address).toBeNull();
    expect(e.cost).toBeNull();
    expect(e.image_url).toBeNull();
    expect(e.recurrence).toBe('none');
  });

  it('skips non-Event JSON-LD', () => {
    const html = makeHtml({
      '@type': 'Organization',
      name: 'Not an Event',
    });
    const events = parseEventbritePage(html, 'https://example.com');
    expect(events).toHaveLength(0);
  });

  it('handles page with no JSON-LD', () => {
    const events = parseEventbritePage('<html><body>No events here</body></html>', 'https://example.com');
    expect(events).toHaveLength(0);
  });

  it('handles image as array', () => {
    const html = makeHtml({
      '@type': 'Event',
      name: 'Image Array Event',
      startDate: '2026-03-20T20:00:00-04:00',
      image: ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'],
    });
    const events = parseEventbritePage(html, 'https://example.com');
    expect(events[0].image_url).toBe('https://img.example.com/1.jpg');
  });

  it('strips HTML from description', () => {
    const html = makeHtml({
      '@type': 'Event',
      name: 'HTML Desc',
      startDate: '2026-03-20T20:00:00-04:00',
      description: '<p>This is <strong>bold</strong> and <em>italic</em>.</p>',
    });
    const events = parseEventbritePage(html, 'https://example.com');
    expect(events[0].description).toBe('This is bold and italic .');
  });
});

// =============================================================================
// CONTRIBUTOR CREDIT (source field in transforms)
// =============================================================================

describe('contributor credit in toNeighborhoodEvent', () => {
  function makeRow(overrides: Partial<PortalEventRow> = {}): PortalEventRow {
    return {
      id: '123e4567-e89b-12d3-a456-426614174000',
      content: 'Test Event',
      description: null,
      place_name: 'Test Venue',
      venue_address: null,
      place_id: null,
      latitude: null,
      longitude: null,
      event_at: '2026-03-14T23:00:00.000Z',
      end_time: null,
      event_timezone: 'America/New_York',
      category: 'live_music',
      custom_category: null,
      recurrence: 'none',
      series_id: null,
      series_instance_number: null,
      start_time_required: true,
      tags: [],
      wheelchair_accessible: null,
      price: null,
      link_url: null,
      event_image_url: null,
      created_at: '2026-03-10T12:00:00.000Z',
      source_method: null,
      source_publisher: null,
      portal_accounts: { business_name: 'Test Biz' },
      ...overrides,
    };
  }

  it('uses portal_accounts.business_name as publisher when source_publisher is null', () => {
    const event = toNeighborhoodEvent(makeRow());
    expect(event.source.publisher).toBe('Test Biz');
    expect(event.source.method).toBe('portal');
  });

  it('uses source_publisher when set (API contributor)', () => {
    const event = toNeighborhoodEvent(makeRow({
      source_method: 'api',
      source_publisher: 'Fishtown Events App',
    }));
    expect(event.source.publisher).toBe('Fishtown Events App');
    expect(event.source.method).toBe('api');
  });

  it('uses source_method import for imported events', () => {
    const event = toNeighborhoodEvent(makeRow({
      source_method: 'import',
      source_publisher: 'Eventbrite',
    }));
    expect(event.source.publisher).toBe('Eventbrite');
    expect(event.source.method).toBe('import');
  });

  it('falls back to Neighborhood Commons when both publisher fields are null', () => {
    const event = toNeighborhoodEvent(makeRow({
      portal_accounts: null,
      source_publisher: null,
    }));
    expect(event.source.publisher).toBe('Neighborhood Commons');
  });

  it('always includes CC BY 4.0 license', () => {
    const event = toNeighborhoodEvent(makeRow({ source_method: 'api' }));
    expect(event.source.license).toBe('CC BY 4.0');
  });
});
