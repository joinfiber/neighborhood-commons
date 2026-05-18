/**
 * Migration 086 acceptance test
 *
 * Verifies the contributor-profiles foundation lands as the doctrine
 * promises (docs/onboarding-redesign.md §3). Tests against the migration
 * SQL file directly — no live DB. If the migration is ever rewritten,
 * this test forces the rewrite to keep its promises; if we retract one
 * of these guarantees, the test must be updated in the same PR.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '086_contributor_profiles.sql'),
  'utf-8',
);

describe('Migration 086 — contributor profiles + developer dashboard primitives', () => {
  it('wraps the whole migration in a single transaction', () => {
    expect(MIGRATION).toMatch(/^\s*BEGIN\s*;/m);
    expect(MIGRATION).toMatch(/\bCOMMIT\s*;\s*$/m);
  });

  it('is idempotent — uses IF NOT EXISTS / IF EXISTS guards throughout', () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS contributor_profiles/i);
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS developer_sessions/i);
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS magic_login_tokens/i);
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS pending_registrations/i);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS contributor_profile_id/i);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS mfa_secret_encrypted/i);
  });

  describe('contributor_profiles', () => {
    it('defines the table with all expected columns', () => {
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS contributor_profiles[\s\S]*?slug\s+text UNIQUE NOT NULL/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS contributor_profiles[\s\S]*?name\s+text NOT NULL/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS contributor_profiles[\s\S]*?tagline\s+text/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS contributor_profiles[\s\S]*?description\s+text/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS contributor_profiles[\s\S]*?who_its_for\s+text/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS contributor_profiles[\s\S]*?app_url\s+text/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS contributor_profiles[\s\S]*?logo_url\s+text/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS contributor_profiles[\s\S]*?status\s+text NOT NULL/i);
    });

    it('constrains status to the three valid values', () => {
      expect(MIGRATION).toMatch(
        /CONSTRAINT contributor_profiles_status_check[\s\S]*?CHECK \(status IN \('pending', 'active', 'suspended'\)\)/i,
      );
    });

    it('enforces a slug format guard', () => {
      // Slug must be lowercase alnum + hyphens, 1-100 chars.
      expect(MIGRATION).toMatch(
        /CONSTRAINT contributor_profiles_slug_format[\s\S]*?CHECK \(slug ~ '\^\[a-z0-9\]\[a-z0-9-\]\{0,99\}\$'\)/,
      );
    });

    it('has an updated_at trigger reusing the existing function', () => {
      expect(MIGRATION).toMatch(
        /CREATE TRIGGER contributor_profiles_updated_at[\s\S]*?EXECUTE FUNCTION update_updated_at/i,
      );
    });

    it('enables RLS without policies (default-deny, service-role-only access)', () => {
      expect(MIGRATION).toMatch(/ALTER TABLE contributor_profiles ENABLE ROW LEVEL SECURITY/i);
    });
  });

  describe('api_keys additions', () => {
    it('adds contributor_profile_id with SET NULL on profile delete', () => {
      expect(MIGRATION).toMatch(
        /ALTER TABLE api_keys[\s\S]*?ADD COLUMN IF NOT EXISTS contributor_profile_id uuid[\s\S]*?REFERENCES contributor_profiles\(id\)[\s\S]*?ON DELETE SET NULL/i,
      );
    });

    it('adds the three MFA columns (encrypted secret, enrolled_at, backup codes)', () => {
      expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS mfa_secret_encrypted bytea/i);
      expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS mfa_enrolled_at timestamptz/i);
      expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS mfa_backup_codes_hashed text\[\]/i);
    });
  });

  describe('events.contributor_profile_id', () => {
    it('adds the snapshot column with SET NULL on profile delete', () => {
      expect(MIGRATION).toMatch(
        /ALTER TABLE events[\s\S]*?ADD COLUMN IF NOT EXISTS contributor_profile_id uuid[\s\S]*?REFERENCES contributor_profiles\(id\)[\s\S]*?ON DELETE SET NULL/i,
      );
    });

    it('indexes the new column for cheap lookups', () => {
      expect(MIGRATION).toMatch(/CREATE INDEX IF NOT EXISTS idx_events_contributor_profile[\s\S]*?ON events\(contributor_profile_id\)/i);
    });
  });

  describe('developer_sessions', () => {
    it('defines the table with required columns and FK cascade', () => {
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS developer_sessions[\s\S]*?api_key_id\s+uuid NOT NULL REFERENCES api_keys\(id\) ON DELETE CASCADE/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS developer_sessions[\s\S]*?token_hash\s+text NOT NULL/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS developer_sessions[\s\S]*?mfa_verified_at\s+timestamptz/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS developer_sessions[\s\S]*?expires_at\s+timestamptz NOT NULL/i);
    });

    it('makes token_hash unique', () => {
      expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_sessions_token_hash/i);
    });
  });

  describe('magic_login_tokens', () => {
    it('defines the table with required columns and unique token hash', () => {
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS magic_login_tokens[\s\S]*?email\s+text NOT NULL/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS magic_login_tokens[\s\S]*?token_hash\s+text NOT NULL/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS magic_login_tokens[\s\S]*?expires_at\s+timestamptz NOT NULL/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS magic_login_tokens[\s\S]*?consumed_at\s+timestamptz/i);
      expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_magic_login_tokens_token_hash/i);
    });
  });

  describe('pending_registrations', () => {
    it('keys on normalized email and holds the registration form fields', () => {
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS pending_registrations[\s\S]*?email\s+text PRIMARY KEY/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS pending_registrations[\s\S]*?app_name\s+text NOT NULL/i);
      // Operator-review fields
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS pending_registrations[\s\S]*?what_youre_building\s+text/i);
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS pending_registrations[\s\S]*?verification_process\s+text/i);
      // TTL
      expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS pending_registrations[\s\S]*?expires_at\s+timestamptz NOT NULL/i);
    });
  });

  it('enables RLS on all four new tables (default-deny operational data)', () => {
    expect(MIGRATION).toMatch(/ALTER TABLE contributor_profiles ENABLE ROW LEVEL SECURITY/i);
    expect(MIGRATION).toMatch(/ALTER TABLE developer_sessions ENABLE ROW LEVEL SECURITY/i);
    expect(MIGRATION).toMatch(/ALTER TABLE magic_login_tokens ENABLE ROW LEVEL SECURITY/i);
    expect(MIGRATION).toMatch(/ALTER TABLE pending_registrations ENABLE ROW LEVEL SECURITY/i);
  });
});
