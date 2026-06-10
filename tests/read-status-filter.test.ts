/**
 * Read-path published-event filter (F4 + F20 regression).
 *
 * GET /lists/{idOrSlug}, GET /series, and GET /series/{idOrSlug} hydrate Event
 * objects (list items, series next_instance). Each MUST constrain that fetch to
 * status='published' — otherwise a draft/pending_review/suspended event leaks
 * its full public Event shape through these secondary read paths even though
 * GET /events/{id} 404s it.
 *
 * The shared supabase mock ignores PostgREST filters, so exclusion can't be
 * asserted by data; instead we record .eq() calls and assert the status filter
 * is applied to the `events` query on each path. Remove the filter and these
 * fail.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

const mockResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown; count?: number }>());
const eqCalls = vi.hoisted(() => [] as Array<{ table: string; col: string; val: unknown }>);

vi.mock('../src/lib/supabase.js', () => {
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const methods = [
      'select', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in',
      'insert', 'update', 'delete', 'upsert', 'maybeSingle', 'single',
    ];
    for (const m of methods) c[m] = () => c;
    c.eq = (col: string, val: unknown) => { eqCalls.push({ table, col, val }); return c; };
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

const EVENT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SERIES_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

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
  eqCalls.length = 0;
  mockResponses.set('organization_verifications', { data: [], count: 0, error: null });
  mockResponses.set('events', { data: [], error: null });
});

/** Did some `events` query constrain status to 'published'? */
function eventsStatusFiltered(): boolean {
  return eqCalls.some((c) => c.table === 'events' && c.col === 'status' && c.val === 'published');
}

const seriesRow = {
  id: SERIES_ID, slug: 'weekly-thing', name: 'Weekly Thing', description: null,
  cover_image_url: null, organizer_org_id: null, recurrence: 'weekly',
  recurrence_rule: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  organizations: null,
};

describe('GET /lists/{idOrSlug} hydrates only published events (F4)', () => {
  it('applies status=published to the list-item events fetch', async () => {
    mockResponses.set('lists', {
      data: { id: 'l1', slug: 'my-list', name: 'My List', description: null, curator_org_id: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      error: null,
    });
    mockResponses.set('list_items', {
      data: [{ id: 'li1', position: 1, event_id: EVENT_ID, organization_id: null, place_id: null, curator_note: null }],
      count: 1, error: null,
    });

    const res = await fetch(`${baseUrl}/api/v1/lists/my-list`);
    expect(res.status).toBe(200);
    expect(eventsStatusFiltered()).toBe(true);
  });
});

describe('GET /series next_instance is published-only (F20)', () => {
  it('applies status=published on the series list', async () => {
    mockResponses.set('event_series', { data: [seriesRow], count: 1, error: null });

    const res = await fetch(`${baseUrl}/api/v1/series`);
    expect(res.status).toBe(200);
    expect(eventsStatusFiltered()).toBe(true);
  });

  it('applies status=published on the series detail', async () => {
    mockResponses.set('event_series', { data: seriesRow, error: null });
    mockResponses.set('events', { data: null, error: null }); // detail uses maybeSingle

    const res = await fetch(`${baseUrl}/api/v1/series/weekly-thing`);
    expect(res.status).toBe(200);
    expect(eventsStatusFiltered()).toBe(true);
  });
});
