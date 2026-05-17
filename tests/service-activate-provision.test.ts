/**
 * Service API — POST /service/api-keys/:id/activate with provision_account (v2)
 *
 * Tenant-umbrella consumers receive their tenant portal_account UUID at the
 * moment of activation, not via a separate /accounts/link round-trip. The
 * activation endpoint atomically (a) flips the pending key to active and
 * (b) creates the consumer's tenant portal_account.
 *
 * v2 (migration 082): the legacy api_key_account_links table is gone.
 * Writeable scope is established separately via
 * POST /service/organizations/link after activation.
 *
 * Verifies:
 *  - Activation without provision_account works as before (no behavior change
 *    for per-operator portable consumers).
 *  - Activation with provision_account creates the account and returns the UUID.
 *  - Idempotent activation (already-active key) ignores provision_account.
 *  - Non-admin keys are 403'd.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

type Response = { data: unknown; error: unknown; count?: number };

// Per-table queues. If a table has a queue, each call consumes the next entry
// (the last one repeats for subsequent calls — sticky tail). If no queue,
// returns an empty default. This lets a single request handle multiple reads
// of the same table (e.g. middleware auth then handler target-lookup) with
// different responses.
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

function setQueue(table: string, responses: Response[]) {
  mockQueues.set(table, responses);
}

function setSingle(table: string, response: Response) {
  mockQueues.set(table, [response]);
}

import { createApp } from '../src/app.js';

const ADMIN_KEY = 'nc_admin_key_0123456789abcdef';
const NON_ADMIN_KEY = 'nc_service_key_0123456789abcdef';
const TARGET_KEY_ID = '11111111-1111-1111-1111-111111111111';
const NEW_ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const EXISTING_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';

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

/**
 * Build a two-step api_keys queue:
 *   [0] middleware auth lookup → caller's admin key (must be active + admin)
 *   [1] handler's target-key lookup → the key being activated
 *   [2+] (handler update + select on activation) → return the activated row
 */
function setApiKeyFlow(opts: {
  callerIsAdmin?: boolean;
  targetActivatedAt?: string | null;
  targetReturnsAfterUpdate?: Record<string, unknown>;
}) {
  const callerIsAdmin = opts.callerIsAdmin ?? true;
  const targetActivatedAt = opts.targetActivatedAt ?? null;

  setQueue('api_keys', [
    // (1) middleware auth — caller's key
    {
      data: {
        id: 'caller-key-uuid',
        contributor_tier: 'service',
        is_admin: callerIsAdmin,
        raw_key_hash: '',
        activated_at: '2025-01-01T00:00:00Z',
      },
      error: null,
    },
    // (2) handler target-key read
    {
      data: {
        id: TARGET_KEY_ID,
        contributor_tier: 'service',
        activated_at: targetActivatedAt,
        application_metadata: null,
      },
      error: null,
    },
    // (3+) handler's update().select() — sticky tail
    {
      data: opts.targetReturnsAfterUpdate ?? {
        id: TARGET_KEY_ID,
        key_prefix: 'nc_a1b2c3d4',
        name: 'Test Key',
        contact_email: 'dev@example.com',
        contributor_tier: 'service',
        rate_limit_per_hour: 300,
        brand_config: null,
        verification_authority: null,
        activated_at: '2026-05-14T08:00:00Z',
        application_metadata: null,
        created_at: '2026-05-13T00:00:00Z',
      },
      error: null,
    },
  ]);
}

beforeEach(() => {
  mockQueues.clear();
  mockCallCounts.clear();
});

// ===========================================================================
// Activation without provision_account — unchanged behavior
// ===========================================================================

describe('POST /service/api-keys/:id/activate — no provision_account', () => {
  it('activates a pending key and returns the api_key without account info', async () => {
    setApiKeyFlow({ callerIsAdmin: true, targetActivatedAt: null });

    const res = await fetch(`${baseUrl}/api/v1/service/api-keys/${TARGET_KEY_ID}/activate`, {
      method: 'POST',
      headers: { 'X-API-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already_active).toBe(false);
    expect(body.api_key).toBeDefined();
    expect(body.account).toBeUndefined();
    expect(body.account_created).toBeUndefined();
  });

  it('is idempotent on an already-active key', async () => {
    setApiKeyFlow({ callerIsAdmin: true, targetActivatedAt: '2026-01-15T12:00:00Z' });

    const res = await fetch(`${baseUrl}/api/v1/service/api-keys/${TARGET_KEY_ID}/activate`, {
      method: 'POST',
      headers: { 'X-API-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already_active).toBe(true);
  });
});

// ===========================================================================
// Activation with provision_account — tenant-umbrella golden path
// ===========================================================================

describe('POST /service/api-keys/:id/activate — with provision_account', () => {
  it('creates the tenant account and returns its UUID on first activation', async () => {
    setApiKeyFlow({ callerIsAdmin: true, targetActivatedAt: null });
    // portal_accounts queue:
    //   [0] handler email lookup — nothing exists yet (null)
    //   [1] insert returns the new account row
    //   [2+] sticky — not consulted after this point
    setQueue('portal_accounts', [
      { data: null, error: null },
      {
        data: {
          id: NEW_ACCOUNT_ID,
          email: 'tenant@no-reply.marys-app.com',
          status: 'active',
          claimed_at: '2026-05-14T00:00:00Z',
          claimed_by: 'marys-app',
          auth_user_id: null,
        },
        error: null,
      },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/service/api-keys/${TARGET_KEY_ID}/activate`, {
      method: 'POST',
      headers: { 'X-API-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provision_account: {
          email: 'tenant@no-reply.marys-app.com',
          claimed_by: 'marys-app',
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already_active).toBe(false);
    expect(body.account).toBeDefined();
    expect(body.account.id).toBe(NEW_ACCOUNT_ID);
    expect(body.account_created).toBe(true);
  });

  it('rejects 409 CONFLICT when the email matches an account with auth_user_id set', async () => {
    setApiKeyFlow({ callerIsAdmin: true, targetActivatedAt: null });
    // Existing account with auth_user_id set — legacy Supabase Auth owner.
    setSingle('portal_accounts', {
      data: {
        id: EXISTING_ACCOUNT_ID,
        email: 'tenant@no-reply.marys-app.com',
        status: 'active',
        claimed_at: '2025-01-01T00:00:00Z',
        claimed_by: 'legacy',
        auth_user_id: 'auth-user-uuid',
      },
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/service/api-keys/${TARGET_KEY_ID}/activate`, {
      method: 'POST',
      headers: { 'X-API-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provision_account: {
          email: 'tenant@no-reply.marys-app.com',
          claimed_by: 'marys-app',
        },
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });

  it('rejects 409 CONFLICT when the email is claimed by a different consumer', async () => {
    setApiKeyFlow({ callerIsAdmin: true, targetActivatedAt: null });
    setSingle('portal_accounts', {
      data: {
        id: EXISTING_ACCOUNT_ID,
        email: 'tenant@no-reply.marys-app.com',
        status: 'active',
        claimed_at: '2026-01-01T00:00:00Z',
        claimed_by: 'gothere',   // different from Mary's request
        auth_user_id: null,
      },
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/service/api-keys/${TARGET_KEY_ID}/activate`, {
      method: 'POST',
      headers: { 'X-API-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provision_account: {
          email: 'tenant@no-reply.marys-app.com',
          claimed_by: 'marys-app',
        },
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });
});

// ===========================================================================
// Auth gate
// ===========================================================================

describe('POST /service/api-keys/:id/activate — auth', () => {
  it('returns 403 FORBIDDEN for non-admin service keys', async () => {
    setApiKeyFlow({ callerIsAdmin: false, targetActivatedAt: null });

    const res = await fetch(`${baseUrl}/api/v1/service/api-keys/${TARGET_KEY_ID}/activate`, {
      method: 'POST',
      headers: { 'X-API-Key': NON_ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
  });
});
