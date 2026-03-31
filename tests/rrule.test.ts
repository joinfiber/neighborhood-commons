/**
 * RRULE Parser Tests
 *
 * Verifies that fromRRule() correctly translates RRULE strings to the
 * internal recurrence format, extracts COUNT, and rejects unsupported patterns.
 */

import { describe, it, expect } from 'vitest';
import { fromRRule } from '../src/lib/rrule.js';
import { toRRule } from '../src/lib/event-transform.js';

// =============================================================================
// SUPPORTED PATTERNS
// =============================================================================

describe('fromRRule', () => {
  describe('basic frequencies', () => {
    it('FREQ=DAILY → daily', () => {
      expect(fromRRule('FREQ=DAILY')).toEqual({ recurrence: 'daily' });
    });

    it('FREQ=WEEKLY → weekly', () => {
      expect(fromRRule('FREQ=WEEKLY')).toEqual({ recurrence: 'weekly' });
    });

    it('FREQ=WEEKLY;INTERVAL=2 → biweekly', () => {
      expect(fromRRule('FREQ=WEEKLY;INTERVAL=2')).toEqual({ recurrence: 'biweekly' });
    });

    it('FREQ=MONTHLY → monthly', () => {
      expect(fromRRule('FREQ=MONTHLY')).toEqual({ recurrence: 'monthly' });
    });
  });

  describe('BYDAY patterns', () => {
    it('FREQ=WEEKLY;BYDAY=MO → weekly (single day)', () => {
      expect(fromRRule('FREQ=WEEKLY;BYDAY=MO')).toEqual({ recurrence: 'weekly' });
    });

    it('FREQ=WEEKLY;BYDAY=MO,WE,FR → weekly_days:mon,wed,fri', () => {
      expect(fromRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toEqual({ recurrence: 'weekly_days:mon,wed,fri' });
    });

    it('FREQ=WEEKLY;BYDAY=TU,TH → weekly_days:tue,thu', () => {
      expect(fromRRule('FREQ=WEEKLY;BYDAY=TU,TH')).toEqual({ recurrence: 'weekly_days:tue,thu' });
    });

    it('FREQ=MONTHLY;BYDAY=2FR → ordinal_weekday:2:friday', () => {
      expect(fromRRule('FREQ=MONTHLY;BYDAY=2FR')).toEqual({ recurrence: 'ordinal_weekday:2:friday' });
    });

    it('FREQ=MONTHLY;BYDAY=1MO → ordinal_weekday:1:monday', () => {
      expect(fromRRule('FREQ=MONTHLY;BYDAY=1MO')).toEqual({ recurrence: 'ordinal_weekday:1:monday' });
    });

    it('FREQ=MONTHLY;BYDAY=5SU → ordinal_weekday:5:sunday', () => {
      expect(fromRRule('FREQ=MONTHLY;BYDAY=5SU')).toEqual({ recurrence: 'ordinal_weekday:5:sunday' });
    });
  });

  describe('COUNT extraction', () => {
    it('FREQ=WEEKLY;COUNT=12 → weekly with instanceCount 12', () => {
      expect(fromRRule('FREQ=WEEKLY;COUNT=12')).toEqual({ recurrence: 'weekly', instanceCount: 12 });
    });

    it('FREQ=DAILY;COUNT=30 → daily with instanceCount 30', () => {
      expect(fromRRule('FREQ=DAILY;COUNT=30')).toEqual({ recurrence: 'daily', instanceCount: 30 });
    });

    it('FREQ=MONTHLY;BYDAY=2FR;COUNT=6 → ordinal with instanceCount', () => {
      expect(fromRRule('FREQ=MONTHLY;BYDAY=2FR;COUNT=6')).toEqual({
        recurrence: 'ordinal_weekday:2:friday',
        instanceCount: 6,
      });
    });

    it('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=26 → weekly_days with instanceCount', () => {
      expect(fromRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=26')).toEqual({
        recurrence: 'weekly_days:mon,wed,fri',
        instanceCount: 26,
      });
    });

    it('COUNT without value is ignored (no instanceCount in result)', () => {
      // COUNT= with no number → NaN → ignored
      expect(fromRRule('FREQ=WEEKLY')).not.toHaveProperty('instanceCount');
    });
  });

  // =============================================================================
  // ROUNDTRIP — fromRRule ↔ toRRule
  // =============================================================================

  describe('roundtrip with toRRule', () => {
    const cases: [string, string][] = [
      ['FREQ=DAILY', 'FREQ=DAILY'],
      ['FREQ=WEEKLY', 'FREQ=WEEKLY'],
      ['FREQ=WEEKLY;INTERVAL=2', 'FREQ=WEEKLY;INTERVAL=2'],
      ['FREQ=MONTHLY', 'FREQ=MONTHLY'],
      ['FREQ=MONTHLY;BYDAY=2FR', 'FREQ=MONTHLY;BYDAY=2FR'],
      ['FREQ=WEEKLY;BYDAY=MO,WE,FR', 'FREQ=WEEKLY;BYDAY=MO,WE,FR'],
    ];

    for (const [input, expected] of cases) {
      it(`${input} roundtrips correctly`, () => {
        const { recurrence } = fromRRule(input);
        const output = toRRule(recurrence);
        expect(output).toBe(expected);
      });
    }

    it('COUNT roundtrips via toRRule count parameter', () => {
      const { recurrence, instanceCount } = fromRRule('FREQ=WEEKLY;COUNT=12');
      const output = toRRule(recurrence, instanceCount);
      expect(output).toBe('FREQ=WEEKLY;COUNT=12');
    });
  });

  // =============================================================================
  // ERROR CASES
  // =============================================================================

  describe('unsupported patterns throw', () => {
    it('FREQ=YEARLY throws', () => {
      expect(() => fromRRule('FREQ=YEARLY')).toThrow('Unsupported RRULE');
    });

    it('FREQ=WEEKLY;INTERVAL=3 throws', () => {
      expect(() => fromRRule('FREQ=WEEKLY;INTERVAL=3')).toThrow('Unsupported RRULE');
    });

    it('FREQ=DAILY;INTERVAL=2 throws', () => {
      expect(() => fromRRule('FREQ=DAILY;INTERVAL=2')).toThrow('Unsupported RRULE');
    });

    it('FREQ=MONTHLY;BYMONTHDAY=15 throws', () => {
      expect(() => fromRRule('FREQ=MONTHLY;BYMONTHDAY=15')).toThrow('Unsupported RRULE');
    });

    it('FREQ=MONTHLY;BYDAY=6MO throws (ordinal > 5)', () => {
      expect(() => fromRRule('FREQ=MONTHLY;BYDAY=6MO')).toThrow('Unsupported RRULE');
    });

    it('empty string throws', () => {
      expect(() => fromRRule('')).toThrow('Invalid RRULE');
    });

    it('missing FREQ throws', () => {
      expect(() => fromRRule('BYDAY=MO')).toThrow('missing FREQ');
    });

    it('COUNT=0 throws', () => {
      expect(() => fromRRule('FREQ=WEEKLY;COUNT=0')).toThrow('COUNT must be a positive integer');
    });

    it('COUNT=-1 throws', () => {
      expect(() => fromRRule('FREQ=WEEKLY;COUNT=-1')).toThrow('COUNT must be a positive integer');
    });
  });
});
