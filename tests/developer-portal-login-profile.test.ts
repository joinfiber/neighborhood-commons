/**
 * Developer portal — login + profile editing (PR 3).
 *
 * Integration test for the magic-link login flow and the profile-edit
 * routes. Same mocking pattern as developer-portal-registration.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

const mockResponses = vi.hoisted(() => {
  return new Map<string, { data: unknown; error: unknown; count?: number }>();
});

const insertedRows = vi.hoisted(() => {
  return new Map<string, Array<Record<string, unknown>>>();
});

const updatedRows = vi.hoisted(() => {
  return new Map<string, Array<Record<string, unknown>>>();
});

const mockEmail = vi.hoisted(() => {
  return { lastSent: null as null | { to: string; subject: string; html: string } };
});

vi.mock('../src/lib/supabase.js', () => {
  function createQueryChain(table: string) {
    const chain: Record<string, unknown> = {};
    let pendingWrite: Record<string, unknown> | null = null;
    let pendingUpdate: Record<string, unknown> | null = null;
    let isSingleShape = false;

    const passthrough = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in', 'contains', 'delete',
    ];
    for (const method of passthrough) {
      chain[method] = () => chain;
    }

    chain.maybeSingle = () => { isSingleShape = true; return chain; };
    chain.single = () => { isSingleShape = true; return chain; };

    chain.insert = (row: Record<string, unknown>) => {
      const list = insertedRows.get(table) || [];
      list.push(row);
      insertedRows.set(table, list);
      pendingWrite = row;
      return chain;
    };

    chain.upsert = (row: Record<string, unknown>) => {
      const list = insertedRows.get(table) || [];
      list.push(row);
      insertedRows.set(table, list);
      pendingWrite = row;
      return chain;
    };

    chain.update = (row: Record<string, unknown>) => {
      const list = updatedRows.get(table) || [];
      list.push(row);
      updatedRows.set(table, list);
      pendingUpdate = row;
      return chain;
    };

    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      const override = mockResponses.get(table);
      if (override) {
        return Promise.resolve(override).then(resolve, reject);
      }
      if (pendingWrite) {
        const synthetic = { id: 'mock-id-' + table, ...pendingWrite };
        pendingWrite = null;
        return Promise.resolve({ data: synthetic, error: null }).then(resolve, reject);
      }
      if (pendingUpdate) {
        pendingUpdate = null;
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      const empty = isSingleShape
        ? { data: null, error: null }
        : { data: [], error: null, count: 0 };
      return Promise.resolve(empty).then(resolve, reject);
    };
    return chain;
  }
  return {
    supabaseAdmin: {
      from: (table: string) => createQueryChain(table),
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: { message: 'no auth' } }) },
    },
    createUserClient: () => ({
      from: (table: string) => createQueryChain(table),
    }),
  };
});

vi.mock('../src/lib/email.js', () => {
  return {
    sendEmail: vi.fn(async (to: string, subject: string, html: string) => {
      mockEmail.lastSent = { to, subject, html };
    }),
  };
});

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

afterAll(() => {
  return new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
});

beforeEach(() => {
  mockResponses.clear();
  insertedRows.clear();
  updatedRows.clear();
  mockEmail.lastSent = null;
});

/** Parse a Set-Cookie header into a name→value map. */
function parseSetCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  const raw = res.headers.get('set-cookie');
  if (!raw) return out;
  // Multiple cookies may be combined with commas; split on the pattern
  // "name=" preceded by ", " (rough but workable for the tests' single-set-cookie case).
  for (const part of raw.split(/, (?=[a-zA-Z_]+=)/)) {
    const [pair] = part.split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// GET /developers/login
// ---------------------------------------------------------------------------

describe('GET /developers/login', () => {
  it('renders the login form with an email field', async () => {
    const res = await fetch(`${baseUrl}/developers/login`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sign in.');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="_csrf"');
  });

  it('renders the "check your email" confirmation when ?sent=1', async () => {
    const res = await fetch(`${baseUrl}/developers/login?sent=1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Check your email.');
    expect(html).toContain('Send again');
  });
});

// ---------------------------------------------------------------------------
// POST /developers/login
// ---------------------------------------------------------------------------

describe('POST /developers/login', () => {
  async function getCsrfPair(): Promise<{ cookie: string; token: string }> {
    const res = await fetch(`${baseUrl}/developers/login`);
    const cookies = parseSetCookies(res);
    const token = cookies.get('nc_dev_csrf') || '';
    const html = await res.text();
    const match = html.match(/name="_csrf" value="([^"]+)"/);
    return { cookie: `nc_dev_csrf=${token}`, token: match?.[1] || '' };
  }

  it('issues a magic link when the email has an active api_key', async () => {
    const { cookie, token } = await getCsrfPair();
    // Stub the api_keys lookup to return a key for this email.
    mockResponses.set('api_keys', { data: { id: 'key-1' }, error: null });

    const body = new URLSearchParams({ _csrf: token, email: 'dev@example.com' });
    const res = await fetch(`${baseUrl}/developers/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: body.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/developers/login?sent=1');

    // Magic link token inserted into magic_login_tokens
    const tokens = insertedRows.get('magic_login_tokens') || [];
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(tokens[0]?.email).toBe('dev@example.com');

    // Email sent
    expect(mockEmail.lastSent).not.toBeNull();
    expect(mockEmail.lastSent?.to).toBe('dev@example.com');
    expect(mockEmail.lastSent?.subject).toMatch(/sign in/i);
  });

  it('does not leak whether an unknown email has an account', async () => {
    const { cookie, token } = await getCsrfPair();
    // No mockResponse for api_keys — default is empty result.
    const body = new URLSearchParams({ _csrf: token, email: 'unknown@example.com' });
    const res = await fetch(`${baseUrl}/developers/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: body.toString(),
      redirect: 'manual',
    });
    // Same response shape as the happy path — no enumeration.
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/developers/login?sent=1');
    // No email sent, no token issued.
    expect(mockEmail.lastSent).toBeNull();
    expect(insertedRows.get('magic_login_tokens') ?? []).toHaveLength(0);
  });

  it('rejects an invalid email format with a 400', async () => {
    const { cookie, token } = await getCsrfPair();
    const body = new URLSearchParams({ _csrf: token, email: 'not-an-email' });
    const res = await fetch(`${baseUrl}/developers/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: body.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('valid email');
  });

  it('rejects a request missing CSRF with 403', async () => {
    const body = new URLSearchParams({ email: 'dev@example.com' });
    const res = await fetch(`${baseUrl}/developers/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /developers/login/verify
// ---------------------------------------------------------------------------

describe('GET /developers/login/verify', () => {
  it('redirects to login with error when token is missing', async () => {
    const res = await fetch(`${baseUrl}/developers/login/verify`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/developers/login?error=');
  });

  it('redirects to login with error when token is unknown', async () => {
    // Default mock returns null for the magic_login_tokens lookup.
    const fakeToken = 'a'.repeat(64);
    const res = await fetch(`${baseUrl}/developers/login/verify?token=${fakeToken}`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/developers/login?error=');
  });
});

// ---------------------------------------------------------------------------
// GET /developers/profile
// ---------------------------------------------------------------------------

describe('GET /developers/profile', () => {
  it('redirects to sign-up when no session is present', async () => {
    const res = await fetch(`${baseUrl}/developers/profile`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/developers/sign-up');
  });
});

// ---------------------------------------------------------------------------
// POST /developers/profile
// ---------------------------------------------------------------------------

describe('POST /developers/profile', () => {
  it('redirects to sign-up when no session is present', async () => {
    const body = new URLSearchParams({ _csrf: 'x', name: 'X' });
    const res = await fetch(`${baseUrl}/developers/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/developers/sign-up');
  });
});
