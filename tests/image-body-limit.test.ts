/**
 * Image-upload body limit (F7 regression).
 *
 * Image routes (.../image, .../logo, .../cover) declare a 12MB express.json so
 * base64 payloads fit (Spec: "Max 12MB raw"). The global 5MB express.json runs
 * first and sets req._body, which made the per-route 12MB override dead code —
 * 6–12MB JSON uploads were wrongly 413'd at 5MB. app.ts now skips the global
 * parser for image-upload paths so the override applies.
 *
 * These tests POST a ~6MB JSON body: an image route must NOT 413 (the override
 * parses it), while a normal write route MUST still 413 (global cap intact).
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
const EVENT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ~6MB JSON body: between the 5MB global cap and the 12MB image-route cap.
const SIX_MB_IMAGE = 'data:image/png;base64,' + 'A'.repeat(6 * 1024 * 1024);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  mockResponses.clear();
  // An activated, non-admin service key so requireServiceApiKey (which runs
  // before the per-route body parser) lets the request reach the image route.
  mockResponses.set('api_keys', {
    data: { id: 'key-1', contributor_tier: 'service', is_admin: false, tenant_account_id: null, activated_at: '2026-01-01T00:00:00Z', raw_key_hash: '' },
    error: null,
  });
});

describe('image-upload body limit (F7)', () => {
  it('does NOT 413 a ~6MB JSON body on an image route (12MB override applies)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/service/events/${EVENT_ID}/image`, {
      method: 'POST',
      headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: SIX_MB_IMAGE }),
    });
    // Whatever the handler decides downstream (e.g. 403 NOT_LINKED), the body
    // must have parsed — it must not be rejected as too large.
    expect(res.status).not.toBe(413);
  });

  it('still 413s a ~6MB JSON body on a normal write route (global 5MB cap intact)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/service/organizations`, {
      method: 'POST',
      headers: { 'X-API-Key': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Org', blob: SIX_MB_IMAGE }),
    });
    expect(res.status).toBe(413);
  });
});
