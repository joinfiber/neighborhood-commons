/**
 * Service API — ServiceEventInput schema regression tests
 *
 * The Service API accepts the Neighborhood API friendly-shape payload
 * (name/start/timezone/location/url/cost), symmetric with the read schema.
 * Recurrence is optional.
 *
 * Required: `organizerOrganizationId` (organizer authority anchor for the
 * constrained-publishing model). source_method is optionally caller-set
 * to 'self_asserted' (default) or 'witnessed' (collective-evidence;
 * requires witness_authority on the key). 'proxied' is not caller-settable —
 * it's reserved for internal pipeline code paths.
 *
 * Post-085: source.publisher is gone (the role is filled by organizer.name).
 * No source_publisher column exists.
 *
 * If these fail, the Spec (public/openapi.json) and the implementation
 * have drifted — consumers will get 400s on payloads the Spec says are
 * valid.
 */

import { describe, it, expect } from 'vitest';
import { createEventSchema, friendlyToPortalInput } from '../src/routes/service/events.js';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

function minimumFriendly() {
  return {
    organizerOrganizationId: ORG_ID,
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
      organizerOrganizationId: ORG_ID,
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

  it('rejects when organizerOrganizationId is missing', () => {
    const { organizerOrganizationId: _omit, ...rest } = minimumFriendly();
    void _omit;
    const result = createEventSchema.safeParse(rest);
    expect(result.success).toBe(false);
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

  // -------------------------------------------------------------------------
  // contributor — per-event routing-participant identity
  // -------------------------------------------------------------------------

  it('accepts contributor: { name } without url', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      contributor: { name: 'Go There' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts contributor with a full url', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      contributor: { name: 'Go There', url: 'https://gothere.bike' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributor).toEqual({
        name: 'Go There',
        url: 'https://gothere.bike',
      });
    }
  });

  it('coerces a contributor.url without a scheme to https://', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      contributor: { name: 'Go There', url: 'gothere.bike' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributor?.url).toBe('https://gothere.bike');
    }
  });

  it('rejects contributor with empty name', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      contributor: { name: '' },
    });
    expect(result.success).toBe(false);
  });

  it('omitting contributor is valid (additive field)', () => {
    const result = createEventSchema.safeParse(minimumFriendly());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.contributor).toBeUndefined();
  });
});

describe('friendlyToPortalInput — server-controlled provenance', () => {
  it('defaults source_method to "self_asserted" when caller omits it', () => {
    const parsed = createEventSchema.parse(minimumFriendly());
    const { portal } = friendlyToPortalInput(parsed);
    expect(portal.source_method).toBe('self_asserted');
  });

  it('threads source_method="witnessed" through when caller sets it (still gated by witness_authority at route)', () => {
    const parsed = createEventSchema.parse({
      ...minimumFriendly(),
      source_method: 'witnessed',
    });
    const { portal } = friendlyToPortalInput(parsed);
    expect(portal.source_method).toBe('witnessed');
  });

  it('threads contributor into source_contributor_name / source_contributor_url', () => {
    const parsed = createEventSchema.parse({
      ...minimumFriendly(),
      contributor: { name: 'Go There', url: 'https://gothere.bike' },
    });
    const { portal } = friendlyToPortalInput(parsed);
    expect(portal.source_contributor_name).toBe('Go There');
    expect(portal.source_contributor_url).toBe('https://gothere.bike');
  });

  it('nulls both contributor columns when contributor is omitted', () => {
    const parsed = createEventSchema.parse(minimumFriendly());
    const { portal } = friendlyToPortalInput(parsed);
    expect(portal.source_contributor_name).toBeNull();
    expect(portal.source_contributor_url).toBeNull();
  });
});

describe('ServiceEventInput — source_method hygiene', () => {
  it('accepts source_method="self_asserted" from the caller', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      source_method: 'self_asserted',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source_method).toBe('self_asserted');
    }
  });

  it('accepts source_method="witnessed" from the caller (route-level guard enforces witness_authority)', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      source_method: 'witnessed',
    });
    expect(result.success).toBe(true);
  });

  it('accepts source_method="proxied" from the caller (route-level guard enforces proxy_authority + source_feed_url)', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      source_method: 'proxied',
      source_feed_url: 'https://westphillyporchfest.com/shows',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source_method).toBe('proxied');
      expect(result.data.source_feed_url).toBe('https://westphillyporchfest.com/shows');
    }
  });

  it('rejects retired legacy method values like "api"', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      source_method: 'api',
    });
    expect(result.success).toBe(false);
  });

  it('rejects retired legacy method values like "portal"', () => {
    const result = createEventSchema.safeParse({
      ...minimumFriendly(),
      source_method: 'portal',
    });
    expect(result.success).toBe(false);
  });

  it('does not accept source_publisher from the caller (field no longer exists)', () => {
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
