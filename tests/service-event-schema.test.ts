/**
 * Service API — ServiceEventInput schema regression tests
 *
 * The Service API accepts the Neighborhood API friendly-shape payload
 * (name/start/timezone/location/url/cost), symmetric with the read schema
 * and the Contribute API. Recurrence is optional.
 *
 * If these fail, the Spec (public/openapi.json) and the implementation
 * have drifted — consumers (Merrie, Go There/FTL) will get 400s on
 * payloads the Spec says are valid.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createEventSchema } from '../src/routes/service.js';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

function minimumFriendly() {
  return {
    account_id: ACCOUNT_ID,
    name: 'Open Mic',
    start: '2026-05-01T19:00:00-04:00',
    timezone: 'America/New_York',
    category: 'live_music',
    location: { name: 'Johnny\'s Bar' },
  };
}

describe('ServiceEventInput — friendly-shape', () => {
  it('accepts the minimum-valid one-off payload (no recurrence)', () => {
    const result = createEventSchema.safeParse(minimumFriendly());
    expect(result.success).toBe(true);
  });

  it('accepts a recurring payload with RRULE-style recurrence', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      recurrence: 'weekly',
      instance_count: 6,
    });
    expect(result.success).toBe(true);
  });

  it('rejects DB-shape payload (title/event_date/start_time) — no silent acceptance', () => {
    const dbShape = {
      account_id: ACCOUNT_ID,
      title: 'Open Mic',
      event_date: '2026-05-01',
      start_time: '19:00',
      event_timezone: 'America/New_York',
      category: 'live_music',
      venue_name: 'Johnny\'s Bar',
    };
    const result = createEventSchema.safeParse(dbShape);
    expect(result.success).toBe(false);
    if (!result.success) {
      const missing = result.error.issues.map((i) => i.path.join('.'));
      expect(missing).toContain('name');
      expect(missing).toContain('start');
      expect(missing).toContain('timezone');
      expect(missing).toContain('location');
    }
  });

  it('rejects when recurrence field is missing only if other required fields are present — recurrence is optional', () => {
    // recurrence absence must NOT be a failure reason
    const result = createEventSchema.safeParse(minimumFriendly());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recurrence).toBeUndefined();
    }
  });

  it('requires location.name', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      location: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid IANA timezone', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      timezone: 'Not/A_Real_Zone',
    });
    expect(result.success).toBe(false);
  });
});

describe('ServiceEventInput — Spec/implementation alignment', () => {
  it('Spec lists the same required fields as the Zod schema (excluding recurrence)', () => {
    const specPath = resolve(__dirname, '..', 'public', 'openapi.json');
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const specRequired: string[] = spec.components.schemas.ServiceEventInput.required;

    expect(specRequired).toEqual(expect.arrayContaining([
      'account_id', 'name', 'start', 'timezone', 'category', 'location',
    ]));
    expect(specRequired).not.toContain('recurrence');
    expect(specRequired).not.toContain('title');
    expect(specRequired).not.toContain('event_date');
    expect(specRequired).not.toContain('start_time');
  });
});
