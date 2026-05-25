/**
 * Response shape conformance — code ↔ spec
 *
 * Closes the spec-code loop. The contract-drift test confirms the SDK
 * schema matches openapi.json. This test confirms that the live transform
 * output (toNeighborhoodEvent) actually produces objects whose shape
 * matches the openapi.json schemas — catching the case where a field is
 * added/removed in one place but not the other.
 *
 * Coverage strategy: dependency-free, intentionally narrow. For each
 * primary schema we care about, we assert:
 *   1. Every key in the schema's `required` array is present on the
 *      live output (catches "code dropped a required field").
 *   2. Every key on the live output is in the schema's `properties`
 *      (catches "code emits a field the spec doesn't declare").
 *
 * Full JSON Schema validation would catch type-level drift too; that
 * would need ajv/zod-from-openapi and is out of scope here. The two
 * checks above catch the structural drift that costs hours to debug
 * in downstream apps.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { toNeighborhoodEvent, type PortalEventRow } from '../src/lib/event-transform.js';
import { formatOrganization } from '../src/routes/v1-organizations.js';
import { formatBroadcast } from '../src/routes/v1-broadcasts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(__dirname, '..', 'public', 'openapi.json');

type JsonSchema = {
  required?: string[];
  properties?: Record<string, unknown>;
};

function loadSchema(name: string): JsonSchema {
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf-8')) as {
    components: { schemas: Record<string, JsonSchema> };
  };
  const schema = spec.components.schemas[name];
  if (!schema) throw new Error(`Schema "${name}" not found in openapi.json`);
  return schema;
}

function makeRow(overrides: Partial<PortalEventRow> = {}): PortalEventRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    content: 'Conformance fixture',
    description: 'A test event',
    place_name: 'Test Venue',
    venue_address: '1 Test St',
    place_id: 'ChIJ_test',
    latitude: 39.9632,
    longitude: -75.1551,
    event_at: '2026-05-01T19:00:00.000Z',
    end_time: '2026-05-01T22:00:00.000Z',
    event_timezone: 'America/New_York',
    category: 'community',
    custom_category: null,
    recurrence: 'none',
    series_id: null,
    series_instance_number: null,
    open_window: false,
    capacity: null,
    rsvp: null,
    tags: [],
    wheelchair_accessible: null,
    price: null,
    link_url: null,
    event_image_url: null,
    created_at: '2026-04-01T12:00:00.000Z',
    source_method: 'self_asserted',
    source_feed_url: null,
    source_contributor_url: null,
    source_contributor_name: null,
    first_party: false,
    tmdb_id: null,
    organizer_org_id: 'org-uuid-1',
    organizations: {
      id: 'org-uuid-1',
      slug: 'test-org',
      name: 'Test Org',
      portal_accounts: null,
    },
    contributor_profile_id: null,
    contributor_profiles: null,
    ...overrides,
  };
}

describe('response shape conformance — code matches openapi.json', () => {
  describe('Source schema', () => {
    const schema = loadSchema('Source');
    const required = new Set(schema.required ?? []);
    const declared = new Set(Object.keys(schema.properties ?? {}));

    it('output has every key declared as required in the spec', () => {
      const event = toNeighborhoodEvent(makeRow());
      for (const key of required) {
        expect(event.source, `source.${key} missing on live output`).toHaveProperty(key);
      }
    });

    it('output does not emit any key the spec does not declare', () => {
      const event = toNeighborhoodEvent(makeRow());
      for (const key of Object.keys(event.source)) {
        expect(declared.has(key), `source.${key} emitted by code but not declared in openapi.json`).toBe(true);
      }
    });

    it('explicitly: no legacy `publisher` field on the response', () => {
      // Defense against quiet reintroduction of the retired 4-role-violating slot.
      const event = toNeighborhoodEvent(makeRow());
      expect(event.source).not.toHaveProperty('publisher');
    });

    it('explicitly: method values from the spec enum are accepted', () => {
      // The transform should accept any value from the spec's source.method
      // enum. If a new method ever gets added to the spec, this test reminds
      // us to wire the corresponding row state through.
      const sourceProperties = schema.properties as { method: { enum: string[] } };
      const specMethods = sourceProperties.method.enum;
      for (const method of specMethods) {
        const event = toNeighborhoodEvent(makeRow({ source_method: method as PortalEventRow['source_method'] }));
        expect(event.source.method).toBe(method);
      }
    });
  });

  describe('Event schema (top-level fields)', () => {
    const schema = loadSchema('Event');
    const required = new Set(schema.required ?? []);
    const declared = new Set(Object.keys(schema.properties ?? {}));

    it('output has every key declared as required in the spec', () => {
      const event = toNeighborhoodEvent(makeRow());
      for (const key of required) {
        expect(event, `event.${key} missing on live output`).toHaveProperty(key);
      }
    });

    it('output does not emit any key the spec does not declare', () => {
      // Some legitimately added internal-but-spec'd fields would surface
      // here — failure means audit the new field against the spec.
      const event = toNeighborhoodEvent(makeRow());
      for (const key of Object.keys(event)) {
        expect(declared.has(key), `event.${key} emitted by code but not declared in openapi.json`).toBe(true);
      }
    });
  });

  // Organization/Broadcast carry the spec-required `method` provenance field.
  // These formatters are pure (no DB), so they're testable here. The List
  // formatter does DB hydration and is exercised via api-integration instead.
  describe('Organization schema (top-level fields)', () => {
    const schema = loadSchema('Organization');
    const required = new Set(schema.required ?? []);

    function makeOrgRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: 'org-uuid-1', slug: 'test-org', name: 'Test Org', legal_name: null,
        description: null, url: null, logo_url: null, image_url: null,
        telephone: null, email: null, same_as: [], keywords: [],
        opening_hours_specification: null, tags: [], commercial: null,
        method: 'seeded', primary_place_id: null,
        created_at: '2026-04-01T12:00:00.000Z', updated_at: '2026-04-01T12:00:00.000Z',
        ...overrides,
      };
    }

    it('output has every key declared as required in the spec', () => {
      const org = formatOrganization(makeOrgRow(), new Map(), new Map());
      for (const key of required) {
        expect(org, `organization.${key} missing on live output`).toHaveProperty(key);
      }
    });

    it('emits the provenance method (the field that silently drifted)', () => {
      const org = formatOrganization(makeOrgRow({ method: 'self_asserted' }), new Map(), new Map());
      expect(org.method).toBe('self_asserted');
    });
  });

  describe('Broadcast schema (top-level + source shape)', () => {
    const schema = loadSchema('Broadcast');
    const required = new Set(schema.required ?? []);
    const sourceRequired = new Set(loadSchema('Source').required ?? []);

    function makeBroadcastRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: 'b-uuid-1', message: 'Kitchen open late',
        created_at: '2026-05-01T19:00:00.000Z', expires_at: '2026-05-02T19:00:00.000Z',
        status: 'active', method: 'self_asserted',
        // Legacy non-conformant stored shape — must be shaped on output.
        source: { publisher: 'TestApp', method: 'service', contributor: 'TestApp', collected_at: '2026-05-01T19:00:00.000Z', license: 'CC BY 4.0' },
        organizations: { id: 'org-uuid-1', slug: 'test-org', name: 'Test Org', tags: [], method: 'seeded' },
        places: null,
        ...overrides,
      };
    }

    it('output has every key declared as required in the spec', () => {
      const b = formatBroadcast(makeBroadcastRow(), new Map());
      for (const key of required) {
        expect(b, `broadcast.${key} missing on live output`).toHaveProperty(key);
      }
    });

    it('source conforms to the Source schema (shaped, not raw passthrough)', () => {
      const b = formatBroadcast(makeBroadcastRow(), new Map());
      for (const key of sourceRequired) {
        expect(b.source, `broadcast.source.${key} missing on live output`).toHaveProperty(key);
      }
      // The retired, four-role-violating `publisher` slot must not leak through.
      expect(b.source).not.toHaveProperty('publisher');
      // method must be a valid Source enum value, not the legacy 'service'.
      expect(['self_asserted', 'proxied', 'witnessed']).toContain(b.source.method);
    });
  });
});
