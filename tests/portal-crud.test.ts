/**
 * Portal Event CRUD Integration Tests
 *
 * Tests the portal endpoints through the full Express middleware stack
 * with mocked Supabase. Verifies auth enforcement, input validation,
 * response shapes, and error handling for the portal — the primary
 * development surface where business owners manage events.
 *
 * If these fail, business users cannot reliably create/edit/delete events.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

// ---------------------------------------------------------------------------
// Mock Supabase — must be hoisted before any app imports
// ---------------------------------------------------------------------------

const mockResponses = vi.hoisted(() => {
  return new Map<string, { data: unknown; error: unknown; count?: number }>();
});

const mockAuthUser = vi.hoisted(() => {
  return { value: { data: { user: null }, error: { message: 'invalid token' } } as unknown };
});

// Track insert/update calls for assertions
const mockMutations = vi.hoisted(() => {
  return { inserts: [] as Array<{ table: string; data: unknown }>, updates: [] as Array<{ table: string; data: unknown }> };
});

vi.mock('../src/lib/supabase.js', () => {
  function createQueryChain(table: string) {
    const chain: Record<string, unknown> = {};
    const chainMethods = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in',
      'maybeSingle', 'single',
    ];

    for (const method of chainMethods) {
      chain[method] = () => chain;
    }

    chain.insert = (data: unknown) => {
      mockMutations.inserts.push({ table, data });
      return chain;
    };

    chain.update = (data: unknown) => {
      mockMutations.updates.push({ table, data });
      return chain;
    };

    chain.delete = () => chain;
    chain.upsert = () => chain;

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
        signInWithOtp: () => Promise.resolve({ error: null }),
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
    },
    createUserClient: () => ({
      from: (table: string) => createQueryChain(table),
    }),
  };
});

// Mock webhook dispatch (fire-and-forget, shouldn't affect CRUD tests)
vi.mock('../src/lib/webhook-delivery.js', () => ({
  dispatchWebhooks: vi.fn(),
  dispatchSeriesCreatedWebhook: vi.fn(),
}));

// Mock audit logging
vi.mock('../src/lib/audit.js', () => ({
  auditPortalAction: vi.fn(),
}));

// Mock Cloudflare R2
vi.mock('../src/lib/cloudflare.js', () => ({
  uploadToR2: vi.fn().mockResolvedValue({ success: true }),
  getFromR2: vi.fn().mockResolvedValue({ data: null, contentType: null }),
}));

// ---------------------------------------------------------------------------
// Import the app AFTER mocks are in place
// ---------------------------------------------------------------------------

import { createApp } from '../src/app.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PORTAL_USER_ID = 'user-uuid-portal-1';
const PORTAL_ACCOUNT_ID = 'account-uuid-1';
const ADMIN_USER_ID = process.env.COMMONS_ADMIN_USER_IDS?.split(',')[0] || 'not-admin';

function authenticatePortalUser() {
  mockAuthUser.value = {
    data: { user: { id: PORTAL_USER_ID, email: 'biz@example.com' } },
    error: null,
  };
}

function makePortalAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: PORTAL_ACCOUNT_ID,
    auth_user_id: PORTAL_USER_ID,
    email: 'biz@example.com',
    business_name: 'Test Business',
    status: 'active',
    ...overrides,
  };
}

function makeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-uuid-1',
    content: 'Friday Night Jazz',
    description: 'Live jazz every Friday',
    place_name: 'The Blue Note',
    venue_address: '123 Main St',
    place_id: 'ChIJ_test',
    latitude: 39.97,
    longitude: -75.14,
    event_at: '2026-03-20T22:00:00.000Z',
    end_time: '2026-03-21T01:00:00.000Z',
    event_timezone: 'America/New_York',
    category: 'live_music',
    custom_category: null,
    price: '$10',
    link_url: 'https://example.com',
    event_image_url: null,
    event_image_focal_y: null,
    recurrence: 'none',
    series_id: null,
    series_instance_number: null,
    source: 'portal',
    status: 'published',
    creator_account_id: PORTAL_ACCOUNT_ID,
    created_at: '2026-03-10T00:00:00Z',
    updated_at: '2026-03-10T00:00:00Z',
    ...overrides,
  };
}

const validEventPayload = {
  title: 'Friday Night Jazz',
  venue_name: 'The Blue Note',
  address: '123 Main St',
  place_id: 'ChIJ_test',
  latitude: 39.97,
  longitude: -75.14,
  event_date: '2026-03-20',
  start_time: '18:00',
  category: 'live_music',
};

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
  mockMutations.inserts.length = 0;
  mockMutations.updates.length = 0;
  mockAuthUser.value = { data: { user: null }, error: { message: 'invalid token' } };
});

// =============================================================================
// AUTH ENFORCEMENT
// =============================================================================

describe('portal auth enforcement', () => {
  it('rejects unauthenticated GET /api/portal/events', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects unauthenticated POST /api/portal/events', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validEventPayload),
    });
    expect(res.status).toBe(401);
  });

  it('rejects unauthenticated PATCH /api/portal/events/:id', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events/a1b2c3d4-e5f6-7890-abcd-ef1234567890`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects unauthenticated DELETE /api/portal/events/:id', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events/a1b2c3d4-e5f6-7890-abcd-ef1234567890`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// INPUT VALIDATION
// =============================================================================

describe('portal input validation', () => {
  beforeEach(() => {
    authenticatePortalUser();
    mockResponses.set('portal_accounts', { data: makePortalAccount(), error: null });
    mockResponses.set('events', { data: [], error: null, count: 0 });
  });

  it('rejects event creation with missing required fields', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ title: 'No date or venue' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid event_date format', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ ...validEventPayload, event_date: 'March 20th' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid start_time format', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ ...validEventPayload, start_time: '6pm' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid category', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ ...validEventPayload, category: 'nonexistent_category' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects title exceeding max length', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ ...validEventPayload, title: 'x'.repeat(201) }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid recurrence pattern', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ ...validEventPayload, recurrence: 'every_other_tuesday' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid UUID in event path', async () => {
    authenticatePortalUser();
    const res = await fetch(`${baseUrl}/api/portal/events/not-a-uuid`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ title: 'Updated' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects latitude out of range', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ ...validEventPayload, latitude: 91 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects longitude out of range', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ ...validEventPayload, longitude: -181 }),
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// EVENT LIST
// =============================================================================

describe('GET /api/portal/events', () => {
  it('returns events for authenticated user', async () => {
    authenticatePortalUser();
    mockResponses.set('portal_accounts', { data: makePortalAccount(), error: null });
    mockResponses.set('events', { data: [makeEventRow()], error: null });

    const res = await fetch(`${baseUrl}/api/portal/events`, {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toBeDefined();
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('returns empty array when user has no events', async () => {
    authenticatePortalUser();
    mockResponses.set('portal_accounts', { data: makePortalAccount(), error: null });
    mockResponses.set('events', { data: [], error: null });

    const res = await fetch(`${baseUrl}/api/portal/events`, {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
  });
});

// =============================================================================
// EVENT CREATION
// =============================================================================

describe('POST /api/portal/events', () => {
  beforeEach(() => {
    authenticatePortalUser();
    mockResponses.set('portal_accounts', { data: makePortalAccount(), error: null });
    // Rate limit check returns low count
    mockResponses.set('events', {
      data: makeEventRow(),
      error: null,
      count: 0,
    });
  });

  it('creates an event with valid payload', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify(validEventPayload),
    });
    // Accept either 200 or 201 — both indicate success
    expect(res.status).toBeLessThan(300);
  });

  it('validates required fields before creation', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// =============================================================================
// EVENT UPDATE
// =============================================================================

describe('PATCH /api/portal/events/:id', () => {
  const eventId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  beforeEach(() => {
    authenticatePortalUser();
    mockResponses.set('portal_accounts', { data: makePortalAccount(), error: null });
    mockResponses.set('events', { data: makeEventRow({ id: eventId }), error: null });
  });

  it('accepts a valid partial update', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events/${eventId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ title: 'Updated Jazz Night' }),
    });
    expect(res.status).toBeLessThan(300);
  });

  it('rejects update with invalid UUID', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events/not-valid`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ title: 'Updated' }),
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// EVENT DELETION
// =============================================================================

describe('DELETE /api/portal/events/:id', () => {
  const eventId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  beforeEach(() => {
    authenticatePortalUser();
    mockResponses.set('portal_accounts', { data: makePortalAccount(), error: null });
    mockResponses.set('events', { data: makeEventRow({ id: eventId }), error: null });
  });

  it('deletes an owned event', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events/${eventId}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token' },
    });
    // Accept 200 or 204
    expect(res.status).toBeLessThan(300);
  });

  it('rejects deletion with invalid UUID', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events/not-a-uuid`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// REGISTRATION — email masking in error responses
// =============================================================================

describe('POST /api/portal/auth/register', () => {
  it('rejects registration with missing fields', async () => {
    const res = await fetch(`${baseUrl}/api/portal/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects registration with invalid email', async () => {
    const res = await fetch(`${baseUrl}/api/portal/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', business_name: 'Test' }),
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// IMAGE UPLOAD VALIDATION (via integration)
// =============================================================================

describe('POST /api/portal/events/:id/image', () => {
  const eventId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  it('rejects image upload without auth', async () => {
    const res = await fetch(`${baseUrl}/api/portal/events/${eventId}/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'dGVzdA==' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects image upload with empty body', async () => {
    authenticatePortalUser();
    mockResponses.set('portal_accounts', { data: makePortalAccount(), error: null });

    const res = await fetch(`${baseUrl}/api/portal/events/${eventId}/image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects image upload with invalid UUID', async () => {
    authenticatePortalUser();
    mockResponses.set('portal_accounts', { data: makePortalAccount(), error: null });

    const res = await fetch(`${baseUrl}/api/portal/events/not-a-uuid/image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ image: 'dGVzdA==' }),
    });
    expect(res.status).toBe(400);
  });
});
