/**
 * Developer portal registration — integration test for the full flow.
 *
 * Spins the real Express app with Supabase + email mocked, drives the
 * sign-up → OTP-send → verify → dashboard handshake via HTTP, and
 * asserts the right rows would have been created, the cookies set, the
 * pages rendered with the right shape.
 *
 * Per docs/onboarding-redesign.md §4 (canonical onboarding path).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

const mockResponses = vi.hoisted(() => {
  return new Map<string, { data: unknown; error: unknown; count?: number }>();
});

/** Capture what got inserted into which table — lets us assert provisioning. */
const insertedRows = vi.hoisted(() => {
  return new Map<string, Array<Record<string, unknown>>>();
});

const mockEmail = vi.hoisted(() => {
  return { lastSent: null as null | { to: string; subject: string; html: string } };
});

vi.mock('../src/lib/supabase.js', () => {
  function createQueryChain(table: string) {
    const chain: Record<string, unknown> = {};
    let pendingWrite: Record<string, unknown> | null = null;
    let isSingleShape = false; // maybeSingle() / single() switch the default response shape

    const passthrough = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in', 'contains',
      'update', 'delete',
    ];
    for (const method of passthrough) {
      chain[method] = () => chain;
    }

    chain.maybeSingle = () => {
      isSingleShape = true;
      return chain;
    };
    chain.single = () => {
      isSingleShape = true;
      return chain;
    };

    chain.insert = (row: Record<string, unknown>) => {
      const list = insertedRows.get(table) || [];
      list.push(row);
      insertedRows.set(table, list);
      pendingWrite = row;
      return chain;
    };

    chain.upsert = (row: Record<string, unknown>) => {
      // Mirror insert tracking — upsert is "insert-or-update", so for the
      // test's purpose of "did the row get written?" it's the same answer.
      const list = insertedRows.get(table) || [];
      list.push(row);
      insertedRows.set(table, list);
      pendingWrite = row;
      return chain;
    };

    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      const override = mockResponses.get(table);
      if (override) {
        return Promise.resolve(override).then(resolve, reject);
      }
      // Default response: if a write was queued, echo it back with a
      // synthetic id; otherwise return the empty shape appropriate to
      // whether maybeSingle/single was chained.
      if (pendingWrite) {
        const synthetic = { id: 'mock-id-' + table, ...pendingWrite };
        pendingWrite = null;
        return Promise.resolve({ data: synthetic, error: null }).then(resolve, reject);
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
  mockEmail.lastSent = null;
});

// ---------------------------------------------------------------------------
// GET /developers/sign-up
// ---------------------------------------------------------------------------

describe('GET /developers/sign-up', () => {
  it('renders the registration form with required fields', async () => {
    const res = await fetch(`${baseUrl}/developers/sign-up`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();

    // Every required field appears as an input
    expect(html).toMatch(/name="email"/);
    expect(html).toMatch(/name="app_name"/);
    expect(html).toMatch(/name="tagline"/);
    expect(html).toMatch(/name="description"/);
    expect(html).toMatch(/name="app_url"/);
    expect(html).toMatch(/name="what_youre_building"/);
    expect(html).toMatch(/name="verification_process"/);

    // CSRF hidden input is rendered
    expect(html).toMatch(/name="_csrf"/);

    // robots meta blocks indexing
    expect(html).toMatch(/<meta name="robots" content="noindex,nofollow">/);
  });

  it('sets a CSRF cookie on the response', async () => {
    const res = await fetch(`${baseUrl}/developers/sign-up`);
    const cookieHeader = res.headers.get('set-cookie') || '';
    expect(cookieHeader).toContain('nc_dev_csrf=');
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('SameSite=Lax');
  });

  it('self-hosts fonts (no Google Fonts <link>)', async () => {
    const res = await fetch(`${baseUrl}/developers/sign-up`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('@font-face');
    expect(html).toContain('/fonts/dm-sans-latin.woff2');
    expect(html).toContain('rel="preload"');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
  });
});

// ---------------------------------------------------------------------------
// POST /developers/register
// ---------------------------------------------------------------------------

describe('POST /developers/register', () => {
  it('rejects when CSRF cookie + form field do not match', async () => {
    const body = new URLSearchParams({
      _csrf: 'wrong-value',
      email: 'dev@example.com',
      app_name: 'TestApp',
      tagline: 'A test app',
      description: 'Description',
      app_url: 'https://test.example',
      what_youre_building: 'Things',
      verification_process: 'We check things',
    });

    const res = await fetch(`${baseUrl}/developers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    });

    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toMatch(/session expired/i);
  });

  it('redirects to verify on successful registration and sends an OTP email', async () => {
    // Step 1: GET sign-up to receive a CSRF cookie + token
    const getRes = await fetch(`${baseUrl}/developers/sign-up`);
    const setCookie = getRes.headers.get('set-cookie') || '';
    const csrfMatch = setCookie.match(/nc_dev_csrf=([a-f0-9]+)/);
    expect(csrfMatch).toBeTruthy();
    const csrfToken = csrfMatch![1];

    // Step 2: POST register with the matching token + cookie
    const body = new URLSearchParams({
      _csrf: csrfToken!,
      email: 'dev@example.com',
      app_name: 'TestApp',
      tagline: 'A short tagline',
      description: 'A longer description that satisfies the validator.',
      app_url: 'https://test.example',
      what_youre_building: 'Something cool',
      verification_process: 'We loop the org owner via email.',
    });

    const res = await fetch(`${baseUrl}/developers/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `nc_dev_csrf=${csrfToken}`,
      },
      body: body.toString(),
      redirect: 'manual',
    });

    expect(res.status).toBe(303);
    const location = res.headers.get('location');
    expect(location).toMatch(/^\/developers\/verify\?email=dev%40example\.com$/);

    // Pending registration upserted
    const pending = insertedRows.get('pending_registrations') || [];
    expect(pending.length).toBeGreaterThanOrEqual(1);

    // OTP issued (inserted into developer_otps)
    const otps = insertedRows.get('developer_otps') || [];
    expect(otps.length).toBeGreaterThanOrEqual(1);

    // OTP email sent
    expect(mockEmail.lastSent).toBeTruthy();
    expect(mockEmail.lastSent!.to).toBe('dev@example.com');
    expect(mockEmail.lastSent!.subject).toMatch(/verification code/i);
  });

  it('re-renders the form with an error on bad email', async () => {
    const getRes = await fetch(`${baseUrl}/developers/sign-up`);
    const setCookie = getRes.headers.get('set-cookie') || '';
    const csrfToken = (setCookie.match(/nc_dev_csrf=([a-f0-9]+)/) || [])[1]!;

    const body = new URLSearchParams({
      _csrf: csrfToken,
      email: 'not-an-email',
      app_name: 'TestApp',
      tagline: 't',
      description: 'd',
      app_url: 'https://x.example',
      what_youre_building: 'a',
      verification_process: 'b',
    });

    const res = await fetch(`${baseUrl}/developers/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `nc_dev_csrf=${csrfToken}`,
      },
      body: body.toString(),
      redirect: 'manual',
    });

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/nc-error/);
  });

  it('rejects when required fields are missing', async () => {
    const getRes = await fetch(`${baseUrl}/developers/sign-up`);
    const setCookie = getRes.headers.get('set-cookie') || '';
    const csrfToken = (setCookie.match(/nc_dev_csrf=([a-f0-9]+)/) || [])[1]!;

    const body = new URLSearchParams({
      _csrf: csrfToken,
      email: 'dev@example.com',
      // app_name omitted
    });

    const res = await fetch(`${baseUrl}/developers/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `nc_dev_csrf=${csrfToken}`,
      },
      body: body.toString(),
      redirect: 'manual',
    });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /developers/verify
// ---------------------------------------------------------------------------

describe('GET /developers/verify', () => {
  it('renders the OTP entry form with the email pre-populated', async () => {
    const res = await fetch(`${baseUrl}/developers/verify?email=dev@example.com`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toMatch(/name="code"/);
    expect(html).toMatch(/value="dev@example.com"/);
    expect(html).toMatch(/inputmode="numeric"/);
    expect(html).toMatch(/autocomplete="one-time-code"/);
  });
});

// ---------------------------------------------------------------------------
// GET /developers — dispatch
// ---------------------------------------------------------------------------

describe('GET /developers', () => {
  it('redirects unauthenticated requests to sign-up', async () => {
    const res = await fetch(`${baseUrl}/developers`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/developers/sign-up');
  });
});

// ---------------------------------------------------------------------------
// GET /developers/dashboard — requires session
// ---------------------------------------------------------------------------

describe('GET /developers/dashboard', () => {
  it('redirects to sign-up when no session cookie is present', async () => {
    const res = await fetch(`${baseUrl}/developers/dashboard`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/developers/sign-up');
  });

  it('redirects to sign-up when the cookie is invalid', async () => {
    const res = await fetch(`${baseUrl}/developers/dashboard`, {
      headers: { 'Cookie': 'nc_dev_session=' + 'a'.repeat(64) },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/developers/sign-up');
  });
});

// ---------------------------------------------------------------------------
// Dashboard "What's next" — actionable state
// ---------------------------------------------------------------------------

describe('Dashboard — What\'s next card', () => {
  const RAW_TOKEN = 'd'.repeat(64);

  /** Set up the minimum mock surface to render the dashboard. */
  function setupAuthed(opts: { mfaEnrolled: boolean }) {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockResponses.set('developer_sessions', {
      data: {
        id: 'session-id',
        api_key_id: 'dev-api-key',
        mfa_verified_at: null,
        expires_at: future,
      },
      error: null,
    });
    mockResponses.set('api_keys', {
      data: {
        id: 'dev-api-key',
        name: 'Test App',
        key_prefix: 'nc_abc123',
        contributor_tier: 'service',
        status: 'active',
        activated_at: '2026-05-19T00:00:00Z', // active key
        contributor_profile_id: null, // no profile loaded — keeps mock surface small
        contact_email: 'dev@example.com',
        mfa_enrolled_at: opts.mfaEnrolled ? '2026-05-19T00:00:00Z' : null,
      },
      error: null,
    });
  }

  it('renders an "Enable MFA" CTA when the developer has not enrolled MFA', async () => {
    setupAuthed({ mfaEnrolled: false });
    const res = await fetch(`${baseUrl}/developers/dashboard`, {
      headers: { Cookie: `nc_dev_session=${RAW_TOKEN}` },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Enable MFA');
    expect(html).toContain('/developers/security/enroll-mfa');
    // Stale placeholder from PR 4b must not appear
    expect(html).not.toContain('ships in the next release');
  });

  it('renders an "MFA is enabled" confirmation when the developer has enrolled', async () => {
    setupAuthed({ mfaEnrolled: true });
    const res = await fetch(`${baseUrl}/developers/dashboard`, {
      headers: { Cookie: `nc_dev_session=${RAW_TOKEN}` },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // MFA now lives in the Credentials & security section (moved out of
    // "What's next"); enrolled state shows "MFA is on" with no enroll CTA.
    expect(html).toContain('Multi-factor authentication');
    expect(html).toContain('MFA is <strong>on</strong>');
    // The CTA must not be present in the enrolled state — that would be
    // a dead end for the user.
    expect(html).not.toContain('Enable MFA');
  });
});

// ---------------------------------------------------------------------------
// Dashboard — collective vs publishing scope
// ---------------------------------------------------------------------------
//
// Regression for the bug where the dashboard labeled an arbitrary scoped org
// (the first api_key_organization_links row) as "your collective." The
// collective is the org named "<App> Community"; everything else is publishing
// scope, surfaced as a count.

describe('Dashboard — collective vs publishing scope', () => {
  const RAW_TOKEN = 'd'.repeat(64);

  function setupAuthed() {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockResponses.set('developer_sessions', {
      data: { id: 'session-id', api_key_id: 'dev-api-key', mfa_verified_at: null, expires_at: future },
      error: null,
    });
    mockResponses.set('api_keys', {
      data: {
        id: 'dev-api-key', name: 'Merrie', key_prefix: 'nc_abc123',
        contributor_tier: 'service', status: 'active', activated_at: '2026-05-19T00:00:00Z',
        contributor_profile_id: null, contact_email: 'dev@example.com', mfa_enrolled_at: null,
      },
      error: null,
    });
  }

  it('shows "Publishing for N organizations" (not a collective) when no org is named "<App> Community"', async () => {
    setupAuthed();
    mockResponses.set('api_key_organization_links', {
      data: [{ organization_id: 'org1' }, { organization_id: 'org2' }],
      error: null,
    });
    mockResponses.set('organizations', {
      data: [
        { id: 'org1', name: 'Pong around Philly', slug: 'pong-around-philly' },
        { id: 'org2', name: 'Another Group', slug: 'another-group' },
      ],
      error: null,
    });
    const res = await fetch(`${baseUrl}/developers/dashboard`, {
      headers: { Cookie: `nc_dev_session=${RAW_TOKEN}` }, redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Publishing for 2 organizations');
    // The bug: an arbitrary scoped org must NOT be presented as the collective.
    expect(html).not.toContain('Your collective');
    expect(html).not.toContain('Pong around Philly');
  });

  it('shows the collective when a linked org is named "<App> Community"', async () => {
    setupAuthed();
    mockResponses.set('api_key_organization_links', {
      data: [{ organization_id: 'org1' }, { organization_id: 'col' }],
      error: null,
    });
    mockResponses.set('organizations', {
      data: [
        { id: 'org1', name: 'Pong around Philly', slug: 'pong-around-philly' },
        { id: 'col', name: 'Merrie Community', slug: 'merrie-community' },
      ],
      error: null,
    });
    const res = await fetch(`${baseUrl}/developers/dashboard`, {
      headers: { Cookie: `nc_dev_session=${RAW_TOKEN}` }, redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Your collective: Merrie Community');
    // The publishing org must not be mislabeled as the collective.
    expect(html).not.toContain('Your collective: Pong around Philly');
  });
});
