/**
 * CSV Contribution Tests
 *
 * Tests the CSV contribution flow: upload → preview/map → confirm.
 * Verifies auth enforcement, CSV parsing, column mapping, category mapping,
 * validation, batch lifecycle, and event creation.
 *
 * Uses the same mock pattern as portal-crud.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';

// ---------------------------------------------------------------------------
// Mocks — hoisted before app imports
// ---------------------------------------------------------------------------

const mockResponses = vi.hoisted(() => {
  return new Map<string, { data: unknown; error: unknown; count?: number }>();
});

const mockAuthUser = vi.hoisted(() => {
  return { value: { data: { user: null }, error: { message: 'invalid token' } } as unknown };
});

const mockMutations = vi.hoisted(() => {
  return { inserts: [] as Array<{ table: string; data: unknown }>, updates: [] as Array<{ table: string; data: unknown }> };
});

vi.mock('../src/lib/supabase.js', () => {
  function createQueryChain(table: string) {
    const chain: Record<string, unknown> = {};
    const chainMethods = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in',
      'maybeSingle', 'single',
    ];

    for (const method of chainMethods) {
      chain[method] = () => chain;
    }

    chain.insert = (data: unknown) => {
      mockMutations.inserts.push({ table, data });
      return chain;
    };

    chain.update = (data: unknown) => {
      mockMutations.updates.push({ table, data });
      return chain;
    };

    chain.delete = () => chain;
    chain.upsert = (data: unknown) => {
      mockMutations.inserts.push({ table, data });
      return chain;
    };

    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      const response = mockResponses.get(table) || { data: [], error: null, count: 0 };
      return Promise.resolve(response).then(resolve, reject);
    };

    return chain;
  }

  return {
    supabaseAdmin: {
      from: (table: string) => createQueryChain(table),
      auth: {
        getUser: () => Promise.resolve(mockAuthUser.value),
        signInWithOtp: () => Promise.resolve({ error: null }),
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
    },
    createUserClient: () => ({
      from: (table: string) => createQueryChain(table),
    }),
  };
});

vi.mock('../src/lib/webhook-delivery.js', () => ({
  dispatchWebhooks: vi.fn(),
  dispatchSeriesCreatedWebhook: vi.fn(),
}));

vi.mock('../src/lib/audit.js', () => ({
  auditPortalAction: vi.fn(),
}));

vi.mock('../src/lib/cloudflare.js', () => ({
  uploadToR2: vi.fn().mockResolvedValue({ success: true }),
  getFromR2: vi.fn().mockResolvedValue({ data: null, contentType: null }),
}));

// ---------------------------------------------------------------------------
// Import app after mocks
// ---------------------------------------------------------------------------

import { createApp } from '../src/app.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PORTAL_USER_ID = 'user-uuid-csv-1';
const PORTAL_ACCOUNT_ID = 'account-uuid-csv-1';

function authenticateUser() {
  mockAuthUser.value = {
    data: { user: { id: PORTAL_USER_ID, email: 'contributor@example.com' } },
    error: null,
  };
}

function unauthenticate() {
  mockAuthUser.value = {
    data: { user: null },
    error: { message: 'invalid token' },
  };
}

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: PORTAL_ACCOUNT_ID,
    auth_user_id: PORTAL_USER_ID,
    email: 'contributor@example.com',
    business_name: 'Test Contributor',
    status: 'active',
    website: 'https://example.com',
    ...overrides,
  };
}

const SAMPLE_CSV = `name,date,start_time,venue_name,category,description
Fishtown Flea,2026-04-12,10:00,Frankford Hall,market,Monthly flea market
Jazz Night,2026-04-13,19:30,The Blue Note,live_music,Live jazz combo
Yoga in the Park,2026-04-14,08:00,Penn Treaty Park,fitness,Free outdoor yoga`;

const SAMPLE_CSV_CUSTOM_CATEGORIES = `title,date,time,location,type
Community Dinner,2026-04-12,18:00,Church Hall,community dinner
Food Pantry,2026-04-13,10:00,Warehouse,food bank`;

let app: ReturnType<typeof createApp>;
let server: Server;

function request(method: string, path: string, body?: unknown, token = 'mock-token') {
  return fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('CSV Contribution API', () => {
  beforeAll(async () => {
    app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on('listening', resolve));
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    mockResponses.clear();
    mockMutations.inserts = [];
    mockMutations.updates = [];
    unauthenticate();
  });

  // ── AUTH ENFORCEMENT ──────────────────────────────────────────────────

  describe('auth enforcement', () => {
    it('rejects unauthenticated CSV upload', async () => {
      const res = await request('POST', '/api/portal/csv/upload', { csv_text: SAMPLE_CSV });
      expect(res.status).toBe(401);
    });

    it('rejects unauthenticated batch list', async () => {
      const res = await request('GET', '/api/portal/csv/batches');
      expect(res.status).toBe(401);
    });

    it('rejects unauthenticated preview', async () => {
      const res = await request('POST', '/api/portal/csv/preview', {
        batch_id: '00000000-0000-0000-0000-000000000001',
        column_mapping: {},
        default_category: 'community',
      });
      expect(res.status).toBe(401);
    });

    it('rejects unauthenticated confirm', async () => {
      const res = await request('POST', '/api/portal/csv/confirm', {
        batch_id: '00000000-0000-0000-0000-000000000001',
        selected_rows: [1],
      });
      expect(res.status).toBe(401);
    });
  });

  // ── UPLOAD VALIDATION ─────────────────────────────────────────────────

  describe('upload validation', () => {
    beforeEach(() => {
      authenticateUser();
      mockResponses.set('portal_accounts', { data: makeAccount(), error: null });
      mockResponses.set('contribution_batches', {
        data: { id: '00000000-0000-0000-0000-000000000001' },
        error: null,
      });
      mockResponses.set('contribution_rows', { data: [], error: null });
    });

    it('rejects empty csv_text', async () => {
      const res = await request('POST', '/api/portal/csv/upload', { csv_text: '' });
      expect(res.status).toBe(400);
    });

    it('rejects CSV with only headers (no data rows)', async () => {
      const res = await request('POST', '/api/portal/csv/upload', {
        csv_text: 'name,date,category\n',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('CSV_EMPTY');
    });

    it('accepts valid CSV and returns mapping suggestions', async () => {
      const res = await request('POST', '/api/portal/csv/upload', {
        csv_text: SAMPLE_CSV,
        file_name: 'events.csv',
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.batch_id).toBeDefined();
      expect(body.headers).toEqual(['name', 'date', 'start_time', 'venue_name', 'category', 'description']);
      expect(body.row_count).toBe(3);
      expect(body.sample_rows.length).toBeLessThanOrEqual(5);
      // Auto-detection should map common headers
      expect(body.suggested_mapping.name).toBe('name');
      expect(body.suggested_mapping.date).toBe('date');
      expect(body.suggested_mapping.category).toBe('category');
    });

    it('auto-detects title as name', async () => {
      const res = await request('POST', '/api/portal/csv/upload', {
        csv_text: SAMPLE_CSV_CUSTOM_CATEGORIES,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.suggested_mapping.title).toBe('name');
      expect(body.suggested_mapping.location).toBe('venue_name');
      expect(body.suggested_mapping.type).toBe('category');
    });
  });

  // ── BATCH LIST ────────────────────────────────────────────────────────

  describe('batch history', () => {
    it('returns empty list for new contributor', async () => {
      authenticateUser();
      mockResponses.set('portal_accounts', { data: makeAccount(), error: null });
      mockResponses.set('contribution_batches', { data: [], error: null });

      const res = await request('GET', '/api/portal/csv/batches');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.batches).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// CSV Helpers Unit Tests
// ---------------------------------------------------------------------------

import { parseCSV, autoDetectMapping, validateContributionRow, parseFlexibleDate, parseFlexibleTime } from '../src/lib/csv-helpers.js';

describe('CSV Helpers', () => {
  describe('parseCSV', () => {
    it('parses simple CSV', () => {
      const { headers, rows } = parseCSV('name,date\nFoo,2026-01-01\nBar,2026-01-02');
      expect(headers).toEqual(['name', 'date']);
      expect(rows.length).toBe(2);
      expect(rows[0]!.name).toBe('Foo');
      expect(rows[1]!.date).toBe('2026-01-02');
    });

    it('handles quoted fields with commas', () => {
      const { rows } = parseCSV('name,desc\n"Smith, John","A ""great"" event"');
      expect(rows[0]!.name).toBe('Smith, John');
      expect(rows[0]!.desc).toBe('A "great" event');
    });

    it('strips BOM', () => {
      const { headers } = parseCSV('\uFEFFname,date\nFoo,2026-01-01');
      expect(headers[0]).toBe('name');
    });

    it('handles CRLF line endings', () => {
      const { rows } = parseCSV('name,date\r\nFoo,2026-01-01\r\nBar,2026-01-02');
      expect(rows.length).toBe(2);
    });

    it('returns empty for header-only CSV', () => {
      const { headers, rows } = parseCSV('name,date');
      expect(headers).toEqual(['name', 'date']);
      expect(rows.length).toBe(0);
    });
  });

  describe('autoDetectMapping', () => {
    it('maps common header names', () => {
      const mapping = autoDetectMapping(['title', 'Date', 'Venue', 'Category', 'Price']);
      expect(mapping['title']).toBe('name');
      expect(mapping['Date']).toBe('date');
      expect(mapping['Venue']).toBe('venue_name');
      expect(mapping['Category']).toBe('category');
      expect(mapping['Price']).toBe('price');
    });

    it('does not double-map fields', () => {
      const mapping = autoDetectMapping(['name', 'title']); // both map to 'name'
      const values = Object.values(mapping);
      const nameCount = values.filter(v => v === 'name').length;
      expect(nameCount).toBe(1);
    });
  });

  describe('validateContributionRow', () => {
    it('passes valid row', () => {
      const errors = validateContributionRow(
        { name: 'Test Event', date: '2026-04-12' },
        'community',
      );
      expect(errors.length).toBe(0);
    });

    it('requires name', () => {
      const errors = validateContributionRow({ date: '2026-04-12' }, 'community');
      expect(errors.some(e => e.field === 'name')).toBe(true);
    });

    it('requires date or start', () => {
      const errors = validateContributionRow({ name: 'Test' }, 'community');
      expect(errors.some(e => e.field === 'date')).toBe(true);
    });

    it('rejects invalid latitude', () => {
      const errors = validateContributionRow(
        { name: 'Test', date: '2026-01-01', latitude: '999' },
        'community',
      );
      expect(errors.some(e => e.field === 'latitude')).toBe(true);
    });

    it('rejects name over 200 chars', () => {
      const errors = validateContributionRow(
        { name: 'X'.repeat(201), date: '2026-01-01' },
        'community',
      );
      expect(errors.some(e => e.field === 'name')).toBe(true);
    });
  });

  describe('parseFlexibleDate', () => {
    it('parses YYYY-MM-DD', () => {
      expect(parseFlexibleDate('2026-04-12')).toBe('2026-04-12');
    });

    it('parses MM/DD/YYYY', () => {
      expect(parseFlexibleDate('4/12/2026')).toBe('2026-04-12');
    });

    it('parses MM/DD/YYYY with leading zeros', () => {
      expect(parseFlexibleDate('04/12/2026')).toBe('2026-04-12');
    });

    it('extracts date from ISO datetime', () => {
      expect(parseFlexibleDate('2026-04-12T10:00:00Z')).toBe('2026-04-12');
    });

    it('rejects Feb 29 on non-leap year', () => {
      expect(parseFlexibleDate('02/29/2025')).toBeNull();
    });

    it('accepts Feb 29 on leap year', () => {
      expect(parseFlexibleDate('02/29/2024')).toBe('2024-02-29');
    });

    it('rejects Apr 31', () => {
      expect(parseFlexibleDate('04/31/2026')).toBeNull();
    });

    it('returns null for garbage', () => {
      expect(parseFlexibleDate('not a date')).toBeNull();
    });
  });

  describe('parseFlexibleTime', () => {
    it('parses HH:MM (24-hour)', () => {
      expect(parseFlexibleTime('19:30')).toBe('19:30');
    });

    it('parses h:mm AM/PM', () => {
      expect(parseFlexibleTime('7:30 PM')).toBe('19:30');
    });

    it('parses 12:00 AM as 00:00', () => {
      expect(parseFlexibleTime('12:00 AM')).toBe('00:00');
    });

    it('parses 12:00 PM as 12:00', () => {
      expect(parseFlexibleTime('12:00 PM')).toBe('12:00');
    });

    it('returns null for garbage', () => {
      expect(parseFlexibleTime('sometime')).toBeNull();
    });
  });
});
