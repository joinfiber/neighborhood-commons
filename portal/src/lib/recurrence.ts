/**
 * Recurrence utilities — shared by RecurrencePicker and event display.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const DAY_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const ORDINAL_LABELS = ['', '1st', '2nd', '3rd', '4th', '5th'] as const;

export interface OrdinalWeekday {
  ordinal: number;   // 1-5
  dayName: string;   // 'thursday'
  label: string;     // 'Every 3rd Thu'
}

/** Given a YYYY-MM-DD string, compute which ordinal weekday it falls on. */
export function getOrdinalWeekday(dateStr: string): OrdinalWeekday | null {
  const d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d.getTime())) return null;

  const dayOfMonth = d.getDate();
  const dayOfWeek = d.getDay(); // 0=Sun
  const ordinal = Math.ceil(dayOfMonth / 7); // 1st, 2nd, 3rd, 4th, 5th

  const dayName = DAY_NAMES[dayOfWeek] ?? 'monday';
  const ordLabel = ORDINAL_LABELS[ordinal] ?? '';
  const dayAbbr = DAY_ABBR[dayOfWeek] ?? '';

  return {
    ordinal,
    dayName,
    label: `Every ${ordLabel} ${dayAbbr}`,
  };
}

/** Build the recurrence string for an ordinal weekday. */
export function toOrdinalRecurrence(ordinal: number, dayName: string): string {
  return `ordinal_weekday:${ordinal}:${dayName}`;
}

/** Parse an ordinal_weekday recurrence string. */
export function parseOrdinalRecurrence(recurrence: string): { ordinal: number; dayName: string } | null {
  const m = recurrence.match(/^ordinal_weekday:([1-5]):(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  return { ordinal: parseInt(m[1], 10), dayName: m[2] };
}

/** Build a weekly_days recurrence string from day indices (0=Sun). */
export function toWeeklyDaysRecurrence(dayIndices: number[]): string {
  const sorted = [...dayIndices].sort((a, b) => a - b);
  return `weekly_days:${sorted.map(i => DAY_SHORT[i]).join(',')}`;
}

/** Parse a weekly_days:mon,tue,wed pattern. Returns day indices (0=Sun) or null. */
export function parseWeeklyDays(recurrence: string): number[] | null {
  const m = recurrence.match(/^weekly_days:([a-z,]+)$/);
  if (!m || !m[1]) return null;
  const days = m[1].split(',');
  const indices: number[] = [];
  for (const d of days) {
    const idx = DAY_SHORT.indexOf(d as typeof DAY_SHORT[number]);
    if (idx < 0) return null;
    indices.push(idx);
  }
  return indices.sort((a, b) => a - b);
}

/** Format weekly_days as human-readable label, e.g. "Mon-Thu" or "Mon, Wed, Fri" */
export function formatWeeklyDaysLabel(dayIndices: number[]): string {
  if (dayIndices.length === 0) return '';
  const sorted = [...dayIndices].sort((a, b) => a - b);

  // Check if days are consecutive — show as range
  let isConsecutive = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1]! + 1) { isConsecutive = false; break; }
  }

  if (isConsecutive && sorted.length >= 3) {
    return `${DAY_ABBR[sorted[0]!]}-${DAY_ABBR[sorted[sorted.length - 1]!]}`;
  }
  return sorted.map(i => DAY_ABBR[i]).join(', ');
}

/** Human-readable label for any recurrence value. */
export function formatRecurrenceLabel(recurrence: string): string {
  switch (recurrence) {
    case 'none': return 'One-time';
    case 'daily': return 'Daily';
    case 'weekly': return 'Weekly';
    case 'biweekly': return 'Every 2 weeks';
    case 'monthly': return 'Monthly';
    default: {
      const weeklyDays = parseWeeklyDays(recurrence);
      if (weeklyDays) return formatWeeklyDaysLabel(weeklyDays);

      const parsed = parseOrdinalRecurrence(recurrence);
      if (parsed) {
        const dayIdx = DAY_NAMES.indexOf(parsed.dayName as typeof DAY_NAMES[number]);
        if (dayIdx >= 0) {
          return `Every ${ORDINAL_LABELS[parsed.ordinal]} ${DAY_ABBR[dayIdx]}`;
        }
      }
      return recurrence;
    }
  }
}

/**
 * Compute next N occurrence dates from a start date and recurrence pattern.
 * Returns formatted strings like "Mar 15".
 */
export function getNextDates(startDate: string, recurrence: string, count: number): string[] {
  const start = new Date(startDate + 'T12:00:00');
  if (isNaN(start.getTime())) return [];

  const dates: string[] = [];

  // weekly_days pattern: walk forward collecting matching days
  const weeklyDays = parseWeeklyDays(recurrence);
  if (weeklyDays) {
    const cursor = new Date(start);
    cursor.setDate(cursor.getDate() + 1);
    let walked = 0;
    while (dates.length < count && walked < count * 7 + 7) {
      if (weeklyDays.includes(cursor.getDay())) {
        dates.push(cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      }
      cursor.setDate(cursor.getDate() + 1);
      walked++;
    }
    return dates;
  }

  const ordinal = parseOrdinalRecurrence(recurrence);
  if (ordinal) {
    // Find next N occurrences of the Nth weekday of each subsequent month
    const dayIdx = DAY_NAMES.indexOf(ordinal.dayName as typeof DAY_NAMES[number]);
    if (dayIdx < 0) return [];

    let month = start.getMonth();
    let year = start.getFullYear();

    for (let i = 0; i < count; i++) {
      // Move to next month
      month++;
      if (month > 11) { month = 0; year++; }

      const d = getNthWeekdayOfMonth(year, month, dayIdx, ordinal.ordinal);
      if (d) {
        dates.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      }
    }
    return dates;
  }

  for (let i = 1; i <= count; i++) {
    const d = new Date(start);
    switch (recurrence) {
      case 'daily':
        d.setDate(d.getDate() + i);
        break;
      case 'weekly':
        d.setDate(d.getDate() + i * 7);
        break;
      case 'biweekly':
        d.setDate(d.getDate() + i * 14);
        break;
      case 'monthly':
        d.setMonth(d.getMonth() + i);
        break;
      default:
        return [];
    }
    dates.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  }
  return dates;
}

/** Get the Nth occurrence of a weekday (0=Sun) in a given month/year. */
function getNthWeekdayOfMonth(year: number, month: number, dayOfWeek: number, n: number): Date | null {
  // Find first occurrence of this weekday in the month
  const first = new Date(year, month, 1, 12, 0, 0);
  const firstDay = first.getDay();
  let dateOfFirst = 1 + ((dayOfWeek - firstDay + 7) % 7);

  // Nth occurrence
  const target = dateOfFirst + (n - 1) * 7;

  // Verify it's still in the same month
  const result = new Date(year, month, target, 12, 0, 0);
  if (result.getMonth() !== month) return null; // 5th occurrence doesn't exist
  return result;
}
