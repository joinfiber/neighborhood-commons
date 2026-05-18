/**
 * Service API — PATCH /service/events/:id/organizer regression tests (v2)
 *
 * Verifies the v2 constrained-publishing rules for re-attributing an
 * event organizer:
 *  - Schema accepts only organizerOrganizationId (no organizerPersonId in v2).
 *  - Caller must be linked to the CURRENT organizer_org_id (or admin /
 *    witness on witnessed events) — guarded by assertLinkedEvent.
 *  - Caller must ALSO be linked to the TARGET organization — re-attribution
 *    cannot hand off events to orgs the caller doesn't control.
 *  - Target organization must exist.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import { assignOrganizerSchema } from '../src/routes/service/events.js';

// ---------------------------------------------------------------------------
// Mock Supabase — hoisted before app import
// ---------------------------------------------------------------------------

type Response = { data: unknown; error: unknown; count?: number };
const mockQueues = vi.hoisted(() => new Map<string, Response[]>());
const mockCallCounts = vi.hoisted(() => new Map<string, number>());

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
      const queue = mockQueues.get(table);
      let response: Response;
      if (queue && queue.length > 0) {
        const idx = mockCallCounts.get(table) ?? 0;
        response = queue[Math.min(idx, queue.length - 1)]!;
        mockCallCounts.set(table, idx + 1);
      } else {
        response = { data: [], error: null, count: 0 };
      }
      return Promise.resolve(response).then(resolve, reject);
    };
    return chain;
  }
  return {
    supabaseAdmin: {
      from: (table: string) => createQueryChain(table),
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

import { createApp } from '../src/app.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SERVICE_KEY = 'nc_service_key_0123456789abcdef';
const KEY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EVENT_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_ORG_ID = '44444444-4444-4444-4444-444444444444';

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
  mockQueues.clear();
  mockCallCounts.clear();
  // Non-admin service-tier key. v2 link checks apply.
  mockQueues.set('api_keys', [{
    data: {
      id: KEY_ID,
      contributor_tier: 'service',
      is_admin: false,
      witness_authority: false,
      activated_at: '2025-01-01T00:00:00Z',
    },
    error: null,
  }]);
});

function setEvent(overrides: Record<string, unknown> = {}) {
  mockQueues.set('events', [{
    data: {
      id: EVENT_ID,
      organizer_org_id: ORG_ID,
      source_method: 'self_asserted',
      content: 'Test event',
      event_at: '2026-06-01T19:00:00-04:00',
      event_timezone: 'America/New_York',
      category: 'community',
      ...overrides,
    },
    error: null,
  }]);
}

// ===========================================================================
// Schema-level: v2 has only organizerOrganizationId
// ===========================================================================

describe('assignOrganizerSchema (v2)', () => {
  it('accepts a valid organizerOrganizationId', () => {
    const r = assignOrganizerSchema.safeParse({ organizerOrganizationId: ORG_ID });
    expect(r.success).toBe(true);
  });

  it('rejects empty body (organizerOrganizationId is required)', () => {
    const r = assignOrganizerSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('rejects organizerPersonId (no longer supported in v2)', () => {
    const r = assignOrganizerSchema.safeParse({ organizerPersonId: '55555555-5555-5555-5555-555555555555' });
    expect(r.success).toBe(false);
  });

  it('rejects non-UUID values', () => {
    const r = assignOrganizerSchema.safeParse({ organizerOrganizationId: 'not-a-uuid' });
    expect(r.success).toBe(false);
  });

  it('rejects null (required field, not nullable in v2)', () => {
    const r = assignOrganizerSchema.safeParse({ organizerOrganizationId: null });
    expect(r.success).toBe(false);
  });
});

// ===========================================================================
// Integration: v2 link checks against api_key_organization_links
// ===========================================================================

describe('PATCH /service/events/:id/organizer (v2)', () => {
  it('authorizes when caller is linked to both the current AND target organizations', async () => {
    setEvent({ organizer_org_id: ORG_ID });
    // assertLinkedEvent → assertLinkedOrganization for ORG_ID (current organizer)
    // then assertLinkedOrganization for OTHER_ORG_ID (target).
    // Both succeed: queue two link rows.
    mockQueues.set('api_key_organization_links', [
      { data: { organization_id: ORG_ID }, error: null },
      { data: { organization_id: OTHER_ORG_ID }, error: null },
    ]);
    mockQueues.set('organizations', [{ data: { id: OTHER_ORG_ID }, error: null }]);

    const res = await fetch(`${baseUrl}/api/v1/service/events/${EVENT_ID}/organizer`, {
      method: 'PATCH',
      headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizerOrganizationId: OTHER_ORG_ID }),
    });

    expect(res.status).toBe(200);
  });

  it('returns 403 NOT_LINKED when caller is not linked to the current organizer', async () => {
    setEvent({ organizer_org_id: ORG_ID });
    // No api_key_organization_links rows for the current organizer.
    mockQueues.set('api_key_organization_links', [{ data: null, error: null }]);

    const res = await fetch(`${baseUrl}/api/v1/service/events/${EVENT_ID}/organizer`, {
      method: 'PATCH',
      headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizerOrganizationId: OTHER_ORG_ID }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_LINKED');
  });

  it('returns 404 when event does not exist', async () => {
    mockQueues.set('events', [{ data: null, error: null }]);

    const res = await fetch(`${baseUrl}/api/v1/service/events/${EVENT_ID}/organizer`, {
      method: 'PATCH',
      headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizerOrganizationId: ORG_ID }),
    });

    expect(res.status).toBe(404);
  });

  it('returns 404 when target organization does not exist', async () => {
    setEvent();
    mockQueues.set('api_key_organization_links', [
      { data: { organization_id: ORG_ID }, error: null },
    ]);
    mockQueues.set('organizations', [{ data: null, error: null }]);

    const res = await fetch(`${baseUrl}/api/v1/service/events/${EVENT_ID}/organizer`, {
      method: 'PATCH',
      headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizerOrganizationId: OTHER_ORG_ID }),
    });

    expect(res.status).toBe(404);
  });

  it('returns 400 when body is empty', async () => {
    setEvent();

    const res = await fetch(`${baseUrl}/api/v1/service/events/${EVENT_ID}/organizer`, {
      method: 'PATCH',
      headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});
