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
import { createEventSchema, friendlyToPortalInput } from '../src/routes/service/events.js';

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

describe('friendlyToPortalInput — server-controlled provenance', () => {
  it('hardcodes source_method="api" regardless of caller input', () => {
    const parsed = createEventSchema.parse(minimumFriendly());
    const { portal } = friendlyToPortalInput(parsed, "Johnny's Bar");
    expect(portal.source_method).toBe('api');
  });

  it('derives source_publisher from the linked account business_name, not the caller', () => {
    const parsed = createEventSchema.parse(minimumFriendly());
    const { portal } = friendlyToPortalInput(parsed, "Johnny's Bar");
    expect(portal.source_publisher).toBe("Johnny's Bar");
  });

  it('leaves source_publisher undefined when the account has no business_name', () => {
    const parsed = createEventSchema.parse(minimumFriendly());
    const { portal } = friendlyToPortalInput(parsed, null);
    expect(portal.source_publisher).toBeUndefined();
  });
});

describe('ServiceEventInput — source_method hygiene', () => {
  it('does not accept source_method from the caller (stripped by schema)', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      source_method: 'api',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Field must not survive validation — it is NOT caller-overridable.
      expect('source_method' in result.data).toBe(false);
    }
  });

  it('does not accept source_publisher from the caller (stripped by schema)', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      source_publisher: 'attacker-brand',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('source_publisher' in result.data).toBe(false);
    }
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
