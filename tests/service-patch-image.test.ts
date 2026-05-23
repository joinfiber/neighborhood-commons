/**
 * Service API — PATCH /service/events/:id image_url + edit-webhook wiring
 *
 * Locks three behaviors added to close the Merrie gaps:
 *
 *   1. Gap 1 — a string image_url on PATCH fetches/attaches the cover
 *      (downloadAndAttachImage), and explicit null clears event_image_url.
 *      Previously the field was dropped on update.
 *   2. The photo gate — a service-key-claimed tenant (claimed_at, no
 *      auth_user_id) may attach; an unclaimed shell gets 403.
 *   3. Gap 3 — ordinary content edits dispatch event.updated, while the
 *      pending->published transition still dispatches event.created (no
 *      double-fire).
 *
 * The default organizer owner here is a Merrie-like tenant (claimed_at only),
 * so the happy-path attach test doubles as the gate-fix regression.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

const mockResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown; count?: number }>());
const mockRpcResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown }>());
const updatePayloads = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../src/lib/supabase.js', () => {
  function createQueryChain(table: string) {
    const chain: Record<string, unknown> = {};
    const methods = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in',
      'insert', 'update', 'delete', 'upsert', 'maybeSingle', 'single',
    ];
    for (const m of methods) {
      chain[m] = (...args: unknown[]) => {
        if (m === 'update') updatePayloads.set(table, args[0]);
        return chain;
      };
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

const dispatchEventWebhookByIdMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/webhook-delivery.js', () => ({
  dispatchWebhooks: vi.fn(),
  dispatchEventWebhookById: dispatchEventWebhookByIdMock,
  dispatchSeriesCreatedWebhook: vi.fn(),
  deliverTestWebhook: vi.fn(),
}));

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
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const EVENT_ID = '33333333-3333-3333-3333-333333333333';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  const addr = server.address();
  if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  mockResponses.clear();
  mockRpcResponses.clear();
  updatePayloads.clear();
  downloadAndAttachImageMock.mockClear();
  dispatchEventWebhookByIdMock.mockClear();

  // Admin service key — bypasses linked-org scoping.
  mockResponses.set('api_keys', {
    data: { id: 'svc-key-uuid', contributor_tier: 'service', is_admin: true, raw_key_hash: '', activated_at: '2025-01-01T00:00:00Z' },
    error: null,
  });
  // Existing event (published one-off, self_asserted). Same row answers both
  // the assertLinkedEvent lookup and the existing-row fetch.
  mockResponses.set('events', {
    data: {
      id: EVENT_ID,
      content: 'Open Mic',
      event_timezone: 'America/New_York',
      status: 'published',
      organizer_org_id: ORG_ID,
      source_method: 'self_asserted',
      event_at: null,
      end_time: null,
    },
    error: null,
  });
  mockResponses.set('organizations', {
    data: { id: ORG_ID, name: "Johnny's Bar", owner_account_id: ACCOUNT_ID, primary_place_id: null },
    error: null,
  });
  // Default owner: a Merrie-like tenant — service-key-claimed, NOT auth-backed.
  mockResponses.set('portal_accounts', {
    data: { id: ACCOUNT_ID, auth_user_id: null, claimed_at: '2026-01-01T00:00:00Z' },
    error: null,
  });
  mockResponses.set('places', { data: null, error: null });
  mockResponses.set('api_key_organization_links', { data: { organization_id: ORG_ID }, error: null });
  mockRpcResponses.set('find_user_region', { data: null, error: null });
});

async function patch(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/service/events/${EVENT_ID}`, {
    method: 'PATCH',
    headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /service/events/:id — image_url', () => {
  it('attaches a string image_url for a claimed-tenant organizer (gate-fix regression)', async () => {
    const res = await patch({ image_url: 'https://example.com/poster.jpg' });
    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));
    expect(downloadAndAttachImageMock).toHaveBeenCalledTimes(1);
    expect(downloadAndAttachImageMock).toHaveBeenCalledWith(EVENT_ID, 'https://example.com/poster.jpg');
  });

  it('clears the cover when image_url is null (no fetch, event_image_url set null)', async () => {
    const res = await patch({ image_url: null });
    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));
    expect(downloadAndAttachImageMock).not.toHaveBeenCalled();
    expect(updatePayloads.get('events')).toMatchObject({ event_image_url: null });
  });

  it('403 IMAGE_NOT_PERMITTED when the organizer owner is an unclaimed shell', async () => {
    mockResponses.set('portal_accounts', {
      data: { id: ACCOUNT_ID, auth_user_id: null, claimed_at: null },
      error: null,
    });
    const res = await patch({ image_url: 'https://example.com/poster.jpg' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('IMAGE_NOT_PERMITTED');

    await new Promise((r) => setImmediate(r));
    expect(downloadAndAttachImageMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /service/events/:id — edit webhooks (Gap 3)', () => {
  it('dispatches event.updated on an ordinary content edit', async () => {
    const res = await patch({ description: 'Updated description' });
    expect(res.status).toBe(200);

    expect(dispatchEventWebhookByIdMock).toHaveBeenCalledWith('event.updated', EVENT_ID, { onlyPublished: true });
    expect(downloadAndAttachImageMock).not.toHaveBeenCalled();
  });

  it('still dispatches event.created (not event.updated) on the pending->published transition', async () => {
    mockResponses.set('events', {
      data: {
        id: EVENT_ID,
        content: 'Open Mic',
        event_timezone: 'America/New_York',
        status: 'pending_review',
        organizer_org_id: ORG_ID,
        source_method: 'self_asserted',
        event_at: null,
        end_time: null,
      },
      error: null,
    });

    const res = await patch({ status: 'published' });
    expect(res.status).toBe(200);

    const types = dispatchEventWebhookByIdMock.mock.calls.map((c) => c[0]);
    expect(types).toContain('event.created');
    expect(types).not.toContain('event.updated');
  });
});
