/**
 * Public Pages Tests — Neighborhood Commons
 *
 * Tests for server-rendered HTML pages: event detail, venue page,
 * per-venue iCal feed. Verifies HTML structure, structured data,
 * Open Graph tags, cache headers, and 404 behavior.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

// ---------------------------------------------------------------------------
// Mock Supabase
// ---------------------------------------------------------------------------

const mockResponses = vi.hoisted(() => {
  return new Map<string, { data: unknown; error: unknown; count?: number }>();
});

const mockAuthUser = vi.hoisted(() => {
  return { value: { data: { user: null }, error: { message: 'invalid token' } } as unknown };
});

vi.mock('../src/lib/supabase.js', () => {
  function createQueryChain(table: string) {
    const chain: Record<string, unknown> = {};
    const chainMethods = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in',
      'insert', 'update', 'delete', 'upsert', 'maybeSingle', 'single',
    ];

    for (const method of chainMethods) {
      chain[method] = () => chain;
    }

    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      const response = mockResponses.get(table) || { data: null, error: null, count: 0 };
      return Promise.resolve(response).then(resolve, reject);
    };

    return chain;
  }

  return {
    supabaseAdmin: {
      from: (table: string) => createQueryChain(table),
      auth: {
        getUser: () => Promise.resolve(mockAuthUser.value),
      },
    },
    createUserClient: () => ({
      from: (table: string) => createQueryChain(table),
    }),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createApp } from '../src/app.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    content: 'Friday Jazz Night',
    description: 'Live jazz every Friday featuring local artists.',
    place_name: 'The Jazz Spot',
    venue_address: '123 Main St, Philadelphia, PA',
    place_id: 'ChIJ_jazz_spot',
    latitude: 39.9743,
    longitude: -75.1340,
    event_at: '2026-03-20T23:00:00.000Z',
    end_time: '2026-03-21T02:00:00.000Z',
    event_timezone: 'America/New_York',
    category: 'live_music',
    custom_category: null,
    recurrence: 'none',
    price: 'Free',
    link_url: 'https://example.com/jazz',
    event_image_url: 'https://images.example.com/jazz.jpg',
    created_at: '2026-03-10T12:00:00.000Z',
    creator_account_id: 'acc-uuid-1',
    series_id: null,
    series_instance_number: null,
    start_time_required: true,
    tags: ['free', 'live-music'],
    wheelchair_accessible: true,
    source_method: 'portal',
    source_publisher: null,
    portal_accounts: { business_name: 'The Jazz Spot', wheelchair_accessible: true },
    ...overrides,
  };
}

function makeAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc-uuid-1',
    business_name: 'The Jazz Spot',
    slug: 'the-jazz-spot',
    description: 'Live jazz in the heart of Fishtown.',
    website: 'https://thejazzspot.com',
    logo_url: null,
    default_address: '123 Main St, Philadelphia, PA',
    default_latitude: 39.9743,
    default_longitude: -75.1340,
    status: 'active',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

beforeAll(() => {
  const app = createApp();
  return new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  return new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
});

beforeEach(() => {
  mockResponses.clear();
});

// =============================================================================
// EVENT DETAIL PAGE
// =============================================================================

describe('GET /events/:id', () => {
  it('returns HTML with event details and structured data', async () => {
    const row = makeEventRow();
    // First call: event fetch; second call: account slug lookup
    mockResponses.set('events', { data: row, error: null });
    mockResponses.set('portal_accounts', { data: { slug: 'the-jazz-spot' }, error: null });

    const res = await fetch(`${baseUrl}/events/${row.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toContain('max-age=300');

    const html = await res.text();

    // Title and name
    expect(html).toContain('Friday Jazz Night');
    expect(html).toContain('<h1');

    // Venue
    expect(html).toContain('The Jazz Spot');
    expect(html).toContain('123 Main St, Philadelphia, PA');

    // Category badge
    expect(html).toContain('Live Music');

    // Open Graph tags
    expect(html).toContain('og:title');
    expect(html).toContain('og:description');
    expect(html).toContain('og:url');
    expect(html).toContain('og:image');

    // Structured data (JSON-LD)
    expect(html).toContain('application/ld+json');
    expect(html).toContain('"@type":"Event"');
    expect(html).toContain('"name":"Friday Jazz Night"');

    // Add to calendar buttons
    expect(html).toContain('Google Calendar');
    expect(html).toContain('.ics');

    // Tags
    expect(html).toContain('free');
    expect(html).toContain('live-music');

    // Accessibility indicator
    expect(html).toContain('Wheelchair accessible');

    // Source attribution
    expect(html).toContain('CC BY 4.0');

    // Price
    expect(html).toContain('Free');
  });

  it('returns 404 for invalid UUID', async () => {
    const res = await fetch(`${baseUrl}/events/not-a-uuid`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('404');
  });

  it('returns 404 for non-existent event', async () => {
    mockResponses.set('events', { data: null, error: null });

    const res = await fetch(`${baseUrl}/events/a1b2c3d4-e5f6-7890-abcd-ef1234567890`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('404');
  });

  it('handles events without optional fields', async () => {
    const row = makeEventRow({
      description: null,
      event_image_url: null,
      price: null,
      link_url: null,
      tags: null,
      wheelchair_accessible: null,
      end_time: null,
    });
    mockResponses.set('events', { data: row, error: null });
    mockResponses.set('portal_accounts', { data: null, error: null });

    const res = await fetch(`${baseUrl}/events/${row.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Friday Jazz Night');
    // No image hero
    expect(html).not.toContain('nc-event-hero');
    // No description section
    expect(html).not.toContain('nc-event-description');
  });

  it('includes Twitter Card meta tags', async () => {
    mockResponses.set('events', { data: makeEventRow(), error: null });
    mockResponses.set('portal_accounts', { data: null, error: null });

    const res = await fetch(`${baseUrl}/events/a1b2c3d4-e5f6-7890-abcd-ef1234567890`);
    const html = await res.text();
    expect(html).toContain('twitter:card');
    expect(html).toContain('twitter:title');
  });
});

// =============================================================================
// VENUE PAGE
// =============================================================================

describe('GET /venues/:slug', () => {
  it('returns HTML with venue details and event list', async () => {
    const account = makeAccountRow();
    const events = [
      makeEventRow({ id: 'evt-1', content: 'Jazz Night' }),
      makeEventRow({ id: 'evt-2', content: 'Blues Brunch', category: 'food_drink' }),
    ];
    mockResponses.set('portal_accounts', { data: account, error: null });
    mockResponses.set('events', { data: events, error: null });

    const res = await fetch(`${baseUrl}/venues/the-jazz-spot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toContain('max-age=300');

    const html = await res.text();

    // Venue name
    expect(html).toContain('The Jazz Spot');
    expect(html).toContain('Live jazz in the heart of Fishtown.');

    // Address
    expect(html).toContain('123 Main St, Philadelphia, PA');

    // Website link
    expect(html).toContain('thejazzspot.com');

    // Event list
    expect(html).toContain('Jazz Night');
    expect(html).toContain('Blues Brunch');

    // Event count
    expect(html).toContain('2 upcoming events');

    // Structured data
    expect(html).toContain('application/ld+json');
    expect(html).toContain('"@type":"LocalBusiness"');

    // Subscribe section
    expect(html).toContain('events.ics');
    expect(html).toContain('Subscribe');

    // Embed snippet
    expect(html).toContain('widget/events.js');
    expect(html).toContain('data-venue');
  });

  it('returns 404 for non-existent venue', async () => {
    mockResponses.set('portal_accounts', { data: null, error: null });

    const res = await fetch(`${baseUrl}/venues/nonexistent-venue`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('404');
  });

  it('shows empty state when venue has no events', async () => {
    mockResponses.set('portal_accounts', { data: makeAccountRow(), error: null });
    mockResponses.set('events', { data: [], error: null });

    const res = await fetch(`${baseUrl}/venues/the-jazz-spot`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('No upcoming events');
    expect(html).toContain('0 upcoming events');
  });
});

// =============================================================================
// PER-VENUE ICAL FEED
// =============================================================================

describe('GET /venues/:slug/events.ics', () => {
  it('returns valid iCal feed for venue', async () => {
    const account = makeAccountRow();
    const events = [
      {
        id: 'evt-1', content: 'Jazz Night', description: 'Live jazz',
        place_name: 'The Jazz Spot', venue_address: '123 Main St',
        event_at: '2026-03-20T23:00:00.000Z', end_time: '2026-03-21T02:00:00.000Z',
        event_timezone: 'America/New_York', latitude: 39.97, longitude: -75.13,
        link_url: 'https://example.com', recurrence: 'none',
      },
    ];
    mockResponses.set('portal_accounts', { data: account, error: null });
    mockResponses.set('events', { data: events, error: null });

    const res = await fetch(`${baseUrl}/venues/the-jazz-spot/events.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    expect(res.headers.get('cache-control')).toContain('max-age=900');

    const ics = await res.text();

    // Valid iCal structure
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');

    // Event content
    expect(ics).toContain('SUMMARY:Jazz Night');
    expect(ics).toContain('DESCRIPTION:Live jazz');
    expect(ics).toContain('LOCATION:The Jazz Spot\\, 123 Main St');

    // Venue name in calendar title
    expect(ics).toContain('X-WR-CALNAME:The Jazz Spot');
  });

  it('returns 404 for non-existent venue', async () => {
    mockResponses.set('portal_accounts', { data: null, error: null });

    const res = await fetch(`${baseUrl}/venues/nonexistent/events.ics`);
    expect(res.status).toBe(404);
  });

  it('returns empty calendar when venue has no events', async () => {
    mockResponses.set('portal_accounts', { data: makeAccountRow(), error: null });
    mockResponses.set('events', { data: [], error: null });

    const res = await fetch(`${baseUrl}/venues/the-jazz-spot/events.ics`);
    expect(res.status).toBe(200);
    const ics = await res.text();
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});

// =============================================================================
// STATIC ASSETS
// =============================================================================

describe('static assets', () => {
  it('serves pages.css', async () => {
    const res = await fetch(`${baseUrl}/pages.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    const css = await res.text();
    expect(css).toContain('nc-page');
    expect(css).toContain('nc-event-title');
  });

  it('serves widget JS', async () => {
    const res = await fetch(`${baseUrl}/widget/events.js`);
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain('nc-events');
    expect(js).toContain('Shadow');
  });

  it('serves badge SVG', async () => {
    const res = await fetch(`${baseUrl}/widget/badge.svg`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain('<svg');
    expect(svg).toContain('Neighborhood Commons');
  });

  it('widget JS has valid CORS headers', async () => {
    const res = await fetch(`${baseUrl}/widget/events.js`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// =============================================================================
// XSS PROTECTION
// =============================================================================

describe('XSS protection', () => {
  it('escapes HTML in event content', async () => {
    const row = makeEventRow({
      content: '<script>alert("xss")</script>',
      description: '<img onerror="alert(1)" src="">',
      place_name: '<b>Evil</b>',
    });
    mockResponses.set('events', { data: row, error: null });
    mockResponses.set('portal_accounts', { data: null, error: null });

    const res = await fetch(`${baseUrl}/events/${row.id}`);
    const html = await res.text();

    // The h1 title must have escaped script tags (visible text, not executable)
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');

    // Description must have escaped img tag (not executable)
    expect(html).toContain('&lt;img onerror=&quot;alert(1)&quot; src=&quot;&quot;&gt;');

    // Venue name must have escaped bold tag
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt;');

    // Verify no unescaped user content appears as executable HTML.
    // The h1 and description elements should contain HTML entities, not raw tags.
    // (Google Calendar URLs and JSON-LD contain URL-encoded versions, which is safe.)
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    expect(h1Match?.[1]).toContain('&lt;script&gt;');
    expect(h1Match?.[1]).not.toContain('<script>');

    const descMatch = html.match(/nc-event-description">([\s\S]*?)<\/div>/);
    expect(descMatch?.[1]).toContain('&lt;img');
    expect(descMatch?.[1]).not.toContain('<img');
  });
});
