/**
 * Developer-portal API key refresh (in-place rotation) — integration tests.
 *
 * Two halves:
 *   - requireStepUp gating: no session → login; no MFA → enroll; MFA but
 *     stale session → step-up; elevated + enrolled → the confirm page.
 *   - The rotation: a CSRF'd POST updates api_keys.key_hash + key_prefix with
 *     a fresh nc_ key and surfaces it once. The falsifiable assertion is that
 *     the api_keys.update carried a new hash + nc_ prefix.
 *
 * Mock harness mirrors mfa-enrollment.test.ts (table:single / table:list keys,
 * updatedRows capture).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

vi.hoisted(() => {
  // createApp validates config; MFA crypto wants a key. Reuse the webhook one.
  process.env.WEBHOOK_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

const mockResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown; count?: number }>());
const updatedRows = vi.hoisted(() => new Map<string, Array<Record<string, unknown>>>());

vi.mock('../src/lib/supabase.js', () => {
  function createQueryChain(table: string) {
    const chain: Record<string, unknown> = {};
    let pendingUpdate: Record<string, unknown> | null = null;
    let isSingleShape = false;
    const passthrough = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in', 'contains', 'delete', 'insert', 'upsert',
    ];
    for (const m of passthrough) chain[m] = () => chain;
    chain.maybeSingle = () => { isSingleShape = true; return chain; };
    chain.single = () => { isSingleShape = true; return chain; };
    chain.update = (row: Record<string, unknown>) => {
      const list = updatedRows.get(table) || [];
      list.push(row); updatedRows.set(table, list);
      pendingUpdate = row; return chain;
    };
    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      const shapeKey = isSingleShape ? `${table}:single` : `${table}:list`;
      const override = mockResponses.get(shapeKey) ?? mockResponses.get(table);
      if (override) return Promise.resolve(override).then(resolve, reject);
      if (pendingUpdate) { pendingUpdate = null; return Promise.resolve({ data: null, error: null }).then(resolve, reject); }
      const empty = isSingleShape ? { data: null, error: null } : { data: [], error: null, count: 0 };
      return Promise.resolve(empty).then(resolve, reject);
    };
    return chain;
  }
  return {
    supabaseAdmin: {
      from: (t: string) => createQueryChain(t),
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: { message: 'no auth' } }) },
    },
    createUserClient: () => ({ from: (t: string) => createQueryChain(t) }),
  };
});

vi.mock('../src/lib/email.js', () => ({ sendEmail: vi.fn(async () => undefined) }));

import { createApp } from '../src/app.js';

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

afterAll(() => new Promise<void>((resolve) => { server?.close(() => resolve()); }));
beforeEach(() => { mockResponses.clear(); updatedRows.clear(); });

const RAW_SESSION_TOKEN = 'b'.repeat(64);
function sessionCookie(): string { return `nc_dev_session=${RAW_SESSION_TOKEN}`; }

function parseSetCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  const raw = res.headers.get('set-cookie');
  if (!raw) return out;
  for (const part of raw.split(/, (?=[a-zA-Z_]+=)/)) {
    const [pair] = part.split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return out;
}

function setupSession(opts: { mfaVerifiedAt?: string | null } = {}) {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  mockResponses.set('developer_sessions:single', {
    data: {
      id: 'session-id',
      api_key_id: 'dev-api-key',
      mfa_verified_at: opts.mfaVerifiedAt === undefined ? null : opts.mfaVerifiedAt,
      expires_at: future,
    },
    error: null,
  });
}
/** A recent verification timestamp marks the session elevated (within 15 min). */
const elevatedNow = () => new Date().toISOString();

describe('GET /developers/security/refresh-key — step-up gating', () => {
  it('redirects to login when there is no session', async () => {
    const res = await fetch(`${baseUrl}/developers/security/refresh-key`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/developers/login');
  });

  it('redirects to enroll-mfa when the developer has no MFA', async () => {
    setupSession({ mfaVerifiedAt: elevatedNow() });
    mockResponses.set('api_keys:single', { data: { mfa_enrolled_at: null }, error: null });
    const res = await fetch(`${baseUrl}/developers/security/refresh-key`, {
      headers: { Cookie: sessionCookie() }, redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/developers\/security\/enroll-mfa\?return=/);
  });

  it('redirects to step-up when MFA is enrolled but the session is stale', async () => {
    setupSession({ mfaVerifiedAt: null });
    mockResponses.set('api_keys:single', { data: { mfa_enrolled_at: '2026-05-18T00:00:00Z' }, error: null });
    const res = await fetch(`${baseUrl}/developers/security/refresh-key`, {
      headers: { Cookie: sessionCookie() }, redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/developers\/security\/step-up\?return=/);
  });

  it('renders the confirm page for an elevated, enrolled developer', async () => {
    setupSession({ mfaVerifiedAt: elevatedNow() });
    mockResponses.set('api_keys:single', { data: { mfa_enrolled_at: '2026-05-18T00:00:00Z' }, error: null });
    const res = await fetch(`${baseUrl}/developers/security/refresh-key`, {
      headers: { Cookie: sessionCookie() }, redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Refresh API key');
    expect(html).toContain('immediately invalidates your current key');
    expect(html).toContain('action="/developers/security/refresh-key"');
    expect(html).toContain('name="_csrf"');
  });
});

describe('POST /developers/security/refresh-key — rotation', () => {
  it('rejects without a CSRF token and does not rotate', async () => {
    setupSession({ mfaVerifiedAt: elevatedNow() });
    mockResponses.set('api_keys:single', { data: { mfa_enrolled_at: '2026-05-18T00:00:00Z' }, error: null });
    const res = await fetch(`${baseUrl}/developers/security/refresh-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sessionCookie() },
      body: '', redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(updatedRows.get('api_keys') || []).toHaveLength(0);
  });

  it('rotates the key in place (new hash + nc_ prefix) and shows it once', async () => {
    setupSession({ mfaVerifiedAt: elevatedNow() });
    mockResponses.set('api_keys:single', { data: { mfa_enrolled_at: '2026-05-18T00:00:00Z' }, error: null });

    // GET the confirm page to mint a CSRF token.
    const getRes = await fetch(`${baseUrl}/developers/security/refresh-key`, {
      headers: { Cookie: sessionCookie() }, redirect: 'manual',
    });
    const csrfToken = parseSetCookies(getRes).get('nc_dev_csrf') || '';
    expect(csrfToken).not.toBe('');

    const body = new URLSearchParams({ _csrf: csrfToken });
    const res = await fetch(`${baseUrl}/developers/security/refresh-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `${sessionCookie()}; nc_dev_csrf=${csrfToken}`,
      },
      body: body.toString(), redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Your new API key');
    expect(html).toContain('no longer works');

    // The api_keys row was updated in place with a fresh hash + nc_ prefix.
    const updates = updatedRows.get('api_keys') || [];
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const update = updates[updates.length - 1]!;
    expect(update.key_hash as string).toMatch(/^[a-f0-9]{64}$/);
    expect((update.key_prefix as string).startsWith('nc_')).toBe(true);
    // The raw key is never persisted.
    expect('key_hash' in update && !('key' in update)).toBe(true);
  });
});
