/**
 * RRULE Parser — Neighborhood Commons
 *
 * Translates iCal RRULE strings (RFC 5545) to the internal recurrence format.
 * Used at the Contribute API boundary: RRULE comes in, internal format goes to storage.
 *
 * Supported subset:
 *   FREQ=DAILY                      → daily
 *   FREQ=WEEKLY                     → weekly
 *   FREQ=WEEKLY;INTERVAL=2          → biweekly
 *   FREQ=MONTHLY                    → monthly
 *   FREQ=MONTHLY;BYDAY=2FR          → ordinal_weekday:2:friday
 *   FREQ=WEEKLY;BYDAY=MO,WE,FR     → weekly_days:mon,wed,fri
 *   ;COUNT=N on any                 → instanceCount
 *
 * Anything outside this subset throws — the Contribute API returns 400.
 */

const BYDAY_TO_ABBR: Record<string, string> = {
  SU: 'sun', MO: 'mon', TU: 'tue', WE: 'wed', TH: 'thu', FR: 'fri', SA: 'sat',
};

const BYDAY_TO_FULL: Record<string, string> = {
  SU: 'sunday', MO: 'monday', TU: 'tuesday', WE: 'wednesday',
  TH: 'thursday', FR: 'friday', SA: 'saturday',
};

export const SUPPORTED_RRULES =
  'Supported patterns: FREQ=DAILY, FREQ=WEEKLY, FREQ=WEEKLY;INTERVAL=2, ' +
  'FREQ=MONTHLY, FREQ=MONTHLY;BYDAY={n}{day} (e.g. BYDAY=2FR), ' +
  'FREQ=WEEKLY;BYDAY={days} (e.g. BYDAY=MO,WE,FR). ' +
  'Optional: ;COUNT={n} on any pattern.';

export interface RRuleResult {
  recurrence: string;
  instanceCount?: number;
}

/**
 * Parse an RRULE string into the internal recurrence format.
 * Throws on unsupported patterns (caller should catch and return 400).
 */
export function fromRRule(rrule: string): RRuleResult {
  if (!rrule || typeof rrule !== 'string') {
    throw new Error(`Invalid RRULE: empty or not a string. ${SUPPORTED_RRULES}`);
  }

  // Parse key=value pairs
  const parts: Record<string, string> = {};
  for (const segment of rrule.split(';')) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx > 0) {
      parts[segment.substring(0, eqIdx).toUpperCase()] = segment.substring(eqIdx + 1);
    }
  }

  const freq = parts['FREQ'];
  if (!freq) {
    throw new Error(`Invalid RRULE: missing FREQ. ${SUPPORTED_RRULES}`);
  }

  const interval = parseInt(parts['INTERVAL'] || '1', 10);
  const byday = parts['BYDAY'];

  // Reject RRULE properties we don't support
  const unsupportedKeys = ['UNTIL', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS', 'WKST'];
  for (const key of unsupportedKeys) {
    if (parts[key]) {
      throw new Error(`Unsupported RRULE property: ${key}. ${SUPPORTED_RRULES}`);
    }
  }

  // Extract COUNT if present
  let instanceCount: number | undefined;
  if (parts['COUNT']) {
    const count = parseInt(parts['COUNT'], 10);
    if (isNaN(count) || count < 1) {
      throw new Error(`Invalid RRULE: COUNT must be a positive integer. ${SUPPORTED_RRULES}`);
    }
    instanceCount = count;
  }

  let recurrence: string | null = null;

  if (freq === 'DAILY' && interval === 1 && !byday) {
    recurrence = 'daily';
  } else if (freq === 'WEEKLY') {
    if (interval === 2 && !byday) {
      recurrence = 'biweekly';
    } else if (interval === 1 && byday) {
      const days = byday.split(',').map(d => BYDAY_TO_ABBR[d]).filter(Boolean);
      if (days.length === 0) {
        throw new Error(`Invalid RRULE: unrecognized BYDAY values "${byday}". ${SUPPORTED_RRULES}`);
      }
      // Single day = plain weekly (e.g. BYDAY=MO for "every Monday")
      recurrence = days.length === 1 ? 'weekly' : `weekly_days:${days.join(',')}`;
    } else if (interval === 1 && !byday) {
      recurrence = 'weekly';
    }
  } else if (freq === 'MONTHLY') {
    if (byday) {
      // BYDAY=2FR → ordinal_weekday:2:friday
      const ordMatch = byday.match(/^([1-5])(SU|MO|TU|WE|TH|FR|SA)$/);
      if (ordMatch && ordMatch[1] && ordMatch[2]) {
        const dayName = BYDAY_TO_FULL[ordMatch[2]];
        if (dayName) {
          recurrence = `ordinal_weekday:${ordMatch[1]}:${dayName}`;
        }
      }
    } else if (interval === 1) {
      recurrence = 'monthly';
    }
  }

  if (!recurrence) {
    throw new Error(`Unsupported RRULE: "${rrule}". ${SUPPORTED_RRULES}`);
  }

  return instanceCount !== undefined ? { recurrence, instanceCount } : { recurrence };
}
