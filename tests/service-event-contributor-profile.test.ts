/**
 * Service API — events.contributor_profile_id stamping
 *
 * Migration 086 added events.contributor_profile_id and intended the
 * service-event POST handler to populate it, but the wiring never shipped —
 * events only carried the name snapshot, so the rich "via <app>" card
 * (logo/slug/profile_url) never lit up for events. This locks the stamp:
 * POST /service/events must set contributor_profile_id from the calling key's
 * registered profile (mirroring POST /service/organizations), and leave it
 * null for keys without one.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

const mockResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown; count?: number }>());
const mockRpcResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown }>());
const insertPayloads = vi.hoisted(() => new Map<string, unknown>());

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
        if (m === 'insert') insertPayloads.set(table, args[0]);
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

vi.mock('../src/lib/webhook-delivery.js', () => ({
  dispatchWebhooks: vi.fn(),
  dispatchEventWebhookById: vi.fn(),
  dispatchSeriesCreatedWebhook: vi.fn(),
  deliverTestWebhook: vi.fn(),
}));
vi.mock('../src/lib/image-processing.js', () => ({
  downloadAndAttachImage: vi.fn().mockResolvedValue(undefined),
  processAndUploadImage: vi.fn(),
}));
vi.mock('../src/lib/geocoding.js', () => ({ nominatimGeocode: vi.fn().mockResolvedValue(null) }));

import { createApp } from '../src/app.js';

const SERVICE_KEY = 'nc_service_key_0123456789abcdef';
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const PROFILE_ID = '44444444-4444-4444-4444-444444444444';
const NEW_EVENT_ID = '33333333-3333-3333-3333-333333333333';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  const addr = server.address();
  if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

function seedCommon(contributorProfileId: string | null) {
  mockResponses.clear();
  mockRpcResponses.clear();
  insertPayloads.clear();
  // Non-admin service key, optionally bound to a registered contributor profile.
  mockResponses.set('api_keys', {
    data: {
      id: 'svc-key-uuid', contributor_tier: 'service', is_admin: false,
      brand_config: { app_name: 'Merrie' }, contributor_profile_id: contributorProfileId,
      raw_key_hash: '', activated_at: '2025-01-01T00:00:00Z',
    },
    error: null,
  });
  mockResponses.set('api_key_organization_links', { data: { organization_id: ORG_ID }, error: null });
  mockResponses.set('organizations', {
    data: { id: ORG_ID, name: 'Alice Chess Club', owner_account_id: ACCOUNT_ID, primary_place_id: null },
    error: null,
  });
  mockResponses.set('portal_accounts', { data: { id: ACCOUNT_ID, auth_user_id: 'u1', claimed_at: '2026-01-01T00:00:00Z' }, error: null });
  mockResponses.set('places', { data: null, error: null });
  mockResponses.set('organization_verifications', { data: null, count: 0, error: null });
  mockResponses.set('events', { data: { id: NEW_EVENT_ID, content: 'Open Mic', event_timezone: 'America/New_York' }, error: null });
  mockRpcResponses.set('find_user_region', { data: null, error: null });
}

function futureIso(): string {
  const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(19, 0, 0, 0);
  return d.toISOString().replace('Z', '-04:00').replace(/\.\d{3}/, '');
}
const BASE = { organizerOrganizationId: ORG_ID, name: 'Open Mic Night', timezone: 'America/New_York', category: 'community', location: { name: 'The Hall' } };

async function postEvent() {
  return fetch(`${baseUrl}/api/v1/service/events`, {
    method: 'POST',
    headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...BASE, start: futureIso() }),
  });
}

describe('POST /service/events — contributor_profile_id stamping', () => {
  it("stamps the calling key's contributor_profile_id onto the event", async () => {
    seedCommon(PROFILE_ID);
    const res = await postEvent();
    expect(res.status).toBe(201);
    expect((insertPayloads.get('events') as Record<string, unknown>).contributor_profile_id).toBe(PROFILE_ID);
  });

  it('leaves contributor_profile_id null when the key has no registered profile', async () => {
    seedCommon(null);
    const res = await postEvent();
    expect(res.status).toBe(201);
    expect((insertPayloads.get('events') as Record<string, unknown>).contributor_profile_id).toBeNull();
  });
});
