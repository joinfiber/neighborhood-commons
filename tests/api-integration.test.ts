/**
 * API Integration Tests — Neighborhood Commons
 *
 * These tests spin up the real Express app and make HTTP requests through
 * the full middleware stack. Supabase is mocked so we test everything
 * between the network and the database: auth, validation, rate limiting,
 * error handling, response shapes, CORS, and spec compliance.
 *
 * If these fail, real consumers of the API are getting broken responses.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

// ---------------------------------------------------------------------------
// Mock Supabase — must be hoisted before any app imports
// ---------------------------------------------------------------------------

/** Per-table mock responses. Tests set these to control what the "database" returns. */
const mockResponses = vi.hoisted(() => {
  return new Map<string, { data: unknown; error: unknown; count?: number }>();
});

/** Mock auth.getUser responses */
const mockAuthUser = vi.hoisted(() => {
  return { value: { data: { user: null }, error: { message: 'invalid token' } } as unknown };
});

/** Mock RPC responses keyed by function name */
const mockRpcResponses = vi.hoisted(() => {
  return new Map<string, { data: unknown; error: unknown }>();
});

vi.mock('../src/lib/supabase.js', () => {
  /** Create a chainable PostgREST-like mock that resolves to the table's mock response */
  function createQueryChain(table: string) {
    const chain: Record<string, unknown> = {};
    const chainMethods = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in', 'contains',
      'insert', 'update', 'delete', 'upsert', 'maybeSingle', 'single',
    ];

    for (const method of chainMethods) {
      chain[method] = () => chain;
    }

    // Thenable — resolves when awaited
    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      const response = mockResponses.get(table) || { data: [], error: null, count: 0 };
      return Promise.resolve(response).then(resolve, reject);
    };

    return chain;
  }

  return {
    supabaseAdmin: {
      from: (table: string) => createQueryChain(table),
      rpc: (fn: string) => {
        const chain: Record<string, unknown> = {};
        chain.single = () => chain;
        chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
          const response = mockRpcResponses.get(fn) || { data: null, error: null };
          return Promise.resolve(response).then(resolve, reject);
        };
        return chain;
      },
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
// Import the app AFTER mocks are in place
// ---------------------------------------------------------------------------

import { createApp } from '../src/app.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Future date helpers — tests must not go stale as calendar dates pass */
function futureDate(daysAhead = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().split('T')[0]!;
}
const FUTURE_START = `${futureDate(1)}T21:00:00.000Z`;
const FUTURE_END = `${futureDate(1)}T23:00:00.000Z`;

/** v2 event row shape with joined organizations (replacing the legacy portal_accounts join). */
function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    content: 'Happy Hour at The Fishtown Taproom',
    description: '$1 off all drafts, Monday through Thursday',
    place_name: 'The Fishtown Taproom',
    venue_address: '1509 Frankford Ave, Philadelphia, PA',
    place_id: 'ChIJ_fishtown_tap',
    latitude: 39.9743,
    longitude: -75.1340,
    event_at: FUTURE_START,
    end_time: FUTURE_END,
    event_timezone: 'America/New_York',
    category: 'happy_hour',
    custom_category: null,
    recurrence: 'weekly_days:mon,tue,wed,thu',
    price: '$1 off drafts',
    link_url: 'https://example.com/happy-hour',
    event_image_url: 'https://images.example.com/taproom.jpg',
    created_at: '2026-03-10T12:00:00.000Z',
    creator_account_id: 'acc-uuid-1',
    organizer_org_id: 'org-uuid-tap',
    series_id: null,
    first_party: false,
    source_method: 'self_asserted',
    source_feed_url: null,
    source_contributor_name: null,
    source_contributor_url: null,
    organizations: {
      id: 'org-uuid-tap',
      slug: 'the-fishtown-taproom',
      name: 'The Fishtown Taproom',
      portal_accounts: null,
    },
    contributor_profile_id: null,
    contributor_profiles: null,
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
  mockRpcResponses.clear();
  mockAuthUser.value = { data: { user: null }, error: { message: 'invalid token' } };
});

// =============================================================================
// HEALTH & DISCOVERY
// =============================================================================

describe('health and discovery', () => {
  it('GET /health returns 200 with service name', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('neighborhood-commons');
    expect(body.timestamp).toBeDefined();
  });

  it('GET /.well-known/neighborhood returns API discovery document', async () => {
    const res = await fetch(`${baseUrl}/.well-known/neighborhood`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Neighborhood Commons');
    expect(body.version).toBe('0.2');
    expect(body.license).toBe('CC-BY-4.0');
    expect(body.events_url).toMatch(/\/api\/v1\/events$/);
    expect(body.ical_url).toMatch(/\/api\/v1\/events\.ics$/);
    expect(body.rss_url).toMatch(/\/api\/v1\/events\.rss$/);
  });

  it('GET / injects the spec version from openapi.json (no hardcoded drift)', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Regression guard: the homepage version is substituted from
    // openapi.json info.version at boot. The literal placeholder must never
    // reach the client, and a real semver must render. This replaced a
    // hardcoded value that silently drifted (stuck at 3.0.0 through 3.1.x).
    expect(html).not.toContain('{{specVersion}}');
    expect(html).toMatch(/Specification \d+\.\d+\.\d+/);
  });
});

// =============================================================================
// PUBLIC API — EVENTS
// =============================================================================

describe('GET /api/v1/events', () => {
  it('returns 200 with spec-compliant meta and events array', async () => {
    mockResponses.set('events', {
      data: [makeDbRow()],
      error: null,
      count: 1,
    });

    const res = await fetch(`${baseUrl}/api/v1/events`);
    expect(res.status).toBe(200);

    const body = await res.json();

    // Meta block
    expect(body.meta).toBeDefined();
    expect(body.meta.spec).toBe('neighborhood-api-v0.2');
    expect(body.meta.license).toBe('CC-BY-4.0');
    expect(typeof body.meta.total).toBe('number');
    expect(typeof body.meta.limit).toBe('number');
    expect(typeof body.meta.offset).toBe('number');

    // Events array
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(1);
  });

  it('returns events in Neighborhood API v0.2 format', async () => {
    mockResponses.set('events', {
      data: [makeDbRow()],
      error: null,
      count: 1,
    });

    const res = await fetch(`${baseUrl}/api/v1/events`);
    const body = await res.json();
    const event = body.events[0];

    // Spec field mapping: content → name
    expect(event.name).toBe('Happy Hour at The Fishtown Taproom');
    expect(event).not.toHaveProperty('content');
    expect(event).not.toHaveProperty('title');

    // ISO 8601 with timezone offset
    expect(event.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

    // IANA timezone name
    expect(event.timezone).toBe('America/New_York');

    // Category as array (spec requires array)
    expect(Array.isArray(event.category)).toBe(true);

    // Location as nested object
    expect(event.location).toEqual({
      name: 'The Fishtown Taproom',
      address: '1509 Frankford Ave, Philadelphia, PA',
      lat: 39.9743,
      lng: -75.1340,
    });

    // Images as array
    expect(Array.isArray(event.images)).toBe(true);

    // Organizer
    expect(event.organizer.name).toBe('The Fishtown Taproom');

    // Source with provenance (four-role shape — no publisher field).
    // The "who is this from?" role is filled by organizer.name above.
    expect(event.source.method).toBe('self_asserted');
    expect(event.source.url).toBeNull();
    expect(event.source.contributor).toBeNull();
    expect(event.source.license).toBe('CC BY 4.0');
    expect(event.source.collected_at).toBeDefined();
    expect(event.source).not.toHaveProperty('publisher');

    // Recurrence as rrule object
    expect(event.recurrence).toEqual({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH' });

    // Series fields (null for non-series events)
    expect(event.series_id).toBeNull();
    expect(event.series_instance_number).toBeNull();

    // Cost mapping: price → cost
    expect(event.cost).toBe('$1 off drafts');
    expect(event).not.toHaveProperty('price');
  });

  it('returns empty events array when no events exist', async () => {
    mockResponses.set('events', { data: [], error: null, count: 0 });

    const res = await fetch(`${baseUrl}/api/v1/events`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.events).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  it('handles database errors gracefully', async () => {
    mockResponses.set('events', { data: null, error: { message: 'connection refused' }, count: 0 });

    const res = await fetch(`${baseUrl}/api/v1/events`);
    expect(res.status).toBe(500);

    const body = await res.json();
    // 500 errors must NOT expose internal details
    expect(body.error.message).toBe('An unexpected error occurred');
    expect(body.error.message).not.toContain('connection');
    expect(body.error.code).toBeDefined();
  });

  it('accepts the first_party=true filter and the response shape includes first_party on each event', async () => {
    // The two-tier authority model: first_party distinguishes information
    // posted BY the verified business (first-party) from information
    // aggregated ABOUT them (public-facts). Apps filter via the query param.
    mockResponses.set('events', {
      data: [makeDbRow({ first_party: true })],
      error: null,
      count: 1,
    });

    const res = await fetch(`${baseUrl}/api/v1/events?first_party=true`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.events).toHaveLength(1);
    // The flag round-trips on the response shape so consumers can decide
    // whether to surface visual differentiation.
    expect(body.events[0].first_party).toBe(true);
  });

  it('rejects malformed first_party values with 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/events?first_party=maybe`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('created_by_contributor resolves an active profile slug and lets the events query through', async () => {
    // Publishing-app axis (source.contributor). The slug resolves against an
    // active contributor_profile; on a hit, the events query proceeds.
    mockResponses.set('contributor_profiles', {
      data: { id: 'c0ffee00-0000-4000-8000-000000000001' },
      error: null,
    });
    mockResponses.set('events', { data: [makeDbRow()], error: null, count: 1 });

    const res = await fetch(`${baseUrl}/api/v1/events?created_by_contributor=merrie`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
  });

  it('created_by_contributor returns empty when the slug matches no active profile', async () => {
    // The falsifiable half: no active profile → the handler short-circuits to an
    // empty result and never queries events. If that short-circuit regressed,
    // the events row below would leak through and this would read length 1.
    mockResponses.set('contributor_profiles', { data: null, error: null });
    mockResponses.set('events', { data: [makeDbRow()], error: null, count: 1 });

    const res = await fetch(`${baseUrl}/api/v1/events?created_by_contributor=ghost`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(0);
  });
});

describe('GET /api/v1/events/:id', () => {
  it('returns a single event in spec format', async () => {
    mockResponses.set('events', {
      data: makeDbRow(),
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/events/a1b2c3d4-e5f6-7890-abcd-ef1234567890`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.event).toBeDefined();
    expect(body.event.id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(body.event.name).toBe('Happy Hour at The Fishtown Taproom');
    expect(body.event.source).toBeDefined();
  });

  it('returns 404 when event not found', async () => {
    mockResponses.set('events', { data: null, error: null });

    const res = await fetch(`${baseUrl}/api/v1/events/a1b2c3d4-e5f6-7890-abcd-ef1234567890`);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns series recurrence directly from instance', async () => {
    const instanceId = 'b2c3d4e5-f6a7-8901-bcde-f12345678903';
    mockResponses.set('events', {
      data: makeDbRow({
        id: instanceId,
        series_id: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
        series_instance_number: 3,
        recurrence: 'weekly_days:mon,tue,wed,thu',
      }),
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/events/${instanceId}`);
    const body = await res.json();

    expect(body.event.series_id).toBe('c3d4e5f6-a7b8-9012-cdef-123456789012');
    expect(body.event.series_instance_number).toBe(3);
    expect(body.event.recurrence).toEqual({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH' });
  });
});

describe('GET /api/v1/events/terms', () => {
  it('returns license and usage terms', async () => {
    const res = await fetch(`${baseUrl}/api/v1/events/terms`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.license.spdx).toBe('CC-BY-4.0');
    expect(body.guidelines).toBeDefined();
    expect(Array.isArray(body.guidelines)).toBe(true);
  });
});

// =============================================================================
// FEEDS — iCal and RSS
// =============================================================================

describe('event feeds', () => {
  it('GET /api/v1/events.ics returns valid iCalendar', async () => {
    mockResponses.set('events', {
      data: [makeDbRow()],
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/events.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');

    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('BEGIN:VEVENT');
    expect(body).toContain('SUMMARY:Happy Hour at The Fishtown Taproom');
    expect(body).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH');
    expect(body).toContain('END:VCALENDAR');
  });

  it('GET /api/v1/events.rss returns valid RSS', async () => {
    mockResponses.set('events', {
      data: [makeDbRow()],
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/events.rss`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/rss+xml');

    const body = await res.text();
    expect(body).toContain('<rss version="2.0"');
    expect(body).toContain('<title>Happy Hour at The Fishtown Taproom</title>');
    expect(body).toContain('Neighborhood Commons Events');
  });

  it('iCal feed accepts query filters and reflects them in calendar name', async () => {
    mockResponses.set('events', {
      data: [makeDbRow()],
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/events.ics?category=happy-hour`);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('X-WR-CALNAME:Neighborhood Commons: happy hour');
    expect(body).toContain('DTSTAMP:');
  });

  it('RSS feed accepts query filters and reflects them in feed title', async () => {
    mockResponses.set('events', {
      data: [makeDbRow()],
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/events.rss?category=happy-hour`);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('<title>Neighborhood Commons: happy hour</title>');
  });

  it('iCal feed sets stale-while-revalidate cache header', async () => {
    mockResponses.set('events', {
      data: [],
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/events.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('stale-while-revalidate');
  });

  it('RSS feed includes location in description', async () => {
    mockResponses.set('events', {
      data: [makeDbRow()],
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/events.rss`);
    const body = await res.text();
    expect(body).toContain('The Fishtown Taproom');
  });

  it('contributor filter returns empty feed for unknown slug', async () => {
    // portal_accounts lookup returns empty
    mockResponses.set('portal_accounts', {
      data: [],
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/events.rss?contributor=nonexistent`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // Feed should be valid but empty
    expect(body).toContain('<rss version="2.0"');
    expect(body).not.toContain('<item>');
  });
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

describe('error response shape', () => {
  it('all errors follow { error: { code, message } } shape', async () => {
    // 404 — nonexistent route
    const res = await fetch(`${baseUrl}/api/v1/nonexistent`);
    // This will either be 404 from Express or fall through to SPA — either way, not a bare crash
    // Test a known 404 case instead:
    mockResponses.set('events', { data: null, error: null });
    const res404 = await fetch(`${baseUrl}/api/v1/events/a1b2c3d4-e5f6-7890-abcd-ef1234567890`);
    const body = await res404.json();
    expect(body.error).toBeDefined();
    expect(typeof body.error.code).toBe('string');
    expect(typeof body.error.message).toBe('string');
  });

  it('500 errors never expose internal details', async () => {
    mockResponses.set('events', {
      data: null,
      error: { message: 'relation "events" does not exist at character 15' },
      count: 0,
    });

    const res = await fetch(`${baseUrl}/api/v1/events`);
    const body = await res.json();
    expect(body.error.message).toBe('An unexpected error occurred');
    expect(body.error.message).not.toContain('relation');
    expect(body.error.message).not.toContain('character');
  });
});

// =============================================================================
// CORS
// =============================================================================

describe('CORS headers', () => {
  it('public API allows any origin', async () => {
    mockResponses.set('events', { data: [], error: null, count: 0 });

    const res = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { Origin: 'https://some-random-app.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('.well-known allows any origin', async () => {
    const res = await fetch(`${baseUrl}/.well-known/neighborhood`, {
      headers: { Origin: 'https://some-random-app.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// =============================================================================
// SECURITY HEADERS
// =============================================================================

describe('security headers', () => {
  it('includes standard security headers on all responses', async () => {
    const res = await fetch(`${baseUrl}/health`);

    // Helmet sets these
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBeTruthy();
    expect(res.headers.get('strict-transport-security')).toBeTruthy();
  });
});

// =============================================================================
// SERIES DEDUPLICATION
// =============================================================================

describe('series deduplication', () => {
  it('collapses multiple instances of the same series to one event', async () => {
    const seriesId = 'series-uuid-1';
    mockResponses.set('events', {
      data: [
        makeDbRow({
          id: 'instance-1',
          series_id: seriesId,
          series_instance_number: 1,
          recurrence: 'weekly_days:mon,tue,wed,thu',
          event_at: `${futureDate(1)}T21:00:00.000Z`,
        }),
        makeDbRow({
          id: 'instance-2',
          series_id: seriesId,
          series_instance_number: 2,
          recurrence: 'weekly_days:mon,tue,wed,thu',
          event_at: `${futureDate(2)}T21:00:00.000Z`,
        }),
        makeDbRow({
          id: 'instance-3',
          series_id: seriesId,
          series_instance_number: 3,
          recurrence: 'weekly_days:mon,tue,wed,thu',
          event_at: `${futureDate(3)}T21:00:00.000Z`,
        }),
        makeDbRow({
          id: 'standalone-event',
          series_id: null,
          content: 'One-off concert',
          recurrence: 'none',
        }),
      ],
      error: null,
      count: 4,
    });
    mockRpcResponses.set('series_instance_counts', {
      data: [{ series_id: 'series-uuid-1', count: 3 }],
      error: null,
    });

    // Without collapse_series, all 4 events are returned
    const resAll = await fetch(`${baseUrl}/api/v1/events`);
    const bodyAll = await resAll.json();
    expect(bodyAll.events.length).toBe(4);

    // With collapse_series=true, 3 series instances collapse to 1, plus standalone = 2
    const res = await fetch(`${baseUrl}/api/v1/events?collapse_series=true`);
    const body = await res.json();
    expect(body.events.length).toBe(2);

    // Each instance carries its own recurrence — no join needed
    const seriesEvent = body.events.find((e: Record<string, unknown>) => e.id === 'instance-1');
    expect(seriesEvent).toBeDefined();
    // 3 instances in the mock → series_instance_count hydrates, rrule carries COUNT=3
    expect(seriesEvent.recurrence).toEqual({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH;COUNT=3' });
    expect(seriesEvent.series_instance_count).toBe(3);
    expect(seriesEvent.series_id).toBe('series-uuid-1');

    // The standalone event should be present
    const standalone = body.events.find((e: Record<string, unknown>) => e.id === 'standalone-event');
    expect(standalone).toBeDefined();
    expect(standalone.recurrence).toBeNull();
    expect(standalone.series_id).toBeNull();
  });
});

// =============================================================================
// PUBLISHERS — v2 read endpoint replaces /v1/accounts
// =============================================================================
//
// v2 retired /v1/accounts and replaced it with /v1/publishers — a focused
// slice of /v1/organizations that filters to orgs with at least one
// published event or active broadcast. The legacy "embed events on the
// account" pattern is gone; consumers fetch events via /v1/events?contributor=<slug>.

describe('Publishers API (v2)', () => {
  it('returns publisher (organization shape) for a known slug', async () => {
    mockResponses.set('organizations', {
      data: {
        id: 'org-uuid-1',
        slug: 'test-bar',
        name: 'Test Bar',
        legal_name: null,
        description: 'A neighborhood bar.',
        url: 'https://test-bar.test',
        logo_url: null,
        image_url: null,
        telephone: null,
        email: null,
        same_as: [],
        keywords: [],
        opening_hours_specification: null,
        tags: ['neighborhood-bar'],
        commercial: true,
        primary_place_id: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      error: null,
    });
    // The publisher set is built from events.organizer_org_id ∪ broadcasts.organization_id.
    // Mock at least one event for this org so it qualifies as a publisher.
    mockResponses.set('events', { data: [{ organizer_org_id: 'org-uuid-1' }], error: null });
    mockResponses.set('broadcasts', { data: [], error: null });
    mockResponses.set('organization_verifications', { data: [], error: null });

    const res = await fetch(`${baseUrl}/api/v1/publishers/test-bar`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.publisher).toBeDefined();
    expect(body.publisher.id).toBe('org-uuid-1');
    expect(body.publisher.slug).toBe('test-bar');
    expect(body.publisher.name).toBe('Test Bar');
    // v2 organization shape — no kind, has tags + commercial
    expect(body.publisher).not.toHaveProperty('kind');
    expect(body.publisher.tags).toEqual(['neighborhood-bar']);
    expect(body.publisher.commercial).toBe(true);
  });

  it('returns 404 for unknown publisher slug', async () => {
    mockResponses.set('organizations', { data: null, error: null });
    mockResponses.set('events', { data: [], error: null });
    mockResponses.set('broadcasts', { data: [], error: null });
    const res = await fetch(`${baseUrl}/api/v1/publishers/no-such-publisher`);
    expect(res.status).toBe(404);
  });

  it('lists publishers via the publisher_org_ids RPC (no full-table scan)', async () => {
    mockRpcResponses.set('publisher_org_ids', { data: [{ org_id: 'org-uuid-1' }], error: null });
    mockResponses.set('organizations', {
      data: [{
        id: 'org-uuid-1', slug: 'test-bar', name: 'Test Bar', legal_name: null,
        description: null, url: null, logo_url: null, image_url: null, telephone: null,
        email: null, same_as: [], keywords: [], opening_hours_specification: null,
        tags: [], commercial: null, method: 'seeded', primary_place_id: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      }],
      error: null, count: 1,
    });
    mockResponses.set('places', { data: [], error: null });
    mockResponses.set('organization_verifications', { data: [], error: null });

    const res = await fetch(`${baseUrl}/api/v1/publishers`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publishers).toHaveLength(1);
    expect(body.publishers[0].id).toBe('org-uuid-1');
  });
});

describe('created_by_contributor on organizations & publishers', () => {
  // Migration 090 brought organizations onto the same contributor axis as
  // events. Both /organizations and /publishers previously accepted the param
  // (shared orgListSchema) but silently ignored it; these pin the wired
  // behavior. The unknown-slug cases are the falsifiable half: the org row is
  // mocked, so if the resolve-and-short-circuit regressed it would leak through
  // as length 1.
  const orgRow = {
    id: 'org-uuid-1', slug: 'test-bar', name: 'Test Bar', legal_name: null,
    description: null, url: null, logo_url: null, image_url: null,
    telephone: null, email: null, same_as: [], keywords: [],
    opening_hours_specification: null, tags: [], commercial: null,
    primary_place_id: null, contributor_profile_id: 'cp-1',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };

  it('organizations: unknown contributor slug returns empty', async () => {
    mockResponses.set('contributor_profiles', { data: null, error: null });
    mockResponses.set('organizations', { data: [orgRow], error: null, count: 1 });

    const res = await fetch(`${baseUrl}/api/v1/organizations?created_by_contributor=ghost`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organizations).toHaveLength(0);
  });

  it('organizations: active contributor slug resolves and the query proceeds', async () => {
    mockResponses.set('contributor_profiles', { data: { id: 'cp-1' }, error: null });
    mockResponses.set('organizations', { data: [orgRow], error: null, count: 1 });
    mockResponses.set('organization_verifications', { data: [], error: null });

    const res = await fetch(`${baseUrl}/api/v1/organizations?created_by_contributor=merrie`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organizations).toHaveLength(1);
  });

  it('publishers: unknown contributor slug returns empty', async () => {
    mockResponses.set('contributor_profiles', { data: null, error: null });
    mockResponses.set('events', { data: [{ organizer_org_id: 'org-uuid-1' }], error: null });
    mockResponses.set('broadcasts', { data: [], error: null });
    mockResponses.set('organizations', { data: [orgRow], error: null, count: 1 });

    const res = await fetch(`${baseUrl}/api/v1/publishers?created_by_contributor=ghost`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publishers).toHaveLength(0);
  });
});

describe('GET /api/meta/categories', () => {
  it('returns category counts from the event_category_counts RPC', async () => {
    mockRpcResponses.set('event_category_counts', {
      data: [{ category: 'live_music', count: 3 }, { category: 'community', count: 1 }],
      error: null,
    });
    const res = await fetch(`${baseUrl}/api/meta/categories`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.categories).toHaveLength(2);
    // sorted by count desc; underscores become hyphens in the slug
    expect(body.categories[0]).toMatchObject({ key: 'live_music', slug: 'live-music', count: 3 });
  });
});

// =============================================================================
// SERIES — public endpoints
// =============================================================================

describe('GET /api/v1/series/:idOrSlug', () => {
  function makeSeriesRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ser-uuid-1',
      slug: 'fishtown-quizzo',
      name: 'Fishtown Quizzo',
      description: 'Weekly drop-in trivia at Frankford Hall.',
      cover_image_url: 'https://r2.example/quizzo-cover.jpg',
      organizer_org_id: 'org-uuid-quizzo',
      recurrence: 'weekly',
      recurrence_rule: { frequency: 'weekly', count: 26 },
      created_at: '2026-03-10T12:00:00.000Z',
      updated_at: '2026-03-10T12:00:00.000Z',
      organizations: {
        id: 'org-uuid-quizzo',
        slug: 'quizzo-philly',
        name: 'Quizzo Philly',
        legal_name: null,
        tags: ['trivia'],
        commercial: false,
        description: null,
        url: null,
        logo_url: null,
        image_url: null,
        telephone: null,
        email: null,
        same_as: null,
        keywords: null,
        opening_hours_specification: null,
        primary_place_id: null,
        method: 'self_asserted',
        created_at: '2026-03-10T12:00:00.000Z',
        updated_at: '2026-03-10T12:00:00.000Z',
      },
      ...overrides,
    };
  }

  it('returns the series with identity, organizer, recurrence', async () => {
    mockResponses.set('event_series', { data: makeSeriesRow(), error: null });
    mockResponses.set('events', { data: null, error: null });
    mockResponses.set('organization_verifications', { data: [], error: null });

    const res = await fetch(`${baseUrl}/api/v1/series/fishtown-quizzo`);
    expect(res.status).toBe(200);

    const body = await res.json() as { series: Record<string, unknown> };
    expect(body.series.id).toBe('ser-uuid-1');
    expect(body.series.slug).toBe('fishtown-quizzo');
    expect(body.series.name).toBe('Fishtown Quizzo');
    expect(body.series.description).toBe('Weekly drop-in trivia at Frankford Hall.');
    expect(body.series.cover_image_url).toBe('https://r2.example/quizzo-cover.jpg');
    expect((body.series.recurrence as { rrule: string })?.rrule).toContain('FREQ=WEEKLY');
    expect((body.series.organizer as Record<string, unknown>)?.id).toBe('org-uuid-quizzo');
    expect(body.series.next_instance).toBeNull();
  });

  it('returns 404 for unknown slug', async () => {
    mockResponses.set('event_series', { data: null, error: null });
    const res = await fetch(`${baseUrl}/api/v1/series/no-such-series`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('looks up by UUID when path looks like a UUID', async () => {
    mockResponses.set('event_series', { data: makeSeriesRow(), error: null });
    mockResponses.set('events', { data: null, error: null });
    mockResponses.set('organization_verifications', { data: [], error: null });

    const res = await fetch(`${baseUrl}/api/v1/series/a1b2c3d4-e5f6-7890-abcd-ef1234567890`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v1/series (list)', () => {
  it('returns a paginated list with meta', async () => {
    mockResponses.set('event_series', {
      data: [
        {
          id: 'ser-1', slug: 'fishtown-quizzo', name: 'Fishtown Quizzo',
          description: null, cover_image_url: null,
          organizer_org_id: 'org-uuid-quizzo',
          recurrence: 'weekly', recurrence_rule: { frequency: 'weekly' },
          created_at: '2026-03-10T12:00:00.000Z',
          updated_at: '2026-03-10T12:00:00.000Z',
          organizations: { id: 'org-uuid-quizzo', slug: 'quizzo-philly', name: 'Quizzo Philly', tags: [], commercial: false, method: 'self_asserted' },
        },
      ],
      error: null,
      count: 1,
    });
    mockResponses.set('events', { data: [], error: null });
    mockResponses.set('organization_verifications', { data: [], error: null });

    const res = await fetch(`${baseUrl}/api/v1/series`);
    expect(res.status).toBe(200);

    const body = await res.json() as { meta: { total: number }; series: unknown[] };
    expect(body.meta.total).toBe(1);
    expect(body.series).toHaveLength(1);
  });

  it('returns empty list with meta.total=0 when no series exist', async () => {
    mockResponses.set('event_series', { data: [], error: null, count: 0 });
    mockResponses.set('events', { data: [], error: null });
    mockResponses.set('organization_verifications', { data: [], error: null });

    const res = await fetch(`${baseUrl}/api/v1/series`);
    expect(res.status).toBe(200);

    const body = await res.json() as { meta: { total: number }; series: unknown[] };
    expect(body.meta.total).toBe(0);
    expect(body.series).toEqual([]);
  });
});
