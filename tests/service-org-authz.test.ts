/**
 * Service API — organization authorization (C-1 regression).
 *
 * Linking grants write authority (assertLinkedOrganization authorizes on the
 * presence of an api_key_organization_links row), so POST /service/organizations/link
 * must be gated on a real ownership relationship — not mere org existence.
 * Otherwise any activated key could self-grant control of any org (cross-tenant
 * takeover). These tests lock that in, plus the cross-tenant write guard.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

const mockResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown; count?: number }>());

vi.mock('../src/lib/supabase.js', () => {
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const methods = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in',
      'insert', 'update', 'delete', 'upsert', 'maybeSingle', 'single',
    ];
    for (const m of methods) c[m] = () => c;
    c.then = (resolve: (v: unknown) => void) =>
      Promise.resolve(mockResponses.get(table) || { data: null, error: null, count: 0 }).then(resolve);
    return c;
  }
  return {
    supabaseAdmin: { from: (t: string) => chain(t), auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) } },
    createUserClient: () => ({ from: (t: string) => chain(t) }),
  };
});

vi.mock('../src/lib/webhook-delivery.js', () => ({
  dispatchWebhooks: vi.fn(), dispatchEventWebhookById: vi.fn(),
  dispatchSeriesCreatedWebhook: vi.fn(), deliverTestWebhook: vi.fn(),
}));

import { createApp } from '../src/app.js';

const SERVICE_KEY = 'nc_service_key_0123456789abcdef';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ORG_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** Resolve the calling key (requireServiceApiKey reads api_keys). */
function setKey(opts: { tenantAccountId?: string | null; isAdmin?: boolean }) {
  mockResponses.set('api_keys', {
    data: {
      id: 'key-1',
      contributor_tier: 'service',
      is_admin: opts.isAdmin ?? false,
      tenant_account_id: opts.tenantAccountId ?? null,
      activated_at: '2026-01-01T00:00:00Z',
      raw_key_hash: '',
    },
    error: null,
  });
}

function setOrg(ownerAccountId: string | null) {
  mockResponses.set('organizations', {
    data: {
      id: ORG_ID, owner_account_id: ownerAccountId,
      slug: 'victim-venue', name: 'Victim Venue', legal_name: null,
      tags: [], commercial: null, method: 'seeded', primary_place_id: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    },
    error: null,
  });
}

function setLinkExists(exists: boolean) {
  mockResponses.set('api_key_organization_links', { data: exists ? { api_key_id: 'key-1' } : null, error: null });
}

beforeEach(() => {
  mockResponses.clear();
  mockResponses.set('organization_verifications', { data: [], count: 0, error: null });
  mockResponses.set('places', { data: null, error: null });
});

async function postLink() {
  return fetch(`${baseUrl}/api/v1/service/organizations/link`, {
    method: 'POST',
    headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ organizationId: ORG_ID }),
  });
}

describe('POST /service/organizations/link — ownership gate (C-1)', () => {
  it('rejects linking to an organization the key does not own', async () => {
    setKey({ tenantAccountId: TENANT_A, isAdmin: false });
    setOrg(TENANT_B); // owned by someone else
    setLinkExists(false);

    const res = await postLink();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_LINKED');
  });

  it('rejects linking to an unowned (seeded) organization', async () => {
    setKey({ tenantAccountId: TENANT_A, isAdmin: false });
    setOrg(null); // owner_account_id NULL must not be self-claimable
    setLinkExists(false);

    const res = await postLink();
    expect(res.status).toBe(403);
  });

  it('allows linking to an organization owned by the key\'s own tenant account', async () => {
    setKey({ tenantAccountId: TENANT_A, isAdmin: false });
    setOrg(TENANT_A);
    setLinkExists(false);

    const res = await postLink();
    expect(res.status).toBe(201);
  });

  it('lets an admin key link to any organization', async () => {
    setKey({ tenantAccountId: null, isAdmin: true });
    setOrg(TENANT_B);
    setLinkExists(false);

    const res = await postLink();
    expect(res.status).toBe(201);
  });
});

describe('cross-tenant write guard', () => {
  it('rejects PATCH on an organization the key is not linked to', async () => {
    setKey({ tenantAccountId: TENANT_A, isAdmin: false });
    setOrg(TENANT_A);
    setLinkExists(false); // no api_key_organization_links row → assertLinkedOrganization fails

    const res = await fetch(`${baseUrl}/api/v1/service/organizations/${ORG_ID}`, {
      method: 'PATCH',
      headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked Name' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_LINKED');
  });
});
