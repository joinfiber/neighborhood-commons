/**
 * Logo upload — POST /developers/profile/logo + /remove.
 *
 * Drives the full route through the multer multipart parser and asserts:
 *   - the magic-byte gate rejects garbage bytes
 *   - a real PNG passes through Sharp re-encoding + R2 upload (mocked)
 *   - the contributor_profiles.logo_url column is updated
 *   - the remove route clears logo_url and best-effort-deletes from R2
 *
 * Sharp runs for real against a hand-rolled tiny PNG — that's the only
 * way to actually exercise the magic-byte → Sharp → R2 pipeline as
 * deployed. R2 + email are mocked.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

const mockResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown; count?: number }>());
const insertedRows = vi.hoisted(() => new Map<string, Array<Record<string, unknown>>>());
const updatedRows = vi.hoisted(() => new Map<string, Array<Record<string, unknown>>>());

const r2Calls = vi.hoisted(() => ({
  uploads: [] as Array<{ key: string; bytes: number; contentType: string }>,
  deletes: [] as Array<{ key: string }>,
}));

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
    for (const method of passthrough) chain[method] = () => chain;

    chain.maybeSingle = () => { isSingleShape = true; return chain; };
    chain.single = () => { isSingleShape = true; return chain; };

    chain.insert = (row: Record<string, unknown>) => {
      const list = insertedRows.get(table) || [];
      list.push(row); insertedRows.set(table, list);
      pendingWrite = row; return chain;
    };
    chain.upsert = (row: Record<string, unknown>) => {
      const list = insertedRows.get(table) || [];
      list.push(row); insertedRows.set(table, list);
      pendingWrite = row; return chain;
    };
    chain.update = (row: Record<string, unknown>) => {
      const list = updatedRows.get(table) || [];
      list.push(row); updatedRows.set(table, list);
      pendingUpdate = row; return chain;
    };

    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      const shapeKey = isSingleShape ? `${table}:single` : `${table}:list`;
      const override = mockResponses.get(shapeKey) ?? mockResponses.get(table);
      if (override) return Promise.resolve(override).then(resolve, reject);
      if (pendingWrite) {
        const synthetic = { id: 'mock-id-' + table, ...pendingWrite };
        pendingWrite = null;
        return Promise.resolve({ data: synthetic, error: null }).then(resolve, reject);
      }
      if (pendingUpdate) {
        pendingUpdate = null;
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      const empty = isSingleShape ? { data: null, error: null } : { data: [], error: null, count: 0 };
      return Promise.resolve(empty).then(resolve, reject);
    };
    return chain;
  }
  return {
    supabaseAdmin: {
      from: (table: string) => createQueryChain(table),
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: { message: 'no auth' } }) },
    },
    createUserClient: () => ({ from: (table: string) => createQueryChain(table) }),
  };
});

vi.mock('../src/lib/cloudflare.js', () => ({
  uploadToR2: vi.fn(async (key: string, bytes: Uint8Array, contentType: string) => {
    r2Calls.uploads.push({ key, bytes: bytes.length, contentType });
    return { success: true, key };
  }),
  deleteFromR2: vi.fn(async (key: string) => {
    r2Calls.deletes.push({ key });
    return { success: true };
  }),
}));

vi.mock('../src/lib/email.js', () => ({
  sendEmail: vi.fn(async () => undefined),
}));

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
  return new Promise<void>((resolve) => { server?.close(() => resolve()); });
});

beforeEach(() => {
  mockResponses.clear();
  insertedRows.clear();
  updatedRows.clear();
  r2Calls.uploads = [];
  r2Calls.deletes = [];
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RAW_SESSION_TOKEN = 'e'.repeat(64);
const PROFILE_ID = '00000000-0000-0000-0000-000000000aaa';

function sessionCookie(): string {
  return `nc_dev_session=${RAW_SESSION_TOKEN}`;
}

/** A minimal valid 1x1 RGBA PNG. Magic bytes 89504e47, valid IHDR/IDAT/IEND.
 *  Sharp accepts and re-encodes this fine. */
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d49444154789c636000010000000500016ed95e2f0000000049454e44ae426082',
  'hex',
);

/** Bytes that look nothing like an image — the magic-byte gate should reject. */
const GARBAGE = Buffer.from('not an image at all, just text bytes', 'utf8');

function setupAuthed(opts: { logoUrl?: string | null } = {}) {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  mockResponses.set('developer_sessions:single', {
    data: {
      id: 'session-id',
      api_key_id: 'dev-api-key',
      mfa_verified_at: null,
      expires_at: future,
    },
    error: null,
  });
  // The route does two api_keys lookups: validateSession's last_seen bump
  // doesn't matter, but the profile loader reads contributor_profile_id.
  mockResponses.set('api_keys:single', {
    data: {
      id: 'dev-api-key',
      name: 'Test App',
      contributor_profile_id: PROFILE_ID,
      contact_email: 'dev@example.com',
      mfa_enrolled_at: null,
    },
    error: null,
  });
  mockResponses.set('contributor_profiles:single', {
    data: {
      id: PROFILE_ID,
      slug: 'test-app',
      name: 'Test App',
      tagline: 'A tagline',
      description: 'A description',
      who_its_for: null,
      app_url: 'https://test.example.com',
      logo_url: opts.logoUrl === undefined ? null : opts.logoUrl,
      category: null,
      status: 'active',
    },
    error: null,
  });
}

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

/** Hit GET /developers/profile to seed the CSRF cookie + read the token. */
async function getCsrfTokenFromProfile(): Promise<{ csrfToken: string; cookieHeader: string }> {
  const res = await fetch(`${baseUrl}/developers/profile`, {
    headers: { Cookie: sessionCookie() },
    redirect: 'manual',
  });
  const cookies = parseSetCookies(res);
  const csrfToken = cookies.get('nc_dev_csrf') || '';
  return { csrfToken, cookieHeader: `${sessionCookie()}; nc_dev_csrf=${csrfToken}` };
}

// ---------------------------------------------------------------------------
// GET /developers/profile renders the logo section
// ---------------------------------------------------------------------------

describe('GET /developers/profile — logo section', () => {
  it('renders an "Upload logo" prompt when there is no logo yet', async () => {
    setupAuthed({ logoUrl: null });
    const res = await fetch(`${baseUrl}/developers/profile`, {
      headers: { Cookie: sessionCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/developers/profile/logo"');
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('Upload logo');
    expect(html).toContain('No logo yet');
    // No URL-paste field anymore
    expect(html).not.toContain('name="logo_url"');
  });

  it('renders the current logo + a "Replace logo" / "Remove logo" affordance when one is set', async () => {
    setupAuthed({ logoUrl: 'https://cdn.example/logo.jpg' });
    const res = await fetch(`${baseUrl}/developers/profile`, {
      headers: { Cookie: sessionCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<img src="https://cdn.example/logo.jpg"');
    expect(html).toContain('Replace logo');
    expect(html).toContain('action="/developers/profile/logo/remove"');
  });
});

// ---------------------------------------------------------------------------
// POST /developers/profile/logo — upload
// ---------------------------------------------------------------------------

describe('POST /developers/profile/logo', () => {
  it('redirects to login if no session', async () => {
    const fd = new FormData();
    fd.append('_csrf', 'x');
    fd.append('logo', new Blob([TINY_PNG], { type: 'image/png' }), 'logo.png');
    const res = await fetch(`${baseUrl}/developers/profile/logo`, {
      method: 'POST',
      body: fd,
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/developers/sign-up');
  });

  it('redirects with an error when CSRF token is missing', async () => {
    setupAuthed();
    const fd = new FormData();
    // No _csrf field
    fd.append('logo', new Blob([TINY_PNG], { type: 'image/png' }), 'logo.png');
    const res = await fetch(`${baseUrl}/developers/profile/logo`, {
      method: 'POST',
      headers: { Cookie: sessionCookie() },
      body: fd,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/developers/profile?error=');
    // Nothing got persisted
    expect(updatedRows.get('contributor_profiles') || []).toHaveLength(0);
    expect(r2Calls.uploads).toHaveLength(0);
  });

  it('redirects with an error when no file is attached', async () => {
    setupAuthed();
    const { csrfToken, cookieHeader } = await getCsrfTokenFromProfile();

    const fd = new FormData();
    fd.append('_csrf', csrfToken);
    // No logo file

    const res = await fetch(`${baseUrl}/developers/profile/logo`, {
      method: 'POST',
      headers: { Cookie: cookieHeader },
      body: fd,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const loc = res.headers.get('location') || '';
    expect(loc).toContain('/developers/profile?error=');
    expect(decodeURIComponent(loc)).toMatch(/Pick a JPEG/i);
  });

  it('rejects garbage bytes via the magic-byte gate (no R2 write)', async () => {
    setupAuthed();
    const { csrfToken, cookieHeader } = await getCsrfTokenFromProfile();

    const fd = new FormData();
    fd.append('_csrf', csrfToken);
    fd.append('logo', new Blob([GARBAGE], { type: 'image/png' }), 'fake.png');

    const res = await fetch(`${baseUrl}/developers/profile/logo`, {
      method: 'POST',
      headers: { Cookie: cookieHeader },
      body: fd,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const loc = res.headers.get('location') || '';
    expect(decodeURIComponent(loc)).toMatch(/Unsupported image format/i);
    expect(r2Calls.uploads).toHaveLength(0);
    expect(updatedRows.get('contributor_profiles') || []).toHaveLength(0);
  });

  it('accepts a valid PNG, processes via Sharp, uploads to R2, persists logo_url', async () => {
    setupAuthed();
    const { csrfToken, cookieHeader } = await getCsrfTokenFromProfile();

    const fd = new FormData();
    fd.append('_csrf', csrfToken);
    fd.append('logo', new Blob([TINY_PNG], { type: 'image/png' }), 'logo.png');

    const res = await fetch(`${baseUrl}/developers/profile/logo`, {
      method: 'POST',
      headers: { Cookie: cookieHeader },
      body: fd,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/developers/profile?saved=1');

    // R2 upload happened with the right key + jpeg content type (Sharp re-encodes)
    expect(r2Calls.uploads).toHaveLength(1);
    expect(r2Calls.uploads[0].key).toBe(`contributor-profiles/${PROFILE_ID}/logo.jpg`);
    expect(r2Calls.uploads[0].contentType).toBe('image/jpeg');
    expect(r2Calls.uploads[0].bytes).toBeGreaterThan(0);

    // logo_url got written
    const profileUpdates = updatedRows.get('contributor_profiles') || [];
    expect(profileUpdates.length).toBeGreaterThanOrEqual(1);
    const persistedUrl = profileUpdates[profileUpdates.length - 1].logo_url as string;
    expect(typeof persistedUrl).toBe('string');
    // Slashes may be URL-encoded depending on whether R2_PUBLIC_URL is set
    // (direct URL) vs. the proxy-path fallback (which uses ?key= and encodes).
    expect(decodeURIComponent(persistedUrl)).toContain('contributor-profiles/');
  });
});

// ---------------------------------------------------------------------------
// POST /developers/profile/logo/remove
// ---------------------------------------------------------------------------

describe('POST /developers/profile/logo/remove', () => {
  it('clears logo_url and calls deleteFromR2', async () => {
    setupAuthed({ logoUrl: 'https://cdn.example/logo.jpg' });
    const { csrfToken, cookieHeader } = await getCsrfTokenFromProfile();

    const body = new URLSearchParams({ _csrf: csrfToken });
    const res = await fetch(`${baseUrl}/developers/profile/logo/remove`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeader,
      },
      body: body.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/developers/profile?saved=1');

    // logo_url cleared
    const profileUpdates = updatedRows.get('contributor_profiles') || [];
    expect(profileUpdates[profileUpdates.length - 1].logo_url).toBeNull();

    // R2 delete was called with the right key
    expect(r2Calls.deletes).toHaveLength(1);
    expect(r2Calls.deletes[0].key).toBe(`contributor-profiles/${PROFILE_ID}/logo.jpg`);
  });

  it('rejects missing CSRF', async () => {
    setupAuthed({ logoUrl: 'https://cdn.example/logo.jpg' });

    const res = await fetch(`${baseUrl}/developers/profile/logo/remove`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: sessionCookie(),
      },
      body: '',
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/developers/profile?error=');
    expect(updatedRows.get('contributor_profiles') || []).toHaveLength(0);
    expect(r2Calls.deletes).toHaveLength(0);
  });
});
