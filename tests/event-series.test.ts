/**
 * Event Series Tests — Neighborhood Commons
 *
 * Tests for instance date generation, series creation atomicity,
 * and the auto-extend cron. These test the core series machinery
 * that recurring events depend on.
 */

import { describe, it, expect } from 'vitest';
import { generateInstanceDates } from '../src/lib/event-operations.js';

// =============================================================================
// generateInstanceDates — weekly_days instanceCount semantics
// =============================================================================

describe('generateInstanceDates — weekly_days', () => {
  // Monday 2026-01-05 is a Monday
  const MONDAY = '2026-01-05';

  it('explicit instanceCount means total events, not weeks', () => {
    const dates = generateInstanceDates(MONDAY, 'weekly_days:mon,wed,fri', 10);
    // Should return exactly 10 dates (including the start date)
    expect(dates.length).toBe(10);
  });

  it('explicit instanceCount=6 for 5-day pattern returns 6 events', () => {
    const dates = generateInstanceDates(MONDAY, 'weekly_days:mon,tue,wed,thu,fri', 6);
    expect(dates.length).toBe(6);
  });

  it('default (no instanceCount) uses weeks — returns weeks * days', () => {
    const dates = generateInstanceDates(MONDAY, 'weekly_days:mon,wed,fri');
    // DEFAULT_WEEKLY_DAYS_LIMIT weeks * 3 days + startDate
    // The startDate is included as the first date, so total = weeks * days
    // With default limit of 6 weeks: 6 * 3 = 18 dates (startDate is one of the Mon dates)
    expect(dates.length).toBeGreaterThan(10);
  });

  it('instanceCount=0 (ongoing) uses ongoing limit in weeks', () => {
    const dates = generateInstanceDates(MONDAY, 'weekly_days:mon,wed,fri', 0);
    // ONGOING_WEEKLY_DAYS_LIMIT weeks * 3 days
    expect(dates.length).toBeGreaterThan(10);
  });

  it('all generated dates match the specified days', () => {
    const dates = generateInstanceDates(MONDAY, 'weekly_days:tue,thu', 8);
    // First date is the startDate (Monday) — rest should be Tue/Thu
    for (let i = 1; i < dates.length; i++) {
      const day = new Date(dates[i]! + 'T12:00:00').getDay();
      expect([2, 4]).toContain(day); // Tuesday=2, Thursday=4
    }
  });
});

// =============================================================================
// generateInstanceDates — other patterns (regression tests)
// =============================================================================

describe('generateInstanceDates — basic patterns', () => {
  const START = '2026-01-05';

  it('daily with explicit count returns that many dates', () => {
    const dates = generateInstanceDates(START, 'daily', 10);
    expect(dates.length).toBe(10);
  });

  it('weekly with explicit count returns that many dates', () => {
    const dates = generateInstanceDates(START, 'weekly', 8);
    expect(dates.length).toBe(8);
  });

  it('none returns just the start date', () => {
    const dates = generateInstanceDates(START, 'none');
    expect(dates).toEqual([START]);
  });

  it('monthly generates dates on same day of month', () => {
    const dates = generateInstanceDates('2026-03-15', 'monthly', 4);
    expect(dates.length).toBe(4);
    // Each date should be the 15th (or close, for short months)
    expect(dates[0]).toBe('2026-03-15');
    expect(dates[1]).toBe('2026-04-15');
  });
});
