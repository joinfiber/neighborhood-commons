/**
 * Audit follow-ups — behavior guards.
 *
 * M-2: a present-but-invalid X-API-Key is signaled (X-API-Key-Status: invalid),
 *      not silently dropped.
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
      'insert', 'update', 'delete', 'upsert', 'maybeSingle', 'single', 'contains',
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

import { createApp } from '../src/app.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => mockResponses.clear());

describe('M-2 — present-but-invalid API key is signaled, not silently dropped', () => {
  it('sets X-API-Key-Status: invalid on a public read when the key does not resolve', async () => {
    mockResponses.set('api_keys', { data: null, error: null }); // key does not resolve
    mockResponses.set('organizations', { data: [], error: null, count: 0 });
    mockResponses.set('organization_verifications', { data: [], error: null });

    const res = await fetch(`${baseUrl}/api/v1/organizations`, {
      headers: { 'X-API-Key': 'nc_revoked_or_typo_key' },
    });

    expect(res.status).toBe(200); // reads stay public
    expect(res.headers.get('x-api-key-status')).toBe('invalid');
  });
});
