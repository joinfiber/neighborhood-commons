/**
 * Migration 085 acceptance test
 *
 * Tests against the migration SQL file (not against a live DB — that's
 * out of scope for unit tests). Verifies that the file declares the
 * concrete operations the doctrine promises:
 *
 *   - events.source_publisher is dropped
 *   - events.source_method enum is the standard provenance vocabulary
 *   - organizations.method is added with the four-value enum + seeded default
 *   - broadcasts.method and lists.method are added with self_asserted-only
 *   - Legacy source_method values are mapped to the new vocabulary
 *
 * If migration 085 is ever rewritten, this test forces the rewrite to
 * keep its promises. If we choose to retract one of these guarantees,
 * the test must be updated in the same PR — making the contract
 * change visible at review time.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '085_provenance_method_cleanup.sql'),
  'utf-8',
);

describe('Migration 085 — provenance method cleanup', () => {
  it('drops events.source_publisher', () => {
    expect(MIGRATION).toMatch(/ALTER TABLE events\s+DROP COLUMN IF EXISTS source_publisher/i);
  });

  it('maps legacy api/portal/admin/merrie values to self_asserted', () => {
    // The order matters less than the substance: every legacy value listed
    // here is collapsed into self_asserted.
    expect(MIGRATION).toMatch(/SET source_method = 'self_asserted'[\s\S]*?WHERE source_method IN \([^)]*'api'[^)]*\)/);
    expect(MIGRATION).toMatch(/SET source_method = 'self_asserted'[\s\S]*?WHERE source_method IN \([^)]*'portal'[^)]*\)/);
    expect(MIGRATION).toMatch(/SET source_method = 'self_asserted'[\s\S]*?WHERE source_method IN \([^)]*'admin'[^)]*\)/);
    expect(MIGRATION).toMatch(/SET source_method = 'self_asserted'[\s\S]*?WHERE source_method IN \([^)]*'merrie'[^)]*\)/);
  });

  it('maps legacy import/feed/csv values to proxied', () => {
    expect(MIGRATION).toMatch(/SET source_method = 'proxied'[\s\S]*?WHERE source_method IN \([^)]*'import'[^)]*\)/);
    expect(MIGRATION).toMatch(/SET source_method = 'proxied'[\s\S]*?WHERE source_method IN \([^)]*'feed'[^)]*\)/);
    expect(MIGRATION).toMatch(/SET source_method = 'proxied'[\s\S]*?WHERE source_method IN \([^)]*'csv'[^)]*\)/);
  });

  it('sets events.source_method NOT NULL with self_asserted default', () => {
    expect(MIGRATION).toMatch(/ALTER TABLE events ALTER COLUMN source_method SET NOT NULL/i);
    expect(MIGRATION).toMatch(/ALTER TABLE events ALTER COLUMN source_method SET DEFAULT 'self_asserted'/i);
  });

  it('constrains events.source_method to the three-value standard vocabulary', () => {
    expect(MIGRATION).toMatch(
      /CONSTRAINT events_source_method_check[\s\S]*?CHECK\s*\(\s*source_method IN\s*\(\s*'self_asserted'\s*,\s*'proxied'\s*,\s*'witnessed'\s*\)\s*\)/i,
    );
  });

  it('adds organizations.method with default seeded', () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE organizations[\s\S]*?ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'seeded'/i,
    );
  });

  it('constrains organizations.method to the four-value standard vocabulary (incl. seeded)', () => {
    expect(MIGRATION).toMatch(
      /CONSTRAINT organizations_method_check[\s\S]*?CHECK\s*\(\s*method IN\s*\(\s*'self_asserted'\s*,\s*'proxied'\s*,\s*'witnessed'\s*,\s*'seeded'\s*\)\s*\)/i,
    );
  });

  it('backfills verified organizations to self_asserted', () => {
    expect(MIGRATION).toMatch(
      /UPDATE organizations[\s\S]*?SET method = 'self_asserted'[\s\S]*?organization_verifications[\s\S]*?status = 'verified'/i,
    );
  });

  it('also backfills orgs with owner_account_id to self_asserted (trusted-tenant pattern)', () => {
    // The doctrine treats owner_account_id IS NOT NULL as a first-party
    // assertion signal — captures Merrie-style tenant-owned orgs that
    // haven't completed the formal verification flow but still represent
    // human-mediated assertion by an authorized agent.
    expect(MIGRATION).toMatch(
      /UPDATE organizations[\s\S]*?SET method = 'self_asserted'[\s\S]*?OR\s+o\.owner_account_id IS NOT NULL/i,
    );
  });

  it('adds broadcasts.method with default self_asserted and constrains to self_asserted only', () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE broadcasts[\s\S]*?ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'self_asserted'/i,
    );
    expect(MIGRATION).toMatch(
      /CONSTRAINT broadcasts_method_check[\s\S]*?CHECK\s*\(\s*method IN\s*\(\s*'self_asserted'\s*\)\s*\)/i,
    );
  });

  it('adds lists.method with default self_asserted and constrains to self_asserted only', () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE lists[\s\S]*?ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'self_asserted'/i,
    );
    expect(MIGRATION).toMatch(
      /CONSTRAINT lists_method_check[\s\S]*?CHECK\s*\(\s*method IN\s*\(\s*'self_asserted'\s*\)\s*\)/i,
    );
  });

  it('wraps the changes in a single transaction', () => {
    expect(MIGRATION).toMatch(/^\s*BEGIN\s*;/m);
    expect(MIGRATION).toMatch(/\bCOMMIT\s*;\s*$/m);
  });

  it('is idempotent — uses IF EXISTS / IF NOT EXISTS / DROP CONSTRAINT IF EXISTS guards', () => {
    expect(MIGRATION).toMatch(/DROP COLUMN IF EXISTS source_publisher/i);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS method/i);
    expect(MIGRATION).toMatch(/DROP CONSTRAINT IF EXISTS events_source_method_check/i);
    expect(MIGRATION).toMatch(/DROP CONSTRAINT IF EXISTS organizations_method_check/i);
  });
});
