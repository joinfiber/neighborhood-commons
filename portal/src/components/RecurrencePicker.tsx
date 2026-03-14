import { useMemo } from 'react';
import { colors } from '../lib/styles';
import {
  getOrdinalWeekday,
  toOrdinalRecurrence,
  getNextDates,
  parseWeeklyDays,
  toWeeklyDaysRecurrence,
  durationToInstanceCount,
} from '../lib/recurrence';

type Frequency = 'weekly' | 'biweekly' | 'monthly';
type Duration = 1 | 3 | 6 | 0;

const DAY_PICKER_ORDER = [
  { idx: 1, label: 'M' },
  { idx: 2, label: 'T' },
  { idx: 3, label: 'W' },
  { idx: 4, label: 'Th' },
  { idx: 5, label: 'F' },
  { idx: 6, label: 'Sa' },
  { idx: 0, label: 'Su' },
];

const DURATION_OPTIONS: { months: Duration; label: string }[] = [
  { months: 1, label: '1 mo' },
  { months: 3, label: '3 mo' },
  { months: 6, label: '6 mo' },
  { months: 0, label: 'Ongoing' },
];

interface RecurrencePickerProps {
  value: string;
  onChange: (recurrence: string) => void;
  eventDate: string; // YYYY-MM-DD
  instanceCount: number; // 0 = ongoing, 2-52 = fixed count
  onInstanceCountChange: (count: number) => void;
}

export function RecurrencePicker({ value, onChange, eventDate, instanceCount, onInstanceCountChange }: RecurrencePickerProps) {
  const weeklyDays = parseWeeklyDays(value);

  // Derive frequency from stored recurrence value
  const frequency: Frequency = useMemo(() => {
    if (value === 'biweekly') return 'biweekly';
    if (value === 'monthly' || value.startsWith('ordinal_weekday:')) return 'monthly';
    return 'weekly'; // weekly, daily, weekly_days all live under "Every week"
  }, [value]);

  // Selected days for the day picker (weekly frequency only)
  const selectedDays: number[] = useMemo(() => {
    if (weeklyDays) return weeklyDays;
    if (value === 'daily') return [0, 1, 2, 3, 4, 5, 6];
    if (frequency === 'weekly') {
      const d = eventDate ? new Date(eventDate + 'T12:00:00') : null;
      return d && !isNaN(d.getTime()) ? [d.getDay()] : [1];
    }
    return [];
  }, [value, weeklyDays, frequency, eventDate]);

  // Reverse-map instanceCount → duration preset
  const duration: Duration = useMemo(() => {
    if (instanceCount === 0) return 0;
    for (const months of [1, 3, 6] as const) {
      if (instanceCount === durationToInstanceCount(frequency, months)) return months;
    }
    // Non-standard count (legacy stepper value): snap to closest
    if (instanceCount <= 4) return 1;
    if (instanceCount <= 13) return 3;
    return 6;
  }, [instanceCount, frequency]);

  // Ordinal weekday for monthly (e.g. "Every 3rd Thursday")
  const ordinal = useMemo(() => {
    if (!eventDate) return null;
    return getOrdinalWeekday(eventDate);
  }, [eventDate]);

  // Summary: event count + date range
  const summary = useMemo(() => {
    if (!eventDate) return null;
    const start = new Date(eventDate + 'T12:00:00');
    if (isNaN(start.getTime())) return null;

    if (instanceCount === 0) return null; // ongoing uses subtitle instead

    const daysPerWeek = frequency === 'weekly' ? selectedDays.length : 1;
    const totalEvents = frequency === 'weekly' && daysPerWeek > 1
      ? instanceCount * daysPerWeek
      : instanceCount;

    const endDate = new Date(start);
    switch (frequency) {
      case 'weekly':
        endDate.setDate(endDate.getDate() + (instanceCount - 1) * 7);
        break;
      case 'biweekly':
        endDate.setDate(endDate.getDate() + (instanceCount - 1) * 14);
        break;
      case 'monthly':
        endDate.setMonth(endDate.getMonth() + instanceCount - 1);
        break;
    }

    return `${totalEvents} event${totalEvents !== 1 ? 's' : ''} · ${formatShortDate(start)} – ${formatShortDate(endDate)}`;
  }, [eventDate, instanceCount, frequency, selectedDays.length]);

  // Preview dates
  const previewCount = useMemo(() => {
    if (instanceCount === 0) return 8;
    const totalFuture = frequency === 'weekly' && selectedDays.length > 1
      ? (instanceCount - 1) * selectedDays.length
      : instanceCount - 1;
    return Math.min(10, Math.max(0, totalFuture));
  }, [instanceCount, frequency, selectedDays.length]);

  const previewDates = useMemo(() => {
    if (!eventDate || value === 'none') return [];
    return getNextDates(eventDate, value, previewCount);
  }, [eventDate, value, previewCount]);

  // --- Handlers ---

  function handleFrequencyChange(newFreq: Frequency) {
    switch (newFreq) {
      case 'weekly':
        onChange('weekly');
        onInstanceCountChange(durationToInstanceCount('weekly', duration));
        break;
      case 'biweekly':
        onChange('biweekly');
        onInstanceCountChange(durationToInstanceCount('biweekly', duration));
        break;
      case 'monthly':
        if (ordinal) {
          onChange(toOrdinalRecurrence(ordinal.ordinal, ordinal.dayName));
        } else {
          onChange('monthly');
        }
        onInstanceCountChange(durationToInstanceCount('monthly', duration));
        break;
    }
  }

  function handleDayToggle(dayIdx: number) {
    const current = new Set(selectedDays);
    if (current.has(dayIdx)) {
      if (current.size <= 1) return; // keep at least one day
      current.delete(dayIdx);
    } else {
      current.add(dayIdx);
    }

    const days = [...current];
    if (days.length === 1) {
      onChange('weekly');
    } else {
      onChange(toWeeklyDaysRecurrence(days));
    }
    onInstanceCountChange(durationToInstanceCount('weekly', duration));
  }

  function handleDurationChange(months: Duration) {
    onInstanceCountChange(durationToInstanceCount(frequency, months));
  }

  // --- Styles ---

  const pillStyle = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: '16px',
    padding: '5px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    transition: 'all 0.15s',
    border: '1px solid',
    userSelect: 'none',
    fontFamily: 'inherit',
    background: active ? colors.accentDim : 'transparent',
    color: active ? colors.accent : colors.dim,
    borderColor: active ? colors.accentBorder : colors.border,
  });

  return (
    <div>
      {/* Frequency */}
      <div style={{ display: 'flex', gap: '6px' }}>
        <button type="button" onClick={() => handleFrequencyChange('weekly')} style={pillStyle(frequency === 'weekly')}>
          Every week
        </button>
        <button type="button" onClick={() => handleFrequencyChange('biweekly')} style={pillStyle(frequency === 'biweekly')}>
          Every 2 weeks
        </button>
        <button type="button" onClick={() => handleFrequencyChange('monthly')} style={pillStyle(frequency === 'monthly')}>
          Monthly
        </button>
      </div>

      {/* Day picker — weekly only */}
      {frequency === 'weekly' && (
        <div style={{ marginTop: '8px', display: 'flex', gap: '4px' }}>
          {DAY_PICKER_ORDER.map(({ idx, label }) => {
            const active = selectedDays.includes(idx);
            return (
              <button
                key={idx}
                type="button"
                onClick={() => handleDayToggle(idx)}
                style={{
                  width: '34px',
                  height: '34px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  border: '1px solid',
                  fontFamily: 'inherit',
                  background: active ? colors.accentDim : 'transparent',
                  color: active ? colors.accent : colors.dim,
                  borderColor: active ? colors.accentBorder : colors.border,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Monthly ordinal label */}
      {frequency === 'monthly' && ordinal && (
        <div style={{ marginTop: '8px', fontSize: '13px', color: colors.muted }}>
          {ordinal.label}
        </div>
      )}

      {/* Duration presets */}
      <div style={{ marginTop: '10px', display: 'flex', gap: '6px', alignItems: 'center' }}>
        <span style={{ fontSize: '12px', color: colors.dim, marginRight: '2px' }}>Duration:</span>
        {DURATION_OPTIONS.map(({ months, label }) => (
          <button
            key={months}
            type="button"
            onClick={() => handleDurationChange(months)}
            style={pillStyle(duration === months)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Ongoing subtitle */}
      {duration === 0 && (
        <div style={{ marginTop: '4px', fontSize: '11px', color: colors.dim }}>
          Creates 6 months of events
        </div>
      )}

      {/* Summary */}
      {summary && (
        <div style={{ marginTop: '8px', fontSize: '12px', color: colors.muted }}>
          {summary}
        </div>
      )}

      {/* Preview dates */}
      {previewDates.length > 0 && (
        <div style={{ marginTop: '6px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {previewDates.map((date, i) => (
              <span
                key={i}
                style={{
                  background: colors.bg,
                  border: `1px solid ${colors.border}`,
                  borderRadius: '12px',
                  padding: '2px 10px',
                  fontSize: '11px',
                  color: colors.muted,
                }}
              >
                {date}
              </span>
            ))}
            {instanceCount === 0 && (
              <span style={{ fontSize: '11px', color: colors.dim, alignSelf: 'center' }}>...</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
