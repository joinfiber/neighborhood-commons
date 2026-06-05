/**
 * Migration 102 acceptance test
 *
 * Tests against the migration SQL file (not a live DB — out of scope for unit
 * tests, same posture as migration-085.test.ts / migration-100.test.ts). Locks
 * in the promises of the one-shot backfill that repairs the rows migration
 * 085's no-op verification branch missed:
 *
 *   - it promotes `seeded` → `self_asserted` (the verified-first-party state)
 *   - it gates on an ACTIVE verification, using the real status value
 *     ('active', not the non-existent 'verified' that migration 085 used and
 *     that made its verification branch a no-op)
 *   - it restricts to rows currently at `seeded` — which is what makes it
 *     idempotent and keeps it from downgrading a proxied / witnessed /
 *     already-self_asserted row
 *   - it changes ONLY `method` — ownership and verification state are untouched
 *
 * If migration 102 is rewritten, this test forces the rewrite to keep its
 * promises — making any retraction visible at review time.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '102_promote_verified_seeded_orgs.sql'),
  'utf-8',
);

describe('Migration 102 — promote verified-but-seeded orgs to self_asserted', () => {
  it('promotes seeded to self_asserted (the verified-first-party state)', () => {
    expect(MIGRATION).toMatch(
      /UPDATE organizations[\s\S]*?SET method = 'self_asserted'[\s\S]*?WHERE[\s\S]*?method = 'seeded'/i,
    );
  });

  it('gates on an active verification, using the real status value', () => {
    expect(MIGRATION).toMatch(
      /EXISTS\s*\([\s\S]*?organization_verifications[\s\S]*?status = 'active'/i,
    );
    // Guard against regressing to migration 085's no-op 'verified' status,
    // which the active/revoked enum never contains — the whole reason this
    // backfill has to exist.
    expect(MIGRATION).not.toMatch(/status = 'verified'/i);
  });

  it('restricts to rows currently at seeded (idempotent; never downgrades a non-seeded method)', () => {
    expect(MIGRATION).toMatch(/WHERE\s+o\.method = 'seeded'/i);
  });

  it('changes only `method` — no other column is written', () => {
    // Exactly one SET, and it sets method. Ownership links and verification
    // state are explicitly out of scope for this correction.
    const sets = MIGRATION.match(/\bSET\s+\w+/gi) || [];
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatch(/SET\s+method/i);
  });

  it('wraps the change in a single transaction', () => {
    expect(MIGRATION).toMatch(/^\s*BEGIN\s*;/m);
    expect(MIGRATION).toMatch(/\bCOMMIT\s*;\s*$/m);
  });
});
