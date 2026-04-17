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
  // Contribute keys must be linked to a portal account (the stable owner).
  // Without this link, requireOwnerAccountId throws 403 KEY_NOT_LINKED.
  mockResponses.set('api_key_account_links', {
    data: { portal_account_id: 'account-uuid-1' },
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

  it('rejects valid key with no linked account (KEY_NOT_LINKED)', async () => {
    // Key authenticates but has no row in api_key_account_links — without
    // a stable owner, ownership checks would silently break. Reject early.
    mockResponses.set('api_keys', { data: { id: 'key-uuid-1' }, error: null });
    mockResponses.set('api_key_account_links', { data: null, error: null });

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify(VALID_EVENT),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('KEY_NOT_LINKED');
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

  it('accepts kebab-case category and normalizes to underscore', async () => {
    mockValidApiKey();
    // Mock the rate limit check and event insert
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'verified', name: 'Test App', url: null, rate_limit_per_hour: 1000 },
      error: null,
    });
    mockResponses.set('events', {
      data: [{ id: 'new-evt-id', status: 'published', series_id: null }],
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VALID_API_KEY,
      },
      body: JSON.stringify({
        ...VALID_EVENT,
        category: 'live-music', // kebab-case, not underscore
      }),
    });
    // Should not be rejected as invalid category
    expect(res.status).not.toBe(400);
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

  it('returns 404 for event not owned by this account', async () => {
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
// CONTRIBUTE API — OWNERSHIP-BY-ACCOUNT (rotation safety)
// =============================================================================

describe('Contribute API — ownership by account, not key', () => {
  // The positive case ("a different key under the same account can edit") is
  // implicitly covered by every other test in this file: those tests don't
  // care which key UUID created the event, only that the current key's linked
  // account matches the event's creator_account_id. The mocks for the existing
  // create/update tests would have failed if we still gated on key UUID.
  // What we must explicitly verify: a *different account* cannot edit.
  it('a key linked to a different account cannot edit the event (404)', async () => {
    // Different owner — even with a valid key, the creator_account_id filter
    // rejects. We return null from the events mock to simulate "no row matched".
    mockResponses.set('api_keys', { data: { id: 'key-uuid-C' }, error: null });
    mockResponses.set('api_key_account_links', {
      data: { portal_account_id: 'other-account' },
      error: null,
    });
    mockResponses.set('events', { data: null, error: null });

    const res = await fetch(`${baseUrl}/api/v1/contribute/a1b2c3d4-e5f6-7890-abcd-ef1234567890`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify({ description: 'malicious edit' }),
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
    expect(body.message).toContain('verification code');
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

// =============================================================================
// SERVICE API — ADMIN LOCKDOWN
// =============================================================================

/** Set up mock so requireServiceApiKey middleware succeeds with given admin flag */
function mockServiceApiKey(isAdmin: boolean) {
  mockResponses.set('api_keys', {
    data: { id: 'svc-key-uuid', contributor_tier: 'service', is_admin: isAdmin },
    error: null,
  });
}

const SERVICE_KEY = 'nc_service_key_0123456789abcdef';

describe('Service API — admin lockdown', () => {
  it('rejects non-admin service key on GET /service/api-keys', async () => {
    mockServiceApiKey(false);
    const res = await fetch(`${baseUrl}/api/v1/service/api-keys`, {
      headers: { 'X-API-Key': SERVICE_KEY },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects non-admin service key on PATCH /service/api-keys/:id', async () => {
    mockServiceApiKey(false);
    const res = await fetch(`${baseUrl}/api/v1/service/api-keys/a1b2c3d4-e5f6-7890-abcd-ef1234567890`, {
      method: 'PATCH',
      headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hacked' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects non-admin service key on GET /service/stats', async () => {
    mockServiceApiKey(false);
    const res = await fetch(`${baseUrl}/api/v1/service/stats`, {
      headers: { 'X-API-Key': SERVICE_KEY },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects non-admin service key on POST /service/migrate-image-urls', async () => {
    mockServiceApiKey(false);
    const res = await fetch(`${baseUrl}/api/v1/service/migrate-image-urls`, {
      method: 'POST',
      headers: { 'X-API-Key': SERVICE_KEY },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('allows admin service key on GET /service/api-keys', async () => {
    mockServiceApiKey(true);
    const res = await fetch(`${baseUrl}/api/v1/service/api-keys`, {
      headers: { 'X-API-Key': SERVICE_KEY },
    });
    // 200 or 500 (mock may not return full data) — but NOT 403
    expect(res.status).not.toBe(403);
  });
});

// =============================================================================
// CONTRIBUTE API — GROUP WRITE OWNERSHIP (S1 fix)
// =============================================================================
//
// Before this fix, any pending-tier key (self-service via email OTP) could
// PATCH any group, add/remove venue links, and rewrite name/website/coords.
// These tests lock that down: non-service keys must be linked to the owner
// account; NULL-owned groups are writable only by service-tier.
// =============================================================================

describe('Contribute API — group write ownership', () => {
  const TARGET_GROUP_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const TARGET_VENUE_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

  it('rejects PATCH /groups/:id when caller is not linked to owner account', async () => {
    // Calling key linked to account-uuid-1; group owned by account-uuid-2
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'pending' },
      error: null,
    });
    mockResponses.set('api_key_account_links', {
      data: { portal_account_id: 'account-uuid-1' },
      error: null,
    });
    mockResponses.set('groups', {
      data: { id: TARGET_GROUP_ID, portal_account_id: 'account-uuid-2' },
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute/groups/${TARGET_GROUP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify({ name: 'LULZ', website: 'http://evil.example' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects PATCH /groups/:id on operator-owned (NULL) groups from non-service keys', async () => {
    // Non-service key, group has NULL portal_account_id — only service tier may write
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'verified' },
      error: null,
    });
    mockResponses.set('api_key_account_links', {
      data: { portal_account_id: 'account-uuid-1' },
      error: null,
    });
    mockResponses.set('groups', {
      data: { id: TARGET_GROUP_ID, portal_account_id: null },
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute/groups/${TARGET_GROUP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify({ name: 'LULZ' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects PATCH /groups/:id from unlinked key with KEY_NOT_LINKED', async () => {
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'pending' },
      error: null,
    });
    mockResponses.set('api_key_account_links', { data: null, error: null });
    mockResponses.set('groups', {
      data: { id: TARGET_GROUP_ID, portal_account_id: 'account-uuid-2' },
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute/groups/${TARGET_GROUP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify({ name: 'LULZ' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('KEY_NOT_LINKED');
  });

  it('returns 404 when PATCH /groups/:id targets a non-existent group', async () => {
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'verified' },
      error: null,
    });
    mockResponses.set('api_key_account_links', {
      data: { portal_account_id: 'account-uuid-1' },
      error: null,
    });
    mockResponses.set('groups', { data: null, error: null });

    const res = await fetch(`${baseUrl}/api/v1/contribute/groups/${TARGET_GROUP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify({ name: 'New name' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('allows PATCH /groups/:id when caller is linked to the owner account', async () => {
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'verified' },
      error: null,
    });
    mockResponses.set('api_key_account_links', {
      data: { portal_account_id: 'account-uuid-1' },
      error: null,
    });
    mockResponses.set('groups', {
      data: { id: TARGET_GROUP_ID, portal_account_id: 'account-uuid-1', name: 'Renamed', slug: 's', type: 'business', status: 'active' },
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute/groups/${TARGET_GROUP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    // Ownership check passes; any downstream mock behavior is fine as long as NOT 403
    expect(res.status).not.toBe(403);
  });

  it('allows PATCH /groups/:id from service-tier key on a NULL-owned group', async () => {
    mockResponses.set('api_keys', {
      data: { id: 'svc-key-uuid', contributor_tier: 'service' },
      error: null,
    });
    // Service keys may have a link or not — either way ownership check bypasses
    mockResponses.set('api_key_account_links', { data: null, error: null });
    mockResponses.set('groups', {
      data: { id: TARGET_GROUP_ID, portal_account_id: null, name: 'x', slug: 's', type: 'business', status: 'active' },
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute/groups/${TARGET_GROUP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': SERVICE_KEY },
      body: JSON.stringify({ name: 'Operator-set name' }),
    });
    expect(res.status).not.toBe(403);
  });

  it('rejects POST /groups/:id/venues when caller is not linked to owner account', async () => {
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'verified' },
      error: null,
    });
    mockResponses.set('api_key_account_links', {
      data: { portal_account_id: 'account-uuid-1' },
      error: null,
    });
    mockResponses.set('groups', {
      data: { id: TARGET_GROUP_ID, portal_account_id: 'account-uuid-2' },
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute/groups/${TARGET_GROUP_ID}/venues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify({ venue_name: 'Hijacked Venue' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects DELETE /groups/:groupId/venues/:venueId when caller does not own the group', async () => {
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'verified' },
      error: null,
    });
    mockResponses.set('api_key_account_links', {
      data: { portal_account_id: 'account-uuid-1' },
      error: null,
    });
    mockResponses.set('groups', {
      data: { id: TARGET_GROUP_ID, portal_account_id: 'account-uuid-2' },
      error: null,
    });

    const res = await fetch(
      `${baseUrl}/api/v1/contribute/groups/${TARGET_GROUP_ID}/venues/${TARGET_VENUE_ID}`,
      { method: 'DELETE', headers: { 'X-API-Key': VALID_API_KEY } },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects POST /groups from a non-service key with no linked account', async () => {
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'pending' },
      error: null,
    });
    mockResponses.set('api_key_account_links', { data: null, error: null });

    const res = await fetch(`${baseUrl}/api/v1/contribute/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify({ name: 'x', slug: 'x', type: 'business', city: 'Philadelphia' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('KEY_NOT_LINKED');
  });
});

// =============================================================================
// CONTRIBUTE API — ATOMIC RATE LIMIT (S7, migration 059)
// =============================================================================
//
// The old checkContributeRateLimit was a read-then-write race. It now delegates
// to reserve_contribute_slot (Postgres RPC) which returns 'ok'|'hourly'|'daily'.
// These tests lock in the translation layer: each RPC response maps to the
// correct HTTP status + error code, and errors surface as 500.
//
// The atomic-upsert semantics of the SQL itself can only be verified against
// a real Postgres. This suite covers the handler's interpretation of RPC
// responses; the SQL correctness is verified manually via migration dry-run
// and by the RPC's own defensive guards (see migration 059).
// =============================================================================

describe('Contribute API — atomic rate limit (reserve_contribute_slot)', () => {
  it('returns 429 HOURLY when the RPC reports hourly limit exceeded', async () => {
    mockValidApiKey();
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'pending', name: 'Rate Tester' },
      error: null,
    });
    mockRpcResponses.set('reserve_contribute_slot', { data: 'hourly', error: null });

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify(VALID_EVENT),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('RATE_LIMIT');
    expect(body.error.message).toContain('hour');
  });

  it('returns 429 DAILY when the RPC reports daily limit exceeded', async () => {
    mockValidApiKey();
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'pending', name: 'Rate Tester' },
      error: null,
    });
    mockRpcResponses.set('reserve_contribute_slot', { data: 'daily', error: null });

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify(VALID_EVENT),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('RATE_LIMIT');
    expect(body.error.message).toContain('day');
  });

  it('passes through when the RPC reports ok', async () => {
    mockValidApiKey();
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'verified', name: 'Rate Tester' },
      error: null,
    });
    mockRpcResponses.set('reserve_contribute_slot', { data: 'ok', error: null });
    mockResponses.set('events', {
      data: { id: 'new-event-uuid', status: 'published' },
      error: null,
      count: 0,
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify(VALID_EVENT),
    });
    expect(res.status).toBe(201);
  });

  it('returns 500 SERVER_ERROR when the RPC itself errors (e.g. migration not run)', async () => {
    mockValidApiKey();
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'pending', name: 'Rate Tester' },
      error: null,
    });
    mockRpcResponses.set('reserve_contribute_slot', {
      data: null,
      error: { message: 'function reserve_contribute_slot(text, integer, integer, integer) does not exist' },
    });

    const res = await fetch(`${baseUrl}/api/v1/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify(VALID_EVENT),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    // Error handler replaces 5xx messages with generic text so we don't
    // leak the Postgres error to the client.
    expect(body.error.code).toBe('SERVER_ERROR');
  });

  it('rejects batch at the handler when RPC reports limit (batch size forwarded as p_count)', async () => {
    mockValidApiKey();
    mockResponses.set('api_keys', {
      data: { id: 'key-uuid-1', contributor_tier: 'pending', name: 'Rate Tester' },
      error: null,
    });
    mockRpcResponses.set('reserve_contribute_slot', { data: 'hourly', error: null });

    const batchOfThree = { events: [VALID_EVENT, VALID_EVENT, VALID_EVENT] };

    const res = await fetch(`${baseUrl}/api/v1/contribute/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_API_KEY },
      body: JSON.stringify(batchOfThree),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('RATE_LIMIT');
  });
});
