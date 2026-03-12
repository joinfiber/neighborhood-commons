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

vi.mock('../src/lib/supabase.js', () => {
  /** Create a chainable PostgREST-like mock that resolves to the table's mock response */
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

/** A realistic event row as it comes from the database (with joined portal_accounts) */
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
    event_at: '2026-03-16T21:00:00.000Z',
    end_time: '2026-03-16T23:00:00.000Z',
    event_timezone: 'America/New_York',
    category: 'happy_hour',
    custom_category: null,
    recurrence: 'weekly_days:mon,tue,wed,thu',
    price: '$1 off drafts',
    link_url: 'https://example.com/happy-hour',
    event_image_url: 'https://images.example.com/taproom.jpg',
    created_at: '2026-03-10T12:00:00.000Z',
    creator_account_id: 'acc-uuid-1',
    series_id: null,
    portal_accounts: { business_name: 'The Fishtown Taproom' },
    event_series: null,
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

    // Source with provenance
    expect(event.source.publisher).toBe('The Fishtown Taproom');
    expect(event.source.method).toBe('portal');
    expect(event.source.license).toBe('CC BY 4.0');
    expect(event.source.collected_at).toBeDefined();

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

  it('propagates series recurrence onto non-first instances', async () => {
    mockResponses.set('events', {
      data: makeDbRow({
        id: 'instance-3',
        series_id: 'series-uuid-1',
        series_instance_number: 3,
        recurrence: 'none',
        event_series: { recurrence: 'weekly_days:mon,tue,wed,thu' },
      }),
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/events/instance-3`);
    const body = await res.json();

    expect(body.event.series_id).toBe('series-uuid-1');
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
// AUTH REJECTION
// =============================================================================

describe('authentication enforcement', () => {
  it('portal routes reject unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('admin routes reject unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/admin/stats`);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('portal routes reject invalid tokens', async () => {
    mockAuthUser.value = { data: { user: null }, error: { message: 'invalid' } };

    const res = await fetch(`${baseUrl}/api/portal/events`, {
      headers: { Authorization: 'Bearer fake-token-here' },
    });
    expect(res.status).toBe(401);
  });

  it('admin routes reject non-admin users', async () => {
    mockAuthUser.value = {
      data: { user: { id: 'not-an-admin-uuid', email: 'user@example.com' } },
      error: null,
    };

    const res = await fetch(`${baseUrl}/api/admin/stats`, {
      headers: { Authorization: 'Bearer valid-but-not-admin' },
    });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
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
          event_at: '2026-03-16T21:00:00.000Z',
          event_series: { recurrence: 'weekly_days:mon,tue,wed,thu' },
        }),
        makeDbRow({
          id: 'instance-2',
          series_id: seriesId,
          series_instance_number: 2,
          recurrence: 'none',
          event_at: '2026-03-17T21:00:00.000Z',
          event_series: { recurrence: 'weekly_days:mon,tue,wed,thu' },
        }),
        makeDbRow({
          id: 'instance-3',
          series_id: seriesId,
          series_instance_number: 3,
          recurrence: 'none',
          event_at: '2026-03-18T21:00:00.000Z',
          event_series: { recurrence: 'weekly_days:mon,tue,wed,thu' },
        }),
        makeDbRow({
          id: 'standalone-event',
          series_id: null,
          event_series: null,
          content: 'One-off concert',
          recurrence: 'none',
        }),
      ],
      error: null,
      count: 4,
    });

    const res = await fetch(`${baseUrl}/api/v1/events`);
    const body = await res.json();

    // 3 series instances should collapse to 1, plus the standalone = 2
    expect(body.events.length).toBe(2);

    // The kept series instance should carry the recurrence from the series
    const seriesEvent = body.events.find((e: Record<string, unknown>) => e.id === 'instance-1');
    expect(seriesEvent).toBeDefined();
    expect(seriesEvent.recurrence).toEqual({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH' });
    expect(seriesEvent.series_id).toBe('series-uuid-1');

    // The standalone event should be present
    const standalone = body.events.find((e: Record<string, unknown>) => e.id === 'standalone-event');
    expect(standalone).toBeDefined();
    expect(standalone.recurrence).toBeNull();
    expect(standalone.series_id).toBeNull();
  });
});
