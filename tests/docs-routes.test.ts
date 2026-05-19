/**
 * Public docs routes — /docs/:slug renders allowlisted markdown.
 *
 * Smoke-tests the route against real files in /docs (no mock — the
 * docs are part of the repo and the test asserts the actual rendering).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';

// supabase + email aren't touched by /docs/* but the app boots them.
vi.mock('../src/lib/supabase.js', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        limit: () => Promise.resolve({ data: [], error: null }),
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          single: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }),
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: { message: 'no auth' } }) },
  },
  createUserClient: () => ({ from: () => ({ select: () => ({}) }) }),
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

describe('GET /docs/:slug', () => {
  it('renders four-roles as HTML', async () => {
    const res = await fetch(`${baseUrl}/docs/four-roles`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    // Title in <title> + the eyebrow + at least some prose
    expect(html).toContain('Neighborhood Commons');
    expect(html).toContain('class="nc-doc-prose"');
    // Marked rendered the markdown — should contain <h1>/<h2> tags
    expect(html).toMatch(/<h[12]/);
    // Source link at the bottom
    expect(html).toContain('docs/four-roles.md');
  });

  it('renders quickstart', async () => {
    const res = await fetch(`${baseUrl}/docs/quickstart`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Quickstart');
  });

  it('renders the docs index at /docs', async () => {
    const res = await fetch(`${baseUrl}/docs`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Docs.');
    expect(html).toContain('/docs/four-roles');
    expect(html).toContain('/docs/quickstart');
  });

  it('returns 404 with a helpful body for a slug not on the allowlist', async () => {
    const res = await fetch(`${baseUrl}/docs/onboarding-redesign`);
    expect(res.status).toBe(404);
    const html = await res.text();
    // Lists the published docs
    expect(html).toContain('four-roles');
    expect(html).toContain("isn't published");
  });

  it('returns 404 for a truly bogus slug', async () => {
    const res = await fetch(`${baseUrl}/docs/this-does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('strips a trailing .md if a user types the file extension', async () => {
    const res = await fetch(`${baseUrl}/docs/four-roles.md`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<h[12]/);
  });
});
