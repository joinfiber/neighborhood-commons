/**
 * Contribute API, Webhook, and Developer Route Tests — Neighborhood Commons
 *
 * Integration tests for the write API (contribute), webhook subscription
 * management, and developer self-service registration routes.
 *
 * These routes are the primary external-facing attack surface beyond the
 * read-only public API. Tests cover: auth enforcement, input validation,
 * rate limit tier logic, batch handling, ownership enforcement, and
 * response shapes.
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

/** Mock RPC responses keyed by function name */
const mockRpcResponses = vi.hoisted(() => {
  return new Map<string, { data: unknown; error: unknown }>();
});

/** Mock auth OTP responses */
const mockOtpResponse = vi.hoisted(() => {
  return { signIn: { error: null as unknown }, verify: { error: null as unknown } };
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
      const response = mockResponses.get(table) || { data: [], error: null, count: 0 };
      return Promise.resolve(response).then(resolve, reject);
    };

    return chain;
  }

  return {
    supabaseAdmin: {
      from: (table: string) => createQueryChain(table),
      rpc: (fnName: string) => {
        const chain: Record<string, unknown> = {};
        chain.single = () => chain;
        chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
          const response = mockRpcResponses.get(fnName) || { data: null, error: null };
          return Promise.resolve(response).then(resolve, reject);
        };
        return chain;
      },
      auth: {
        getUser: () => Promise.resolve(mockAuthUser.value),
        signInWithOtp: () => Promise.resolve(mockOtpResponse.signIn),
        verifyOtp: () => Promise.resolve(mockOtpResponse.verify),
      },
    },
    createUserClient: () => ({
      from: (table: string) => createQueryChain(table),
    }),
  };
});

// Mock webhook delivery (fire-and-forget, don't need real delivery)
vi.mock('../src/lib/webhook-delivery.js', () => ({
  dispatchWebhooks: vi.fn(),
  dispatchSeriesCreatedWebhook: vi.fn(),
  deliverTestWebhook: vi.fn(),
}));

// Mock URL validation (skip DNS resolution in tests)
vi.mock('../src/lib/url-validation.js', () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
  validateFeedUrl: vi.fn().mockResolvedValue(undefined),
}));

// Mock webhook crypto
vi.mock('../src/lib/webhook-crypto.js', () => ({
  encryptSecret: vi.fn((s: string) => `encrypted:${s}`),
  decryptSecret: vi.fn((s: string) => s.replace('encrypted:', '')),
  isEncryptionConfigured: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Import the app AFTER mocks are in place
// ---------------------------------------------------------------------------

import { createApp } from '../src/app.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function futureIso(daysAhead = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString();
}

const VALID_EVENT = {
  name: 'Open Mic Night',
  start: futureIso(1),
  timezone: 'America/New_York',
  category: 'live_music',
  location: {
    name: 'The Coffee Shop',
    address: '123 Main St, Philadelphia, PA',
    lat: 39.9743,
    lng: -75.134,
  },
  description: 'Weekly open mic. All genres welcome.',
  cost: 'Free',
};

const VALID_API_KEY = 'nc_test_key_abcdef1234567890';

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
  mockOtpResponse.signIn = { error: null };
  mockOtpResponse.verify = { error: null };
});

/** Set up mock so requireApiKey middleware succeeds */
function mockValidApiKey() {
  mockResponses.set('api_keys', {
    data: { id: 'key-uuid-1' },
    error: null,
  });
}

// =============================================================================
// CONTRIBUTE API — AUTH ENFORCEMENT
// =============================================================================

describe('Contribute API — auth enforcement', () => {
  it('rejects requests without X-API-Key header', async () => {
    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_EVENT),
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error.code).toBe('API_KEY_REQUIRED');
  });

  it('rejects requests with invalid API key', async () => {
    mockResponses.set('api_keys', { data: null, error: null });

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'invalid-key',
      },
      body: JSON.stringify(VALID_EVENT),
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error.code).toBe('INVALID_API_KEY');
  });
});

// =============================================================================
// CONTRIBUTE API — INPUT VALIDATION
// =============================================================================

describe('Contribute API — input validation', () => {
  it('rejects missing required fields', async () => {
    mockValidApiKey();

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({ name: 'Incomplete event' }),
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid category', async () => {
    mockValidApiKey();

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({
        ...VALID_EVENT,
        category: 'not_a_valid_category',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid timezone', async () => {
    mockValidApiKey();

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({
        ...VALID_EVENT,
        timezone: 'Not/A/Timezone',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects name exceeding max length', async () => {
    mockValidApiKey();

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({
        ...VALID_EVENT,
        name: 'A'.repeat(201),
      }),
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// CONTRIBUTE API — SINGLE EVENT CREATION
// =============================================================================

describe('Contribute API — single event', () => {
  it('creates an event and returns 201 with id and status', async () => {
    mockValidApiKey();

    // getKeyInfo lookup
    // Note: both api_keys calls (requireApiKey + getKeyInfo) use the same mock
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'verified', name: 'Test App' },
      error: null,
    });

    // Rate limit check + insert both hit 'events'
    mockResponses.set('events', {
      data: { id: 'new-event-uuid', status: 'published' },
      error: null,
      count: 0,
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify(VALID_EVENT),
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.event).toBeDefined();
    expect(body.event.id).toBe('new-event-uuid');
    expect(body.event.status).toBe('published');
    expect(body.event.source.publisher).toBe('Test App');
    expect(body.event.source.method).toBe('api');
  });

  it('returns 409 for duplicate external_id', async () => {
    mockValidApiKey();
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'verified', name: 'Test App' },
      error: null,
    });
    mockResponses.set('events', {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      count: 0,
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({ ...VALID_EVENT, external_id: 'dup-123' }),
    });
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error.code).toBe('DUPLICATE');
  });
});

// =============================================================================
// CONTRIBUTE API — BATCH
// =============================================================================

describe('Contribute API — batch', () => {
  it('rejects empty batch', async () => {
    mockValidApiKey();

    const res = await fetch(`${baseUrl}/api/v1/contribute/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects batch exceeding 50 events', async () => {
    mockValidApiKey();

    const events = Array.from({ length: 51 }, (_, i) => ({
      ...VALID_EVENT,
      name: `Event ${i}`,
    }));

    const res = await fetch(`${baseUrl}/api/v1/contribute/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({ events }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 201 with summary for successful batch', async () => {
    mockValidApiKey();
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'trusted', name: 'Batch App' },
      error: null,
    });
    mockResponses.set('events', {
      data: { id: 'batch-event-uuid', status: 'published' },
      error: null,
      count: 0,
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({
        events: [
          { ...VALID_EVENT, name: 'Event 1' },
          { ...VALID_EVENT, name: 'Event 2' },
        ],
      }),
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.summary).toBeDefined();
    expect(body.summary.total).toBe(2);
    expect(body.summary.created).toBe(2);
    expect(body.summary.failed).toBe(0);
    expect(body.summary.publisher).toBe('Batch App');
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBe(2);
  });
});

// =============================================================================
// CONTRIBUTE API — DELETE
// =============================================================================

describe('Contribute API — delete', () => {
  it('rejects delete without API key', async () => {
    const res = await fetch(`${baseUrl}/api/v1/contribute/a1b2c3d4-e5f6-7890-abcd-ef1234567890`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });

  it('validates UUID param on delete', async () => {
    mockValidApiKey();

    const res = await fetch(`${baseUrl}/api/v1/contribute/not-a-uuid`, {
      method: 'DELETE',
      headers: { 'X-API-Key': VALID_API_KEY },
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for event not owned by this API key', async () => {
    mockValidApiKey();
    mockResponses.set('events', { data: null, error: null });

    const res = await fetch(`${baseUrl}/api/v1/contribute/a1b2c3d4-e5f6-7890-abcd-ef1234567890`, {
      method: 'DELETE',
      headers: { 'X-API-Key': VALID_API_KEY },
    });
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// CONTRIBUTE API — LIST OWN EVENTS
// =============================================================================

describe('Contribute API — list own events', () => {
  it('returns events submitted by this API key', async () => {
    mockValidApiKey();
    mockResponses.set('events', {
      data: [
        { id: 'evt-1', content: 'Event 1', event_at: futureIso(), end_time: null, event_timezone: 'America/New_York', place_name: 'Venue', category: 'live_music', status: 'published', external_id: null, created_at: new Date().toISOString() },
      ],
      error: null,
      count: 1,
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute/mine`, {
      headers: { 'X-API-Key': VALID_API_KEY },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.meta.total).toBe(1);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events[0].name).toBe('Event 1');
  });

  it('rejects list without API key', async () => {
    const res = await fetch(`${baseUrl}/api/v1/contribute/mine`);
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// WEBHOOKS — AUTH ENFORCEMENT
// =============================================================================

describe('Webhooks — auth enforcement', () => {
  it('rejects webhook creation without API key', async () => {
    const res = await fetch(`${baseUrl}/api/v1/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/webhook' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('API_KEY_REQUIRED');
  });

  it('rejects webhook list without API key', async () => {
    const res = await fetch(`${baseUrl}/api/v1/webhooks`);
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// WEBHOOKS — INPUT VALIDATION
// =============================================================================

describe('Webhooks — input validation', () => {
  it('rejects non-HTTPS webhook URLs', async () => {
    mockValidApiKey();

    const res = await fetch(`${baseUrl}/api/v1/webhooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({ url: 'http://example.com/webhook' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid URL format', async () => {
    mockValidApiKey();

    const res = await fetch(`${baseUrl}/api/v1/webhooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({ url: 'not-a-url' }),
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// WEBHOOKS — SUBSCRIPTION MANAGEMENT
// =============================================================================

describe('Webhooks — subscription lifecycle', () => {
  it('creates a webhook and returns signing secret', async () => {
    mockValidApiKey();
    mockRpcResponses.set('create_webhook_subscription', {
      data: {
        id: 'wh-uuid-1',
        url: 'https://example.com/webhook',
        event_types: ['event.created', 'event.updated', 'event.deleted'],
        status: 'active',
        created_at: new Date().toISOString(),
      },
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/webhooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({ url: 'https://example.com/webhook' }),
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.subscription).toBeDefined();
    expect(body.subscription.id).toBe('wh-uuid-1');
    expect(body.subscription.signing_secret).toBeDefined();
    expect(typeof body.subscription.signing_secret).toBe('string');
    expect(body.subscription.signing_secret.length).toBe(64); // 32 bytes hex
    expect(body.note).toContain('signing_secret');
  });

  it('lists subscriptions for API key', async () => {
    mockValidApiKey();
    mockResponses.set('webhook_subscriptions', {
      data: [
        { id: 'wh-1', url: 'https://example.com/hook', event_types: ['event.created'], status: 'active', consecutive_failures: 0, last_success_at: null, last_failure_at: null, last_failure_reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      ],
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/webhooks`, {
      headers: { 'X-API-Key': VALID_API_KEY },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.subscriptions)).toBe(true);
    expect(body.subscriptions.length).toBe(1);
    expect(body.subscriptions[0].url).toBe('https://example.com/hook');
  });

  it('validates UUID on webhook update', async () => {
    mockValidApiKey();

    const res = await fetch(`${baseUrl}/api/v1/webhooks/not-a-uuid`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('validates UUID on webhook delete', async () => {
    mockValidApiKey();

    const res = await fetch(`${baseUrl}/api/v1/webhooks/not-a-uuid`, {
      method: 'DELETE',
      headers: { 'X-API-Key': VALID_API_KEY },
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-owned webhook on update', async () => {
    mockValidApiKey();
    mockResponses.set('webhook_subscriptions', { data: null, error: null });

    const res = await fetch(`${baseUrl}/api/v1/webhooks/a1b2c3d4-e5f6-7890-abcd-ef1234567890`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// WEBHOOKS — DELIVERY HISTORY
// =============================================================================

describe('Webhooks — delivery history', () => {
  it('rejects delivery query for non-owned webhook', async () => {
    mockValidApiKey();
    mockResponses.set('webhook_subscriptions', { data: null, error: null });

    const res = await fetch(`${baseUrl}/api/v1/webhooks/a1b2c3d4-e5f6-7890-abcd-ef1234567890/deliveries`, {
      headers: { 'X-API-Key': VALID_API_KEY },
    });
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// DEVELOPERS — REGISTRATION
// =============================================================================

describe('Developers — registration', () => {
  it('send-otp validates email format', async () => {
    const res = await fetch(`${baseUrl}/api/v1/developers/register/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('send-otp succeeds with valid email', async () => {
    mockOtpResponse.signIn = { error: null };

    const res = await fetch(`${baseUrl}/api/v1/developers/register/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dev@example.com' }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    // Response must not confirm email existence (anti-enumeration)
    expect(body.message).toContain('If eligible');
  });

  it('verify-otp rejects missing fields', async () => {
    const res = await fetch(`${baseUrl}/api/v1/developers/register/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dev@example.com' }),
    });
    expect(res.status).toBe(400);
  });

  it('verify-otp returns 409 if key already exists for email', async () => {
    mockResponses.set('api_keys', {
      data: { id: 'existing-key' },
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/developers/register/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'dev@example.com',
        token: '123456',
        name: 'My App',
      }),
    });
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error.code).toBe('ALREADY_EXISTS');
  });
});

// =============================================================================
// DEVELOPERS — AUTHENTICATED ROUTES
// =============================================================================

describe('Developers — authenticated routes', () => {
  it('GET /developers/me rejects without API key', async () => {
    const res = await fetch(`${baseUrl}/api/v1/developers/me`);
    expect(res.status).toBe(401);
  });

  it('GET /developers/me returns key info', async () => {
    mockValidApiKey();
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', name: 'My App', contact_email: 'dev@example.com', rate_limit_per_hour: 1000, created_at: new Date().toISOString() },
      error: null,
    });
    mockResponses.set('webhook_subscriptions', {
      data: null,
      error: null,
      count: 2,
    });

    const res = await fetch(`${baseUrl}/api/v1/developers/me`, {
      headers: { 'X-API-Key': VALID_API_KEY },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.api_key).toBeDefined();
    expect(body.api_key.name).toBe('My App');
    expect(body.api_key.rate_limit_per_hour).toBe(1000);
  });

  it('POST /developers/keys/rotate rejects without API key', async () => {
    const res = await fetch(`${baseUrl}/api/v1/developers/keys/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dev@example.com', token: '123456' }),
    });
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// PUBLIC API — UUID VALIDATION ON :id
// =============================================================================

describe('GET /api/v1/events/:id — UUID validation', () => {
  it('rejects non-UUID event ID', async () => {
    const res = await fetch(`${baseUrl}/api/v1/events/not-a-uuid`);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('event ID');
  });

  it('accepts valid UUID event ID', async () => {
    mockResponses.set('events', {
      data: null,
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/events/a1b2c3d4-e5f6-7890-abcd-ef1234567890`);
    // 404 because event doesn't exist, but NOT 400 — UUID was accepted
    expect(res.status).toBe(404);
  });
});
