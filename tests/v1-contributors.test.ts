/**
 * v1 Contributors — Integration Tests
 *
 * Spins up the real Express app with Supabase mocked, makes HTTP calls
 * to /api/v1/contributors and /api/v1/contributors/:idOrSlug, and asserts
 * the shape matches ContributorProfile in public/openapi.json.
 *
 * These guard the public read surface of the developer portal's foundation
 * (PR 1 of docs/onboarding-redesign.md §12).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

const mockResponses = vi.hoisted(() => {
  return new Map<string, { data: unknown; error: unknown; count?: number }>();
});

const mockAuthUser = vi.hoisted(() => {
  return { value: { data: { user: null }, error: { message: 'invalid token' } } as unknown };
});

vi.mock('../src/lib/supabase.js', () => {
  function createQueryChain(table: string) {
    const chain: Record<string, unknown> = {};
    const chainMethods = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in', 'contains',
      'insert', 'update', 'delete', 'upsert', 'maybeSingle', 'single',
    ];
    for (const method of chainMethods) {
      chain[method] = () => chain;
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
      auth: { getUser: () => Promise.resolve(mockAuthUser.value) },
    },
    createUserClient: () => ({
      from: (table: string) => createQueryChain(table),
    }),
  };
});

import { createApp } from '../src/app.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    slug: 'merrie',
    name: 'Merrie',
    tagline: 'Publish what your group is up to',
    description: 'Merrie is a publishing tool for community groups.',
    who_its_for: 'Community organizers',
    app_url: 'https://merrie.co',
    logo_url: 'https://r2.example/merrie-logo.png',
    category: 'publishing',
    created_at: '2026-05-18T12:00:00.000Z',
    updated_at: '2026-05-18T12:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

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
});

// ---------------------------------------------------------------------------
// GET /api/v1/contributors
// ---------------------------------------------------------------------------

describe('GET /api/v1/contributors', () => {
  it('returns paginated active contributor profiles in spec shape', async () => {
    mockResponses.set('contributor_profiles', {
      data: [
        makeProfile(),
        makeProfile({
          id: '22222222-2222-2222-2222-222222222222',
          slug: 'go-there',
          name: 'Go There',
          app_url: 'https://gothere.bike',
          category: 'cycling',
        }),
      ],
      error: null,
      count: 2,
    });

    const res = await fetch(`${baseUrl}/api/v1/contributors`);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Meta block
    expect(body.meta).toEqual({
      total: 2,
      limit: 50,
      offset: 0,
      spec: 'neighborhood-api-v0.2',
      license: 'CC-BY-4.0',
    });

    // Contributors array
    expect(Array.isArray(body.contributors)).toBe(true);
    expect(body.contributors).toHaveLength(2);

    // Public shape: matches ContributorProfile schema, no internal fields leak
    const c = body.contributors[0];
    expect(c).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      slug: 'merrie',
      name: 'Merrie',
      tagline: 'Publish what your group is up to',
      description: 'Merrie is a publishing tool for community groups.',
      who_its_for: 'Community organizers',
      app_url: 'https://merrie.co',
      logo_url: 'https://r2.example/merrie-logo.png',
      category: 'publishing',
      created_at: '2026-05-18T12:00:00.000Z',
      updated_at: '2026-05-18T12:00:00.000Z',
    });

    // Defense: internal fields should never surface on the public read
    expect(c).not.toHaveProperty('status');
    expect(c).not.toHaveProperty('what_youre_building');
    expect(c).not.toHaveProperty('verification_process');
    expect(c).not.toHaveProperty('mfa_secret_encrypted');
  });

  it('returns empty result when no active profiles exist', async () => {
    mockResponses.set('contributor_profiles', { data: [], error: null, count: 0 });

    const res = await fetch(`${baseUrl}/api/v1/contributors`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.meta.total).toBe(0);
    expect(body.contributors).toEqual([]);
  });

  it('accepts category and q filters without erroring', async () => {
    mockResponses.set('contributor_profiles', { data: [], error: null, count: 0 });

    const res = await fetch(`${baseUrl}/api/v1/contributors?category=publishing&q=community&limit=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.limit).toBe(10);
  });

  it('rejects out-of-range limit', async () => {
    const res = await fetch(`${baseUrl}/api/v1/contributors?limit=500`);
    expect(res.status).toBe(400);
  });

  it('returns 500 on DB error with sanitized message', async () => {
    mockResponses.set('contributor_profiles', {
      data: null,
      error: { message: 'internal pg error with secrets' },
      count: 0,
    });

    const res = await fetch(`${baseUrl}/api/v1/contributors`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('SERVER_ERROR');
    // The internal error message must not leak
    expect(JSON.stringify(body)).not.toContain('internal pg error');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/contributors/:idOrSlug
// ---------------------------------------------------------------------------

describe('GET /api/v1/contributors/:idOrSlug', () => {
  it('returns a single profile when looked up by slug', async () => {
    mockResponses.set('contributor_profiles', {
      data: makeProfile(),
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/contributors/merrie`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.contributor).toBeDefined();
    expect(body.contributor.slug).toBe('merrie');
    expect(body.contributor.name).toBe('Merrie');
  });

  it('returns a single profile when looked up by UUID', async () => {
    mockResponses.set('contributor_profiles', {
      data: makeProfile(),
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/contributors/11111111-1111-1111-1111-111111111111`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contributor.id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('returns 404 when the slug does not match an active profile', async () => {
    mockResponses.set('contributor_profiles', { data: null, error: null });

    const res = await fetch(`${baseUrl}/api/v1/contributors/no-such-slug`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns a profile with nullable fields when those columns are null', async () => {
    mockResponses.set('contributor_profiles', {
      data: makeProfile({
        tagline: null,
        description: null,
        who_its_for: null,
        logo_url: null,
        category: null,
      }),
      error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/contributors/merrie`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contributor.tagline).toBeNull();
    expect(body.contributor.description).toBeNull();
    expect(body.contributor.who_its_for).toBeNull();
    expect(body.contributor.logo_url).toBeNull();
    expect(body.contributor.category).toBeNull();
  });

  it('sets a Cache-Control header for the single-profile lookup', async () => {
    mockResponses.set('contributor_profiles', { data: makeProfile(), error: null });

    const res = await fetch(`${baseUrl}/api/v1/contributors/merrie`);
    expect(res.headers.get('cache-control')).toContain('public');
    expect(res.headers.get('cache-control')).toContain('max-age=300');
  });
});
