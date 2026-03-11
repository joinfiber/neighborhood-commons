import { useMemo, useEffect } from 'react';
import { colors } from '../lib/styles';
import { getOrdinalWeekday, toOrdinalRecurrence, getNextDates, parseOrdinalRecurrence } from '../lib/recurrence';

/** Default instance count when a recurrence pattern is first selected */
const PATTERN_DEFAULTS: Record<string, number> = {
  daily: 7,
  weekly: 4,
  biweekly: 4,
  monthly: 4,
};
const ORDINAL_DEFAULT = 4;

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

  const isUntilCancelled = instanceCount === 0;
  const previewCount = isUntilCancelled ? 5 : (instanceCount > 0 ? instanceCount - 1 : 5);

  const nextDates = useMemo(() => {
    if (!eventDate || value === 'none') return [];
    return getNextDates(eventDate, value, previewCount);
  }, [eventDate, value, previewCount]);

  const showDurationRow = value !== 'none';

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
                // Set sensible default count when switching patterns
                if (opt.value !== 'none') {
                  const def = parseOrdinalRecurrence(opt.value) ? ORDINAL_DEFAULT : (PATTERN_DEFAULTS[opt.value] || 4);
                  onInstanceCountChange(def);
                }
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                borderRadius: '16px',
                padding: '5px 12px',
                fontSize: '12px',
                cursor: 'pointer',
                transition: 'all 0.15s',
                border: '1px solid',
                userSelect: 'none' as const,
                fontFamily: 'inherit',
                background: active ? colors.amberDim : 'transparent',
                color: active ? colors.amber : colors.dim,
                borderColor: active ? colors.amberBorder : colors.border,
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

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
              minWidth: '50px',
              textAlign: 'center',
              fontWeight: 500,
            }}>
              {isUntilCancelled ? '-' : `${instanceCount} times`}
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
            onClick={() => onInstanceCountChange(isUntilCancelled ? (PATTERN_DEFAULTS[value] || 4) : 0)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              borderRadius: '16px',
              padding: '5px 12px',
              fontSize: '12px',
              cursor: 'pointer',
              transition: 'all 0.15s',
              border: '1px solid',
              userSelect: 'none' as const,
              fontFamily: 'inherit',
              background: isUntilCancelled ? colors.amberDim : 'transparent',
              color: isUntilCancelled ? colors.amber : colors.dim,
              borderColor: isUntilCancelled ? colors.amberBorder : colors.border,
            }}
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
