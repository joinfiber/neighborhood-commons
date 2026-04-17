/**
 * Timezone recomposition tests — S6 (PATCH timezone corruption)
 *
 * The bug: when a PATCH updated `event_timezone` without a new `start`,
 * the code stored the old UTC instant under a new tz label — silently
 * shifting the event's wall-clock time by the tz offset delta. For a
 * bar-owner moving a recurring listing from NY to Chicago, the event
 * appears at 6pm instead of 7pm.
 *
 * The fix decomposes the stored UTC instant in the OLD tz, then
 * recomposes in the NEW tz. These tests lock in that behavior.
 */

import { describe, it, expect } from 'vitest';
import { fromTimestamptz, toTimestamptz } from '../src/lib/event-operations.js';

describe('fromTimestamptz', () => {
  it('extracts local date + time from a UTC ISO instant', () => {
    // 2026-04-15 19:00:00 in America/New_York (EDT, UTC-4) = 2026-04-15T23:00:00Z
    const result = fromTimestamptz('2026-04-15T23:00:00Z', 'America/New_York');
    expect(result.date).toBe('2026-04-15');
    expect(result.time).toBe('19:00');
  });

  it('handles the other side of the date line correctly', () => {
    // 2026-04-15 23:00 NY = 2026-04-16T03:00Z
    const result = fromTimestamptz('2026-04-16T03:00:00Z', 'America/New_York');
    expect(result.date).toBe('2026-04-15');
    expect(result.time).toBe('23:00');
  });

  it('handles UTC timezone without shifting', () => {
    const result = fromTimestamptz('2026-04-15T19:00:00Z', 'UTC');
    expect(result.date).toBe('2026-04-15');
    expect(result.time).toBe('19:00');
  });

  it('handles positive UTC offset (Tokyo)', () => {
    // 2026-04-15 19:00 Tokyo (UTC+9) = 2026-04-15T10:00Z
    const result = fromTimestamptz('2026-04-15T10:00:00Z', 'Asia/Tokyo');
    expect(result.date).toBe('2026-04-15');
    expect(result.time).toBe('19:00');
  });
});

describe('toTimestamptz', () => {
  it('composes a Postgres-compatible timestamptz string', () => {
    const ts = toTimestamptz('2026-04-15', '19:00', 'America/New_York');
    expect(ts).toBe('2026-04-15 19:00:00 America/New_York');
  });

  it('normalizes HH:MM to HH:MM:SS', () => {
    expect(toTimestamptz('2026-04-15', '07:30', 'UTC')).toBe('2026-04-15 07:30:00 UTC');
  });

  it('passes through HH:MM:SS unchanged', () => {
    expect(toTimestamptz('2026-04-15', '07:30:45', 'UTC')).toBe('2026-04-15 07:30:45 UTC');
  });
});

// ---------------------------------------------------------------------------
// Roundtrip semantics — the core of the S6 fix
// ---------------------------------------------------------------------------
//
// After PR 3, a timezone-only PATCH performs:
//   1. (date, time) = fromTimestamptz(existing.event_at, oldTz)
//   2. new event_at = toTimestamptz(date, time, newTz)
//
// This must preserve the *wall-clock* time: 7pm NY → 7pm Chicago (which is
// a DIFFERENT UTC instant than the original 7pm NY).
// ---------------------------------------------------------------------------

describe('tz-change recomposition (wall-clock preservation)', () => {
  it('moves 7pm NY → 7pm Chicago (wall-clock stable, UTC shifts by 1 hour)', () => {
    // Existing: 2026-04-15 19:00 NY (EDT, UTC-4) = 2026-04-15T23:00:00Z
    const existingUtc = '2026-04-15T23:00:00Z';
    const oldTz = 'America/New_York';
    const newTz = 'America/Chicago';

    // Decompose in old tz
    const { date, time } = fromTimestamptz(existingUtc, oldTz);
    expect(date).toBe('2026-04-15');
    expect(time).toBe('19:00');

    // Recompose in new tz
    const recomposed = toTimestamptz(date, time, newTz);
    expect(recomposed).toBe('2026-04-15 19:00:00 America/Chicago');

    // And the recomposed string, when parsed back, should give us 7pm Chicago
    // (which is 2026-04-16T00:00:00Z — midnight UTC).
    // We verify this by re-decomposing in the new tz.
    const reparsed = fromTimestamptz(new Date(recomposed.replace(' America/Chicago', '-05:00')).toISOString(), newTz);
    expect(reparsed.time).toBe('19:00');
  });

  it('moves 7pm NY → 7pm Tokyo (UTC shifts by 13 hours)', () => {
    const existingUtc = '2026-04-15T23:00:00Z';
    const { date, time } = fromTimestamptz(existingUtc, 'America/New_York');
    const recomposed = toTimestamptz(date, time, 'Asia/Tokyo');
    expect(recomposed).toBe('2026-04-15 19:00:00 Asia/Tokyo');
    // 2026-04-15 19:00 Tokyo = 2026-04-15T10:00Z (UTC is 9 hours behind Tokyo)
  });

  it('roundtrips UTC identically', () => {
    const utc = '2026-04-15T19:00:00Z';
    const { date, time } = fromTimestamptz(utc, 'UTC');
    const recomposed = toTimestamptz(date, time, 'UTC');
    expect(recomposed).toBe('2026-04-15 19:00:00 UTC');
  });
});

// ---------------------------------------------------------------------------
// DST boundary correctness — the audit's specific concern
// ---------------------------------------------------------------------------

describe('DST boundary behavior', () => {
  it('handles a post-DST date correctly (NY in EST vs EDT)', () => {
    // 2026-01-15 19:00 NY is EST (UTC-5), so UTC = 00:00 next day
    const winterResult = fromTimestamptz('2026-01-16T00:00:00Z', 'America/New_York');
    expect(winterResult.date).toBe('2026-01-15');
    expect(winterResult.time).toBe('19:00');

    // 2026-07-15 19:00 NY is EDT (UTC-4), so UTC = 23:00 same day
    const summerResult = fromTimestamptz('2026-07-15T23:00:00Z', 'America/New_York');
    expect(summerResult.date).toBe('2026-07-15');
    expect(summerResult.time).toBe('19:00');
  });

  it('a tz-change from NY-EDT to NY-itself preserves the same wall-clock', () => {
    // Degenerate case: no tz change. Should be a no-op semantically.
    const existingUtc = '2026-04-15T23:00:00Z';
    const { date, time } = fromTimestamptz(existingUtc, 'America/New_York');
    const recomposed = toTimestamptz(date, time, 'America/New_York');
    expect(recomposed).toBe('2026-04-15 19:00:00 America/New_York');
  });
});
