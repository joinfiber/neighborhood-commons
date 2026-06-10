/**
 * Series timezone recomposition (F5 regression).
 *
 * event_at is a fixed instant. A timezone-only series PATCH that writes a new
 * event_timezone without recomposing event_at silently shifts every future
 * instance's wall-clock (7pm becomes 6pm) — the single-event S6 bug, never
 * applied to the series path. updateSeriesFutureInstances must, on a tz change,
 * decompose each instance in its OLD tz and recompose in the NEW one.
 *
 * The shared mock ignores filters, so we capture the per-instance .update()
 * payload and check the recomposed event_at still reads as 7pm in the new tz.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedUpdates = vi.hoisted(() => [] as Array<{ table: string; payload: Record<string, unknown> }>);
const mockResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown; count?: number }>());

vi.mock('../src/lib/supabase.js', () => {
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const methods = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in',
      'insert', 'delete', 'upsert', 'maybeSingle', 'single',
    ];
    for (const m of methods) c[m] = () => c;
    c.update = (payload: unknown) => {
      capturedUpdates.push({ table, payload: payload as Record<string, unknown> });
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

import { updateSeriesFutureInstances } from '../src/lib/event-series.js';
import { toTimestamptz } from '../src/lib/event-operations.js';

// 2026-07-01 19:00 America/New_York (EDT, -04:00) == 23:00Z.
const INSTANCE = {
  id: 'e1',
  event_at: '2026-07-01T23:00:00Z',
  end_time: null,
  event_timezone: 'America/New_York',
  series_instance_number: 1,
};

beforeEach(() => {
  capturedUpdates.length = 0;
  mockResponses.clear();
  mockResponses.set('event_series', {
    data: { id: 'series-1', recurrence: 'weekly', creator_account_id: 'acc-1', base_event_data: { event_timezone: 'America/New_York', start_time: '19:00', end_time: null } },
    error: null,
  });
  mockResponses.set('events', { data: [INSTANCE], error: null });
});

function eventsUpdate(): Record<string, unknown> | undefined {
  return capturedUpdates.find((u) => u.table === 'events')?.payload;
}

describe('updateSeriesFutureInstances — timezone recomposition (F5)', () => {
  it('recomposes event_at on a timezone-only change, preserving wall-clock', async () => {
    await updateSeriesFutureInstances({
      seriesId: 'series-1',
      updates: { event_timezone: 'America/Chicago' },
      timeChange: undefined,
      instanceCountChange: undefined,
      timezone: 'America/Chicago',
    });

    const payload = eventsUpdate();
    expect(payload).toBeDefined();
    expect(payload!.event_timezone).toBe('America/Chicago');
    // event_at must be recomposed so the wall-clock stays 7pm on 2026-07-01,
    // now expressed in the new tz. toTimestamptz emits a Postgres literal
    // (`YYYY-MM-DD HH:MM:SS <tz>`). Without the fix, event_at is left untouched
    // (the old UTC instant) and reads as 6pm once the tz flips to Chicago.
    expect(payload!.event_at).toBe(toTimestamptz('2026-07-01', '19:00', 'America/Chicago'));
  });

  it('batches a non-time, non-timezone edit without touching event_at', async () => {
    await updateSeriesFutureInstances({
      seriesId: 'series-1',
      updates: { content: 'Renamed Series' },
      timeChange: undefined,
      instanceCountChange: undefined,
      timezone: 'America/New_York',
    });

    const payload = eventsUpdate();
    expect(payload).toBeDefined();
    expect(payload!.content).toBe('Renamed Series');
    expect(payload!.event_at).toBeUndefined();
  });
});
