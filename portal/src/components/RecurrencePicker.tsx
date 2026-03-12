import { useMemo, useEffect } from 'react';
import { colors } from '../lib/styles';
import {
  getOrdinalWeekday,
  toOrdinalRecurrence,
  getNextDates,
  parseOrdinalRecurrence,
  parseWeeklyDays,
  toWeeklyDaysRecurrence,
  formatWeeklyDaysLabel,
} from '../lib/recurrence';

/** Default instance count when a recurrence pattern is first selected */
const PATTERN_DEFAULTS: Record<string, number> = {
  daily: 7,
  weekly: 4,
  biweekly: 4,
  monthly: 4,
};
const ORDINAL_DEFAULT = 4;
const WEEKLY_DAYS_DEFAULT = 8;

/** Day labels for the day-of-week picker, starting Monday */
const DAY_PICKER_ORDER = [
  { idx: 1, label: 'M' },
  { idx: 2, label: 'T' },
  { idx: 3, label: 'W' },
  { idx: 4, label: 'Th' },
  { idx: 5, label: 'F' },
  { idx: 6, label: 'Sa' },
  { idx: 0, label: 'Su' },
];

interface RecurrencePickerProps {
  value: string;
  onChange: (recurrence: string) => void;
  eventDate: string; // YYYY-MM-DD — used to compute ordinal weekday option
  instanceCount: number; // 0 = until cancelled, 2-52 = fixed count
  onInstanceCountChange: (count: number) => void;
}

interface Option {
  value: string;
  label: string;
}

export function RecurrencePicker({ value, onChange, eventDate, instanceCount, onInstanceCountChange }: RecurrencePickerProps) {
  const isWeeklyDays = parseWeeklyDays(value) !== null;
  const selectedDays = parseWeeklyDays(value) || [];

  const baseOptions: Option[] = [
    { value: 'none', label: 'None' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'biweekly', label: 'Biweekly' },
    { value: 'monthly', label: 'Monthly' },
  ];

  const ordinalOption = useMemo((): Option | null => {
    if (!eventDate) return null;
    const ow = getOrdinalWeekday(eventDate);
    if (!ow) return null;
    return {
      value: toOrdinalRecurrence(ow.ordinal, ow.dayName),
      label: ow.label,
    };
  }, [eventDate]);

  // If value is an ordinal_weekday that no longer matches the current date, reset
  useEffect(() => {
    if (!parseOrdinalRecurrence(value)) return; // not an ordinal — nothing to sync
    if (!ordinalOption || ordinalOption.value !== value) {
      onChange('none');
    }
  }, [ordinalOption, value, onChange]);

  const options = ordinalOption ? [...baseOptions, ordinalOption] : baseOptions;

  // "Custom days" is a meta-option that activates the day picker
  const customDaysLabel = isWeeklyDays && selectedDays.length > 0
    ? formatWeeklyDaysLabel(selectedDays)
    : 'Custom days';

  const isUntilCancelled = instanceCount === 0;
  // For weekly_days, preview shows individual event dates (weeks * days selected)
  // Cap at ~14 to keep the preview manageable
  const previewCount = useMemo(() => {
    if (isUntilCancelled) return isWeeklyDays ? 10 : 5;
    if (isWeeklyDays) {
      return Math.min(14, (instanceCount - 1) * selectedDays.length);
    }
    return instanceCount > 0 ? instanceCount - 1 : 5;
  }, [isUntilCancelled, isWeeklyDays, instanceCount, selectedDays.length]);

  const nextDates = useMemo(() => {
    if (!eventDate || value === 'none') return [];
    return getNextDates(eventDate, value, previewCount);
  }, [eventDate, value, previewCount]);

  const showDurationRow = value !== 'none';

  function handleDayToggle(dayIdx: number) {
    const current = new Set(selectedDays);
    if (current.has(dayIdx)) {
      current.delete(dayIdx);
    } else {
      current.add(dayIdx);
    }
    if (current.size === 0) {
      onChange('none');
    } else {
      onChange(toWeeklyDaysRecurrence([...current]));
    }
  }

  const pillStyle = (active: boolean) => ({
    display: 'inline-flex' as const,
    alignItems: 'center' as const,
    borderRadius: '16px',
    padding: '5px 12px',
    fontSize: '12px',
    cursor: 'pointer' as const,
    transition: 'all 0.15s',
    border: '1px solid',
    userSelect: 'none' as const,
    fontFamily: 'inherit',
    background: active ? colors.amberDim : 'transparent',
    color: active ? colors.amber : colors.dim,
    borderColor: active ? colors.amberBorder : colors.border,
  });

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                if (opt.value !== 'none') {
                  const def = parseOrdinalRecurrence(opt.value) ? ORDINAL_DEFAULT : (PATTERN_DEFAULTS[opt.value] || 4);
                  onInstanceCountChange(def);
                }
              }}
              style={pillStyle(active)}
            >
              {opt.label}
            </button>
          );
        })}
        {/* Custom days toggle */}
        <button
          type="button"
          onClick={() => {
            if (isWeeklyDays) {
              onChange('none');
            } else {
              // Default to the event date's day of week
              const d = eventDate ? new Date(eventDate + 'T12:00:00') : null;
              const dayIdx = d && !isNaN(d.getTime()) ? d.getDay() : 1; // fallback to Monday
              onChange(toWeeklyDaysRecurrence([dayIdx]));
              onInstanceCountChange(WEEKLY_DAYS_DEFAULT);
            }
          }}
          style={pillStyle(isWeeklyDays)}
        >
          {customDaysLabel}
        </button>
      </div>

      {/* Day-of-week picker — shown when "Custom days" is active */}
      {isWeeklyDays && (
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
                  background: active ? colors.amberDim : 'transparent',
                  color: active ? colors.amber : colors.dim,
                  borderColor: active ? colors.amberBorder : colors.border,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Duration row: count stepper + until cancelled */}
      {showDurationRow && (
        <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          {/* Count stepper */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0',
            border: `1px solid ${isUntilCancelled ? colors.border : colors.amberBorder}`,
            borderRadius: '16px',
            overflow: 'hidden',
            opacity: isUntilCancelled ? 0.4 : 1,
            transition: 'all 0.15s',
          }}>
            <button
              type="button"
              disabled={isUntilCancelled || instanceCount <= 2}
              onClick={() => onInstanceCountChange(Math.max(2, instanceCount - 1))}
              style={{
                background: 'none',
                border: 'none',
                color: colors.dim,
                cursor: isUntilCancelled || instanceCount <= 2 ? 'default' : 'pointer',
                padding: '4px 10px',
                fontSize: '14px',
                fontFamily: 'inherit',
                lineHeight: 1,
              }}
            >
              -
            </button>
            <span style={{
              fontSize: '12px',
              color: isUntilCancelled ? colors.dim : colors.amber,
              minWidth: '60px',
              textAlign: 'center',
              fontWeight: 500,
            }}>
              {isUntilCancelled ? '-' : `${instanceCount} ${isWeeklyDays ? 'weeks' : 'times'}`}
            </span>
            <button
              type="button"
              disabled={isUntilCancelled || instanceCount >= 52}
              onClick={() => onInstanceCountChange(Math.min(52, instanceCount + 1))}
              style={{
                background: 'none',
                border: 'none',
                color: colors.dim,
                cursor: isUntilCancelled || instanceCount >= 52 ? 'default' : 'pointer',
                padding: '4px 10px',
                fontSize: '14px',
                fontFamily: 'inherit',
                lineHeight: 1,
              }}
            >
              +
            </button>
          </div>

          {/* Until cancelled toggle */}
          <button
            type="button"
            onClick={() => onInstanceCountChange(isUntilCancelled ? (PATTERN_DEFAULTS[value] || WEEKLY_DAYS_DEFAULT) : 0)}
            style={pillStyle(isUntilCancelled)}
          >
            Until cancelled
          </button>
        </div>
      )}

      {/* Next dates preview */}
      {nextDates.length > 0 && (
        <div style={{ marginTop: '8px' }}>
          <span style={{ fontSize: '11px', color: colors.dim, marginRight: '8px' }}>
            {isUntilCancelled ? 'Upcoming:' : 'All dates:'}
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
            {nextDates.map((date, i) => (
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
            {isUntilCancelled && (
              <span style={{ fontSize: '11px', color: colors.dim, alignSelf: 'center' }}>
                and more...
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
