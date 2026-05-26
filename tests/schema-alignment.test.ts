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
    'id', 'name', 'rate_limit_per_hour', 'created_at',
    'key_hash', 'key_prefix', 'contact_email', 'status', 'last_used_at', 'contributor_tier',
    'url', 'is_admin',
    // Added in migration 072 (1.0.0 verification system)
    'brand_config', 'verification_authority',
    // Added in migration 075 (self-service service-key registration)
    'activated_at', 'application_metadata',
    // Added in migration 078 (v2 — witnessed-evidence authority path)
    'witness_authority',
    // Added in migration 084 (v2.1 — trusted-tenant pattern; one tenant portal_account per service key)
    'tenant_account_id',
    // Added in migration 086 (3.1 — contributor profiles + developer dashboard)
    'contributor_profile_id', 'mfa_secret_encrypted', 'mfa_enrolled_at', 'mfa_backup_codes_hashed',
    // Added in migration 087 (PR B — developer self-service witness-authority request)
    'witness_authority_requested_at',
    // Added in migration 091 (caller-set proxied authority path)
    'proxy_authority',
    // Added in migration 094 (MFA step-up throttle + one-time TOTP)
    'mfa_failed_attempts', 'mfa_locked_until', 'mfa_last_totp_step',
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
    'open_window', 'tags', 'wheelchair_accessible', 'capacity', 'rsvp',
    // Provenance — migration 085 normalized source_method values and dropped source_publisher.
    'source_method', 'source_feed_url', 'external_id',
    'source_contributor_url', 'source_contributor_name',
    'first_party',
    'group_id',
    'tmdb_id',
    // Added in migration 067 (1.0.0 organizer + place FKs)
    'location_place_id', 'organizer_org_id',
    // Added in migration 078 (v2 — internal dedup mechanism)
    'match_key',
    // Added in migration 086 (3.1 — contributor profiles snapshot at write time)
    'contributor_profile_id',
    // Added in migration 088 — generated column for relevance ordering / filtering
    'relevant_until',
    'created_at', 'updated_at',
  ],
  event_series: [
    'id', 'creator_account_id', 'recurrence', 'base_event_data',
    'created_at', 'updated_at', 'user_id', 'recurrence_rule', 'ends_at',
    // Migration 089: series identity
    'organizer_org_id', 'name', 'slug', 'description', 'cover_image_url',
  ],
  // Narrowed in migration 082 — business-profile columns moved to organizations.
  // Operational columns only: identity, claim status, status, timestamps.
  portal_accounts: [
    'id', 'auth_user_id', 'email',
    'status', 'claimed_at', 'claimed_by',
    'created_at', 'updated_at', 'last_login_at',
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
  category_mappings: [
    'id', 'source_term', 'canonical_category', 'confidence',
    'created_by_account_id', 'created_at',
  ],
  contribution_batches: [
    'id', 'contributor_account_id', 'status', 'file_name', 'file_hash',
    'event_timezone', 'column_mapping', 'total_rows', 'valid_rows', 'error_rows', 'created_events',
    'reviewer_notes', 'reviewed_at', 'reviewed_by',
    'created_at', 'updated_at',
  ],
  contribution_rows: [
    'id', 'batch_id', 'row_number', 'raw_data', 'mapped_data',
    'category_source_term', 'category_mapped_to', 'validation_errors',
    'status', 'created_event_id', 'created_at',
  ],
  category_proposals: [
    'id', 'proposed_name', 'justification', 'fallback_category',
    'contributor_account_id', 'batch_id', 'status', 'created_at',
  ],
  // ----- v2 type system (migrations 064-073 set up; 078-082 finalize) -----
  places: [
    'id', 'google_place_id', 'name',
    'street_address', 'address_locality', 'address_region', 'postal_code', 'address_country',
    'latitude', 'longitude', 'region_id',
    // Added in migration 078 (v2 — OSM-sourced categorization)
    'place_categories', 'category_source', 'category_reviewed_at', 'category_reviewed_by',
    'created_at', 'updated_at',
  ],
  // Migration 082 dropped `kind`; replaced by `tags` + `commercial` (added in 078).
  // Migration 085 added `method` (standard provenance vocabulary).
  organizations: [
    'id', 'slug', 'name', 'legal_name',
    'description', 'url', 'logo_url', 'image_url', 'telephone', 'email',
    'same_as', 'keywords', 'opening_hours_specification',
    'primary_place_id', 'owner_account_id',
    // Added in migration 078 (v2)
    'tags', 'commercial',
    // Added in migration 085 (provenance doctrine)
    'method',
    // Added in migration 090 (contributor attribution)
    'contributor_profile_id',
    'created_at', 'updated_at',
  ],
  organization_places: [
    'organization_id', 'place_id', 'is_primary', 'relationship', 'created_at',
  ],
  // Migration 082 dropped person_id; performer_name added as free-form fallback.
  event_performers: [
    'id', 'event_id', 'organization_id', 'performer_name',
    'performer_role', 'position', 'created_at',
  ],
  // Migration 085 added `method` (standard provenance vocabulary; only
  // 'self_asserted' is currently valid for broadcasts).
  broadcasts: [
    'id', 'organization_id', 'place_id', 'message',
    'expires_at', 'status', 'retracted_at', 'source', 'method', 'created_at',
  ],
  // Migration 082 dropped curator_person_id; curator_org_id is now NOT NULL.
  // Migration 085 added `method` (standard provenance vocabulary; only
  // 'self_asserted' is currently valid for lists).
  lists: [
    'id', 'slug', 'name', 'description',
    'curator_org_id', 'method',
    'created_at', 'updated_at',
  ],
  list_items: [
    'id', 'list_id', 'position',
    'event_id', 'organization_id', 'place_id',
    'curator_note', 'added_at',
  ],
  // V2 verification storage. Replaces account_verified_identifiers (dropped in 082).
  organization_verifications: [
    'id', 'organization_id',
    'identifier_type', 'identifier_value',
    'method', 'evidence', 'verified_at',
    'approved_by_app', 'approved_by_key',
    'status', 'revoked_at', 'revoked_reason',
    'created_at',
  ],
  verification_challenges: [
    'id', 'target_type', 'target_id',
    'identifier_type', 'identifier_value',
    'code_hash', 'expires_at', 'consumed_at', 'attempts',
    'brand_key_id', 'created_at',
  ],
  verification_pending_reviews: [
    'id', 'target_type', 'target_id',
    'identifier_type', 'identifier_value',
    'method', 'submitted_by_key', 'evidence',
    'status', 'reviewed_by_key', 'reviewed_at', 'decision_reason',
    'created_at',
  ],
  api_key_organization_links: [
    'api_key_id', 'organization_id', 'created_at',
  ],
  approved_domains: [
    'domain', 'added_by', 'reason', 'added_at',
  ],
  domain_approval_requests: [
    'id', 'domain', 'requested_via_api_key', 'requested_url', 'event_context',
    'status', 'requested_at', 'reviewed_at', 'reviewed_by',
  ],
  // Restored by migration 083 (the 082 drop was incorrect — /v1/service/register
  // and lib/developer-otp.ts both still depend on it).
  developer_otps: [
    'id', 'email', 'code', 'expires_at', 'created_at',
  ],
  // ----- Contributor profiles + developer-dashboard primitives (migration 086, 3.1) -----
  contributor_profiles: [
    'id', 'slug', 'name', 'tagline', 'description', 'who_its_for',
    'app_url', 'logo_url', 'category', 'status',
    'created_at', 'updated_at',
  ],
  developer_sessions: [
    'id', 'api_key_id', 'token_hash',
    'mfa_verified_at', 'last_seen_at', 'expires_at', 'created_at',
  ],
  magic_login_tokens: [
    'id', 'email', 'token_hash', 'expires_at', 'consumed_at', 'created_at',
  ],
  pending_registrations: [
    'email', 'app_name', 'tagline', 'description', 'who_its_for',
    'app_url', 'logo_url', 'category',
    'what_youre_building', 'verification_process',
    'expires_at', 'created_at',
  ],
  // ----- Tables dropped in v2 (migration 082): -----
  //   persons                        — solo operators are now organizations
  //   account_verified_identifiers   — replaced by organization_verifications
  //   groups, group_venues           — legacy; data lives on organizations + organization_places
  //   api_key_account_links          — replaced by api_key_organization_links
  //
  // Ingestion tables (newsletter_sources, newsletter_emails, event_candidates,
  // feed_sources) were dropped by migration 060. Ingestion now lives in Fiber/Studio.
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
  'message', 'registered', 'frequency',
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

    // Reset on chain-terminator: a closing paren ending in `;` typically
    // marks the end of an inner await chain (e.g., a subquery built and
    // resolved inline). Subsequent calls on outer-scope variables (`query`)
    // would otherwise pick up the inner subquery's table context.
    if (/^\s*\)?\s*;\s*$/.test(line) || /\)\s*;\s*$/.test(line.trimEnd())) {
      // Only reset if we're NOT in the middle of a chained call (next line
      // could continue with `.something(...)`). Look ahead one line.
      const next = (lines[i + 1] || '').trimStart();
      if (!next.startsWith('.')) {
        currentTable = null;
        continue;
      }
    }

    // Match .select('col1, col2, ...') — extract individual column names
    const selectMatch = line.match(/\.select\(['"]([^'"]+)['"]/);
    if (selectMatch) {
      // Strip joined table references: "region:regions(name, slug)" and "group:groups(slug, name)" → ""
      const selectStr = selectMatch[1].replace(/\w+(?::\w+)?\s*\([^)]*\)/g, '');
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
