/**
 * Series instance provenance (F6 regression).
 *
 * The auto-extend cron and the instance_count extend materialize future
 * instances SOLELY from event_series.base_event_data. base_event_data was
 * snapshotted from a templateKeys allow-list that omitted first_party,
 * source_method, source_feed_url, and tmdb_id — so a witnessed/proxied or
 * first-party recurring series published later instances with wrong Type A /
 * four-roles signals (first_party=false, source.method=self_asserted, url
 * dropped). createEventSeries must snapshot these into base_event_data; the
 * cron/extend row builders already spread base_event_data, so propagation
 * follows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedInserts = vi.hoisted(() => [] as Array<{ table: string; payload: Record<string, unknown> }>);
const mockResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown; count?: number }>());

vi.mock('../src/lib/supabase.js', () => {
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const methods = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in',
      'update', 'delete', 'upsert', 'maybeSingle', 'single',
    ];
    for (const m of methods) c[m] = () => c;
    c.insert = (payload: unknown) => {
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        capturedInserts.push({ table, payload: payload as Record<string, unknown> });
      }
      return c;
    };
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
  dispatchWebhooks: vi.fn(), dispatchSeriesCreatedWebhook: vi.fn(),
  dispatchSeriesUpdatedWebhook: vi.fn(), dispatchSeriesDeletedWebhook: vi.fn(),
}));

import { createEventSeries } from '../src/lib/event-series.js';

beforeEach(() => {
  capturedInserts.length = 0;
  mockResponses.clear();
  mockResponses.set('event_series', { data: { id: 'series-1' }, error: null });
  mockResponses.set('events', { data: [{ id: 'e1', event_at: '2026-07-01T23:00:00Z', event_timezone: 'America/New_York', status: 'published' }], error: null });
});

function capturedBaseEventData(): Record<string, unknown> {
  const rec = capturedInserts.find((i) => i.table === 'event_series');
  return (rec?.payload.base_event_data as Record<string, unknown>) || {};
}

describe('createEventSeries snapshots provenance into base_event_data (F6)', () => {
  it('carries first_party / source_method / source_feed_url / tmdb_id', async () => {
    await createEventSeries(
      {
        creator_account_id: 'acc-1',
        content: 'Witnessed Weekly',
        first_party: true,
        source_method: 'witnessed',
        source_feed_url: 'https://feed.example/calendar.ics',
        tmdb_id: '550',
      },
      { name: 'Witnessed Weekly', organizer_org_id: 'org-1', slug: 'witnessed-weekly' },
      'weekly', '2026-07-01', '19:00', '21:00', 'America/New_York', 4,
    );

    const base = capturedBaseEventData();
    expect(base.first_party).toBe(true);
    expect(base.source_method).toBe('witnessed');
    expect(base.source_feed_url).toBe('https://feed.example/calendar.ics');
    expect(base.tmdb_id).toBe('550');
  });
});
