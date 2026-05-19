/**
 * Migration 088 acceptance test
 *
 * Verifies the events.relevant_until generated column is shaped the way
 * the doctrine promises. Tests against the migration SQL file directly
 * — no live DB. If the migration is ever rewritten, this test forces
 * the rewrite to keep its promises.
 *
 * Background: closes the pagination bug where the SQL filter (event_at
 * >= now-3h, ordered ascending) disagreed with the JS post-filter
 * (drop events whose end_time is past), causing empty pages at small
 * limits despite a high meta.total.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '088_events_relevant_until.sql'),
  'utf-8',
);

describe('Migration 088 — events.relevant_until generated column', () => {
  it('is idempotent — IF NOT EXISTS on the column + index', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS relevant_until/i);
    expect(MIGRATION).toMatch(/CREATE INDEX IF NOT EXISTS idx_events_relevant_until/i);
  });

  it('declares relevant_until as STORED generated', () => {
    // STORED is required for index-ability. Postgres only supports STORED
    // generated columns as of v17 anyway, but be explicit about the intent.
    expect(MIGRATION).toMatch(/GENERATED ALWAYS AS[\s\S]*?STORED/i);
  });

  it("uses the doctrine's expression: open_window → COALESCE(end_time, event_at + 3h); else event_at", () => {
    // Strict-start events are relevant until event_at; open-window events
    // are relevant until end_time, or 3h after event_at if end_time is null.
    // The "+ 3h" path round-trips through plain timestamp via AT TIME ZONE 'UTC'
    // to satisfy Postgres's IMMUTABLE requirement on generated columns.
    expect(MIGRATION).toMatch(/CASE\s+WHEN open_window THEN COALESCE\(\s*end_time,\s+\(\(event_at AT TIME ZONE 'UTC'\) \+ interval '3 hours'\) AT TIME ZONE 'UTC'\s*\)\s+ELSE event_at\s+END/i);
  });

  it("works around the timestamptz + interval STABLE restriction via AT TIME ZONE 'UTC' round-trip", () => {
    expect(MIGRATION).toMatch(/AT TIME ZONE 'UTC'/);
    expect(MIGRATION).toMatch(/IMMUTABLE/i); // commented explanation
  });

  it('indexes relevant_until for the WHERE/ORDER BY query pattern', () => {
    expect(MIGRATION).toMatch(/CREATE INDEX IF NOT EXISTS idx_events_relevant_until\s+ON events\(relevant_until\)/i);
  });

  it('comments on the column explaining its purpose', () => {
    expect(MIGRATION).toMatch(/COMMENT ON COLUMN events\.relevant_until/i);
  });
});
