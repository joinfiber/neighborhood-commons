/**
 * Schema Alignment Tests
 *
 * Static analysis: extract every column name referenced in Supabase
 * queries across the codebase and verify they exist in the actual
 * database schema.
 *
 * This test would have caught:
 * - key vs key_hash mismatch
 * - owner_email vs contact_email mismatch
 * - is_active vs status mismatch
 * - http_status vs status_code mismatch
 * - attempt_number vs attempt mismatch
 * - delivered_at (nonexistent column)
 *
 * The schema is defined here as the source of truth, updated from
 * the Supabase schema export. When you add a column, add it here
 * first — that's the point.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Known database schema — update when migrations change columns
// ---------------------------------------------------------------------------

const SCHEMA: Record<string, string[]> = {
  api_keys: [
    'id', 'name', 'tier', 'rate_limit_per_hour', 'created_at',
    'key_hash', 'key_prefix', 'contact_email', 'status', 'last_used_at', 'contributor_tier',
  ],
  audit_logs: [
    'id', 'action', 'actor_hash', 'resource_id', 'metadata', 'endpoint',
    'created_at', 'resource_hash', 'result', 'reason', 'ip_hash', 'user_agent',
  ],
  events: [
    'id', 'content', 'description', 'event_at', 'end_time', 'event_timezone',
    'place_id', 'place_name', 'venue_address', 'latitude', 'longitude',
    'location', 'approximate_location', 'region_id', 'category', 'custom_category',
    'price', 'link_url', 'event_image_url', 'event_image_focal_y', 'source',
    'creator_account_id', 'user_id', 'is_business', 'visibility', 'status',
    'broadcast_mode', 'discovery_radius_meters', 'recurrence', 'series_id',
    'series_instance_number', 'becomes_visible_at', 'expires_at', 'ended_at',
    'start_time_required', 'tags', 'wheelchair_accessible', 'rsvp_limit',
    'source_method', 'source_publisher', 'source_feed_url', 'external_id',
    'created_at', 'updated_at',
  ],
  event_series: [
    'id', 'creator_account_id', 'recurrence', 'base_event_data',
    'created_at', 'updated_at', 'user_id', 'recurrence_rule',
  ],
  portal_accounts: [
    'id', 'auth_user_id', 'email', 'business_name', 'phone', 'website',
    'default_venue_name', 'default_address', 'default_place_id',
    'default_latitude', 'default_longitude', 'logo_url', 'description',
    'status', 'claimed_at', 'created_at', 'updated_at', 'last_login_at',
    'wheelchair_accessible',
  ],
  regions: [
    'id', 'name', 'slug', 'type', 'parent_id', 'bounds', 'centroid',
    'timezone', 'is_active', 'created_at', 'updated_at',
  ],
  webhook_deliveries: [
    'id', 'subscription_id', 'event_type', 'event_id', 'status',
    'status_code', 'error_message', 'attempt', 'next_retry_at', 'created_at',
  ],
  webhook_subscriptions: [
    'id', 'api_key_id', 'url', 'signing_secret', 'signing_secret_encrypted',
    'event_types', 'consecutive_failures', 'disabled_at', 'created_at',
    'updated_at', 'status', 'last_success_at', 'last_failure_at', 'last_failure_reason',
  ],
};

// ---------------------------------------------------------------------------
// Source file scanner
// ---------------------------------------------------------------------------

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist' && entry !== 'tests') {
        files.push(...getAllTsFiles(full));
      }
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

// JS keywords and common variable names that appear as object keys
// near .insert()/.update() but aren't database columns.
// IMPORTANT: Do NOT add words that are also real column names
// (e.g. 'name', 'status', 'url', 'type' are real columns).
const JS_NOISE_WORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else',
  'true', 'false', 'null', 'undefined', 'count', 'head', 'ascending',
  'error', 'success', 'failed', 'data', 'result', 'value',
  'token', 'body', 'headers', 'signal',
  'then', 'catch', 'finally', 'async', 'await',
  'message', 'registered',
]);

interface ColumnRef {
  table: string;
  column: string;
  file: string;
  line: number;
  context: string;
}

/**
 * Extract column references from Supabase queries in source code.
 * Catches: .select('col1, col2'), .eq('col', val), .insert({ col: val }),
 * .update({ col: val }), .is('col', null), .not('col', ...), .order('col', ...)
 */
function extractColumnRefs(filePath: string): ColumnRef[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const refs: ColumnRef[] = [];

  // Track current table context from .from('table_name')
  let currentTable: string | null = null;
  let currentTableLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Match .from('table_name')
    const fromMatch = line.match(/\.from\(['"](\w+)['"]\)/);
    if (fromMatch) {
      currentTable = fromMatch[1];
      currentTableLine = lineNum;
    }

    if (!currentTable) continue;

    // Reset table context after significant gaps or new statements
    if (lineNum - currentTableLine > 30) {
      currentTable = null;
      continue;
    }

    // Match .select('col1, col2, ...') — extract individual column names
    const selectMatch = line.match(/\.select\(['"]([^'"]+)['"]/);
    if (selectMatch) {
      // Strip joined table references: "region:regions (name, slug)" → ""
      const selectStr = selectMatch[1].replace(/\w+:\w+\s*\([^)]*\)/g, '');
      for (const part of selectStr.split(',')) {
        const trimmed = part.trim();
        // Skip count options, remaining joined table refs, wildcards
        if (trimmed.includes('(') || trimmed.includes(')') || trimmed === '*' || !trimmed) continue;
        // Handle "col:alias" PostgREST syntax
        const colName = trimmed.split(':')[0].trim();
        if (colName && /^[a-z_]+$/i.test(colName)) {
          refs.push({ table: currentTable, column: colName, file: filePath, line: lineNum, context: line.trim() });
        }
      }
    }

    // Match .eq('column', ...), .neq, .gt, .lt, .gte, .lte, .like, .ilike
    const eqMatch = line.match(/\.(eq|neq|gt|lt|gte|lte|like|ilike|is|not)\(['"](\w+)['"]/);
    if (eqMatch) {
      refs.push({ table: currentTable, column: eqMatch[2], file: filePath, line: lineNum, context: line.trim() });
    }

    // Match .in('column', ...)
    const inMatch = line.match(/\.in\(['"](\w+)['"]/);
    if (inMatch) {
      refs.push({ table: currentTable, column: inMatch[1], file: filePath, line: lineNum, context: line.trim() });
    }

    // Match .order('column', ...)
    const orderMatch = line.match(/\.order\(['"](\w+)['"]/);
    if (orderMatch) {
      refs.push({ table: currentTable, column: orderMatch[1], file: filePath, line: lineNum, context: line.trim() });
    }

    // Match .insert({ key: ..., key2: ... }) — extract object keys
    // Match .update({ key: ..., key2: ... }) — same logic
    const mutateMatch = line.match(/\.(insert|update)\(\{/);
    if (mutateMatch) {
      // Extract only the content within the { ... } of the call, not subsequent code.
      // Join forward lines and find the balanced closing brace.
      const block = lines.slice(i, Math.min(i + 15, lines.length)).join('\n');
      const braceStart = block.indexOf('{');
      if (braceStart >= 0) {
        let depth = 0;
        let braceEnd = -1;
        for (let j = braceStart; j < block.length; j++) {
          if (block[j] === '{') depth++;
          else if (block[j] === '}') { depth--; if (depth === 0) { braceEnd = j; break; } }
        }
        const objBody = braceEnd > 0 ? block.substring(braceStart + 1, braceEnd) : block.substring(braceStart + 1);
        const keyMatches = objBody.matchAll(/(\w+)\s*:/g);
        for (const km of keyMatches) {
          const key = km[1];
          if (JS_NOISE_WORDS.has(key)) continue;
          if (/^[a-z_]+$/.test(key)) {
            refs.push({ table: currentTable, column: key, file: filePath, line: lineNum, context: `.${mutateMatch[1]}({ ${key}: ... })` });
          }
        }
      }
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('schema alignment', () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const srcDir = join(testDir, '..', 'src');
  const tsFiles = getAllTsFiles(srcDir);
  const allRefs: ColumnRef[] = [];

  for (const file of tsFiles) {
    allRefs.push(...extractColumnRefs(file));
  }

  // Group by table
  const refsByTable = new Map<string, ColumnRef[]>();
  for (const ref of allRefs) {
    if (!refsByTable.has(ref.table)) refsByTable.set(ref.table, []);
    refsByTable.get(ref.table)!.push(ref);
  }

  it('found column references to check (sanity check)', () => {
    expect(allRefs.length).toBeGreaterThan(50);
    expect(refsByTable.size).toBeGreaterThan(3);
  });

  // Generate one test per table
  for (const [table, refs] of refsByTable) {
    it(`all ${table} column references exist in schema`, () => {
      const knownColumns = SCHEMA[table];
      if (!knownColumns) {
        throw new Error(`Unknown table "${table}" referenced in code. Add it to SCHEMA in schema-alignment.test.ts`);
      }

      const invalid: string[] = [];
      for (const ref of refs) {
        if (!knownColumns.includes(ref.column)) {
          const relPath = ref.file.replace(/\\/g, '/').replace(/.*\/src\//, 'src/');
          invalid.push(`  ${relPath}:${ref.line} — column "${ref.column}" not in ${table} schema\n    ${ref.context}`);
        }
      }

      if (invalid.length > 0) {
        throw new Error(
          `Found ${invalid.length} references to nonexistent columns on "${table}":\n${invalid.join('\n')}`
        );
      }
    });
  }

  it('schema definition covers all tables referenced in code', () => {
    const unknownTables = [...refsByTable.keys()].filter(t => !SCHEMA[t]);
    expect(unknownTables).toEqual([]);
  });
});
