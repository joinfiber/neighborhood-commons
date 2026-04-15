/**
 * Service API — image_url wiring regression test
 *
 * The Spec's ServiceEventInput documents image_url as a URL the Commons
 * fetches, re-encodes, and attaches to the event. Before this test the
 * handler validated the field but dropped it — events were silently
 * published with no image.
 *
 * This test locks in the wiring: when POST /service/events receives
 * image_url, downloadAndAttachImage must be called with (newEventId, url)
 * after the insert, fire-and-forget.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

const mockResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown; count?: number }>());
const mockRpcResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown }>());

vi.mock('../src/lib/supabase.js', () => {
  function createQueryChain(table: string) {
    const chain: Record<string, unknown> = {};
    const methods = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in',
      'insert', 'update', 'delete', 'upsert', 'maybeSingle', 'single',
    ];
    for (const m of methods) chain[m] = () => chain;
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
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    },
    createUserClient: () => ({ from: (table: string) => createQueryChain(table) }),
  };
});

vi.mock('../src/lib/webhook-delivery.js', () => ({
  dispatchWebhooks: vi.fn(),
  dispatchSeriesCreatedWebhook: vi.fn(),
  deliverTestWebhook: vi.fn(),
}));

// Track calls to downloadAndAttachImage — this is the wiring under test
const downloadAndAttachImageMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../src/lib/image-processing.js', () => ({
  downloadAndAttachImage: downloadAndAttachImageMock,
  processAndUploadImage: vi.fn(),
}));

vi.mock('../src/lib/geocoding.js', () => ({
  nominatimGeocode: vi.fn().mockResolvedValue(null),
}));

import { createApp } from '../src/app.js';

const SERVICE_KEY = 'nc_service_key_0123456789abcdef';
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const NEW_EVENT_ID = '22222222-2222-2222-2222-222222222222';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  const addr = server.address();
  if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  mockResponses.clear();
  mockRpcResponses.clear();
  downloadAndAttachImageMock.mockClear();

  // Admin service key — bypasses linked-account scoping
  mockResponses.set('api_keys', {
    data: { id: 'svc-key-uuid', contributor_tier: 'service', is_admin: true, raw_key_hash: '' },
    error: null,
  });
  mockResponses.set('portal_accounts', {
    data: {
      id: ACCOUNT_ID,
      auth_user_id: 'auth-user-1',
      business_name: 'Johnny\'s Bar',
      default_address: null,
      default_latitude: null,
      default_longitude: null,
    },
    error: null,
  });
  mockResponses.set('events', {
    data: { id: NEW_EVENT_ID, content: 'Open Mic', event_timezone: 'America/New_York' },
    error: null,
  });
  mockRpcResponses.set('find_user_region', { data: null, error: null });
});

function futureIso(daysAhead = 7): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(19, 0, 0, 0);
  return d.toISOString().replace('Z', '-04:00').replace(/\.\d{3}/, '');
}

const BASE_PAYLOAD = {
  account_id: ACCOUNT_ID,
  name: 'Open Mic Night',
  timezone: 'America/New_York',
  category: 'live_music',
  location: { name: 'Johnny\'s Bar' },
};

describe('POST /service/events — image_url wiring', () => {
  it('calls downloadAndAttachImage with the new event id when image_url is provided', async () => {
    const res = await fetch(`${baseUrl}/api/v1/service/events`, {
      method: 'POST',
      headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...BASE_PAYLOAD,
        start: futureIso(),
        image_url: 'https://example.com/poster.jpg',
      }),
    });

    expect(res.status).toBe(201);

    // Fire-and-forget runs on next tick — wait for microtasks to drain
    await new Promise((r) => setImmediate(r));

    expect(downloadAndAttachImageMock).toHaveBeenCalledTimes(1);
    expect(downloadAndAttachImageMock).toHaveBeenCalledWith(NEW_EVENT_ID, 'https://example.com/poster.jpg');
  });

  it('does not call downloadAndAttachImage when image_url is omitted', async () => {
    const res = await fetch(`${baseUrl}/api/v1/service/events`, {
      method: 'POST',
      headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...BASE_PAYLOAD, start: futureIso() }),
    });

    expect(res.status).toBe(201);
    await new Promise((r) => setImmediate(r));
    expect(downloadAndAttachImageMock).not.toHaveBeenCalled();
  });

  it('still returns 201 when image attach rejects (fire-and-forget must not fail the create)', async () => {
    downloadAndAttachImageMock.mockRejectedValueOnce(new Error('SSRF blocked'));

    const res = await fetch(`${baseUrl}/api/v1/service/events`, {
      method: 'POST',
      headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...BASE_PAYLOAD,
        start: futureIso(),
        image_url: 'https://169.254.169.254/metadata',
      }),
    });

    expect(res.status).toBe(201);
    await new Promise((r) => setImmediate(r));
    expect(downloadAndAttachImageMock).toHaveBeenCalledTimes(1);
  });
});
