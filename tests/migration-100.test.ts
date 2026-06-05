/**
 * Migration 100 acceptance test
 *
 * Tests against the migration SQL file (not a live DB — out of scope for unit
 * tests, same posture as migration-085.test.ts). Locks in the promises of the
 * one-shot relabel that corrects orgs wrongly stamped `self_asserted` by the
 * pre-2026-06-03 create handler:
 *
 *   - it demotes `self_asserted` → `seeded` (not to `proxied` or anything else)
 *   - it keeps the known first-party set (Merrie + Go There) by profile slug
 *   - it does NOT use owner_account_id as a guard — the bulk importer (Studio v2)
 *     owns its imports via the trusted-tenant pattern, so ownership can't
 *     distinguish a claim from an import
 *   - it spares NULL-profile rows only via the explicit allow-list shape (so
 *     pre-090 bulk imports are still demoted)
 *   - it never demotes a VERIFIED org, using the real status value ('active',
 *     not the non-existent 'verified' that migration 085 mistakenly used)
 *   - it never demotes an app-native collective, identified by the `<App>
 *     Community` name convention — NOT by a witness_authority-key link, which
 *     the bulk importer (Studio v2) also carries
 *   - it changes ONLY `method` — ownership and verification state are untouched
 *
 * If migration 100 is rewritten, this test forces the rewrite to keep its
 * safety promises — making any retraction visible at review time.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '100_relabel_seeded_org_method.sql'),
  'utf-8',
);
// Executable SQL with `-- comments` stripped. Negative assertions ("the
// migration must NOT do X") run against this so they test the logic, not the
// prose that explains why X is wrong.
const CODE = MIGRATION.replace(/--.*$/gm, '');

describe('Migration 100 — relabel wrongly-self_asserted orgs to seeded', () => {
  it('demotes self_asserted to seeded (the lifecycle-preserving target)', () => {
    expect(MIGRATION).toMatch(
      /UPDATE organizations[\s\S]*?SET method = 'seeded'[\s\S]*?WHERE[\s\S]*?method = 'self_asserted'/i,
    );
  });

  it('keeps the known first-party set (Merrie + Go There) by profile slug', () => {
    expect(MIGRATION).toMatch(
      /contributor_profile_id NOT IN\s*\([\s\S]*?contributor_profiles[\s\S]*?slug IN \('merrie-co', 'go-there-by-bike'\)/i,
    );
    // NULL-profile rows are bulk imports too — they must be demoted, which
    // means the allow-list needs the explicit `IS NULL OR NOT IN` shape (a bare
    // NOT IN would spare them).
    expect(MIGRATION).toMatch(/contributor_profile_id IS NULL\s*\n?\s*OR/i);
  });

  it('does NOT use owner_account_id as a guard (the importer owns its imports)', () => {
    // The whole point: ownership is the polluted signal here. If this matches,
    // the migration has regressed to the version that demoted ~nothing.
    expect(CODE).not.toMatch(/owner_account_id/i);
  });

  it('never demotes a verified org, using the real status value', () => {
    expect(MIGRATION).toMatch(
      /NOT EXISTS\s*\([\s\S]*?organization_verifications[\s\S]*?status = 'active'/i,
    );
    // Guard against regressing to migration 085's no-op 'verified' status,
    // which the active/revoked enum never contains.
    expect(CODE).not.toMatch(/status = 'verified'/i);
  });

  it('never demotes an app-native collective, by the `<App> Community` name convention', () => {
    expect(MIGRATION).toMatch(/name NOT ILIKE '% community'/i);
  });

  it('does NOT key collective protection off witness_authority (the importer holds it too)', () => {
    // Studio v2 has witness_authority AND bulk-imports venues, so a
    // witness-key-link guard would falsely spare every imported venue
    // (would_demote → 0). The collective signal must be the name convention.
    expect(CODE).not.toMatch(/witness_authority/i);
  });

  it('changes only `method` — no other column is written', () => {
    // Exactly one SET, and it sets method. Ownership links and verification
    // state are explicitly out of scope for this correction.
    const sets = MIGRATION.match(/\bSET\s+\w+/gi) || [];
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatch(/SET\s+method/i);
  });
});
