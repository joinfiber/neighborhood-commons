/**
 * Recurrence Utilities — Tests
 *
 * Tests for recurrence parsing, formatting, date generation, and
 * duration-to-instance-count conversion. These are the most complex
 * pure logic in the portal — date math, ordinal weekday calculation,
 * and multi-day pattern expansion.
 */

import { describe, it, expect } from 'vitest';
import {
  getOrdinalWeekday,
  toOrdinalRecurrence,
  parseOrdinalRecurrence,
  toWeeklyDaysRecurrence,
  parseWeeklyDays,
  formatWeeklyDaysLabel,
  formatRecurrenceLabel,
  getNextDates,
  durationToInstanceCount,
} from './recurrence';

// =============================================================================
// getOrdinalWeekday
// =============================================================================

describe('getOrdinalWeekday', () => {
  it('detects 1st Thursday', () => {
    // 2026-01-01 is a Thursday, and it's the 1st Thursday of January
    const result = getOrdinalWeekday('2026-01-01');
    expect(result).not.toBeNull();
    expect(result!.ordinal).toBe(1);
    expect(result!.dayName).toBe('thursday');
    expect(result!.label).toContain('1st');
    expect(result!.label).toContain('Thu');
  });

  it('detects 3rd Monday', () => {
    // 2026-01-19 is the 3rd Monday of January 2026
    const result = getOrdinalWeekday('2026-01-19');
    expect(result).not.toBeNull();
    expect(result!.ordinal).toBe(3);
    expect(result!.dayName).toBe('monday');
  });

  it('detects 5th day when it exists', () => {
    // 2026-01-29 is a Thursday, the 5th Thursday of January 2026
    const result = getOrdinalWeekday('2026-01-29');
    expect(result).not.toBeNull();
    expect(result!.ordinal).toBe(5);
  });

  it('returns null for invalid date', () => {
    expect(getOrdinalWeekday('not-a-date')).toBeNull();
  });
});

// =============================================================================
// toOrdinalRecurrence / parseOrdinalRecurrence
// =============================================================================

describe('ordinal recurrence roundtrip', () => {
  it('builds and parses ordinal weekday pattern', () => {
    const str = toOrdinalRecurrence(2, 'wednesday');
    expect(str).toBe('ordinal_weekday:2:wednesday');

    const parsed = parseOrdinalRecurrence(str);
    expect(parsed).not.toBeNull();
    expect(parsed!.ordinal).toBe(2);
    expect(parsed!.dayName).toBe('wednesday');
  });

  it('returns null for non-ordinal patterns', () => {
    expect(parseOrdinalRecurrence('weekly')).toBeNull();
    expect(parseOrdinalRecurrence('none')).toBeNull();
    expect(parseOrdinalRecurrence('ordinal_weekday:6:monday')).toBeNull(); // 6 is out of range
  });
});

// =============================================================================
// toWeeklyDaysRecurrence / parseWeeklyDays
// =============================================================================

describe('weekly days recurrence roundtrip', () => {
  it('builds and parses weekly days pattern', () => {
    const str = toWeeklyDaysRecurrence([1, 3, 5]); // Mon, Wed, Fri
    expect(str).toBe('weekly_days:mon,wed,fri');

    const parsed = parseWeeklyDays(str);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual([1, 3, 5]);
  });

  it('sorts day indices', () => {
    const str = toWeeklyDaysRecurrence([5, 1, 3]); // unsorted
    expect(str).toBe('weekly_days:mon,wed,fri'); // sorted output
  });

  it('returns null for non-weekly-days patterns', () => {
    expect(parseWeeklyDays('weekly')).toBeNull();
    expect(parseWeeklyDays('none')).toBeNull();
  });
});

// =============================================================================
// formatWeeklyDaysLabel
// =============================================================================

describe('formatWeeklyDaysLabel', () => {
  it('shows range for consecutive days', () => {
    expect(formatWeeklyDaysLabel([1, 2, 3, 4])).toBe('Mon-Thu');
  });

  it('shows comma-separated for non-consecutive days', () => {
    expect(formatWeeklyDaysLabel([1, 3, 5])).toBe('Mon, Wed, Fri');
  });

  it('shows single day', () => {
    expect(formatWeeklyDaysLabel([4])).toBe('Thu');
  });

  it('returns empty for empty array', () => {
    expect(formatWeeklyDaysLabel([])).toBe('');
  });
});

// =============================================================================
// formatRecurrenceLabel
// =============================================================================

describe('formatRecurrenceLabel', () => {
  it('formats basic patterns', () => {
    expect(formatRecurrenceLabel('none')).toBe('One-time');
    expect(formatRecurrenceLabel('daily')).toBe('Daily');
    expect(formatRecurrenceLabel('weekly')).toBe('Weekly');
    expect(formatRecurrenceLabel('biweekly')).toBe('Every 2 weeks');
    expect(formatRecurrenceLabel('monthly')).toBe('Monthly');
  });

  it('formats weekly_days patterns', () => {
    expect(formatRecurrenceLabel('weekly_days:mon,wed,fri')).toBe('Mon, Wed, Fri');
    expect(formatRecurrenceLabel('weekly_days:tue,wed,thu,fri')).toBe('Tue-Fri');
  });

  it('formats ordinal weekday patterns', () => {
    expect(formatRecurrenceLabel('ordinal_weekday:3:thursday')).toBe('Every 3rd Thu');
    expect(formatRecurrenceLabel('ordinal_weekday:1:monday')).toBe('Every 1st Mon');
  });

  it('returns raw string for unknown patterns', () => {
    expect(formatRecurrenceLabel('unknown_pattern')).toBe('unknown_pattern');
  });
});

// =============================================================================
// getNextDates
// =============================================================================

describe('getNextDates', () => {
  it('generates weekly dates', () => {
    const dates = getNextDates('2026-01-01', 'weekly', 3);
    expect(dates).toHaveLength(3);
    // Each date should be 7 days apart
    expect(dates[0]).toContain('Jan');
    expect(dates[1]).toContain('Jan');
    expect(dates[2]).toContain('Jan');
  });

  it('generates daily dates', () => {
    const dates = getNextDates('2026-01-01', 'daily', 3);
    expect(dates).toHaveLength(3);
  });

  it('generates biweekly dates', () => {
    const dates = getNextDates('2026-01-01', 'biweekly', 3);
    expect(dates).toHaveLength(3);
  });

  it('generates monthly dates', () => {
    const dates = getNextDates('2026-01-15', 'monthly', 3);
    expect(dates).toHaveLength(3);
    expect(dates[0]).toContain('Feb');
    expect(dates[1]).toContain('Mar');
    expect(dates[2]).toContain('Apr');
  });

  it('generates weekly_days dates', () => {
    const dates = getNextDates('2026-01-01', 'weekly_days:mon,fri', 4);
    expect(dates).toHaveLength(4);
  });

  it('generates ordinal weekday dates', () => {
    // 2026-01-01 is Thursday, get next 3 occurrences of ordinal weekday
    const dates = getNextDates('2026-01-01', 'ordinal_weekday:1:thursday', 3);
    expect(dates).toHaveLength(3);
    expect(dates[0]).toContain('Feb');
    expect(dates[1]).toContain('Mar');
    expect(dates[2]).toContain('Apr');
  });

  it('returns empty for invalid date', () => {
    expect(getNextDates('not-a-date', 'weekly', 3)).toEqual([]);
  });

  it('returns empty for none recurrence', () => {
    expect(getNextDates('2026-01-01', 'none', 3)).toEqual([]);
  });
});

// =============================================================================
// durationToInstanceCount
// =============================================================================

describe('durationToInstanceCount', () => {
  it('converts weekly duration presets', () => {
    expect(durationToInstanceCount('weekly', 1)).toBe(4);
    expect(durationToInstanceCount('weekly', 3)).toBe(13);
    expect(durationToInstanceCount('weekly', 6)).toBe(26);
  });

  it('converts biweekly duration presets', () => {
    expect(durationToInstanceCount('biweekly', 1)).toBe(2);
    expect(durationToInstanceCount('biweekly', 3)).toBe(6);
    expect(durationToInstanceCount('biweekly', 6)).toBe(13);
  });

  it('converts monthly duration', () => {
    expect(durationToInstanceCount('monthly', 3)).toBe(3);
    expect(durationToInstanceCount('monthly', 6)).toBe(6);
    expect(durationToInstanceCount('monthly', 1)).toBe(2); // minimum 2
  });

  it('returns 0 for ongoing (unlimited)', () => {
    expect(durationToInstanceCount('weekly', 0)).toBe(0);
    expect(durationToInstanceCount('biweekly', 0)).toBe(0);
    expect(durationToInstanceCount('monthly', 0)).toBe(0);
  });
});
