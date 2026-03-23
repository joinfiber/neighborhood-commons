import { useState } from 'react';
import { colors, radii, styles } from '../lib/styles';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DayHours {
  open: boolean;
  ranges: { start: string; end: string }[]; // HH:MM in 24h format
}

export type WeekHours = [DayHours, DayHours, DayHours, DayHours, DayHours, DayHours, DayHours];

const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------------------------------------------------------------------------
// Time options (15-minute increments)
// ---------------------------------------------------------------------------

const TIME_OPTIONS: string[] = [];
for (let h = 0; h < 24; h++) {
  for (const m of ['00', '15', '30', '45']) {
    TIME_OPTIONS.push(`${h.toString().padStart(2, '0')}:${m}`);
  }
}

function fmtTime12(t: string): string {
  const [hStr, m] = t.split(':');
  const h = parseInt(hStr!, 10);
  if (h === 0) return `12:${m} AM`;
  if (h === 12) return `12:${m} PM`;
  return h > 12 ? `${h - 12}:${m} PM` : `${h}:${m} AM`;
}

function closedDay(): DayHours {
  return { open: false, ranges: [] };
}

export function emptyWeek(): WeekHours {
  return [closedDay(), closedDay(), closedDay(), closedDay(), closedDay(), closedDay(), closedDay()];
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface OperatingHoursProps {
  value: WeekHours;
  onChange: (hours: WeekHours) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OperatingHours({ value, onChange }: OperatingHoursProps) {
  const [copySource, setCopySource] = useState<number | null>(null);

  function updateDay(dayIndex: number, update: Partial<DayHours>) {
    const next = [...value] as WeekHours;
    next[dayIndex] = { ...next[dayIndex]!, ...update };
    onChange(next);
  }

  function toggleOpen(dayIndex: number) {
    const day = value[dayIndex]!;
    if (day.open) {
      updateDay(dayIndex, { open: false, ranges: [] });
    } else {
      updateDay(dayIndex, { open: true, ranges: [{ start: '09:00', end: '17:00' }] });
    }
  }

  function updateRange(dayIndex: number, rangeIndex: number, field: 'start' | 'end', val: string) {
    const day = value[dayIndex]!;
    const ranges = [...day.ranges];
    ranges[rangeIndex] = { ...ranges[rangeIndex]!, [field]: val };
    updateDay(dayIndex, { ranges });
  }

  function addRange(dayIndex: number) {
    const day = value[dayIndex]!;
    const lastEnd = day.ranges[day.ranges.length - 1]?.end || '17:00';
    const newStart = lastEnd;
    updateDay(dayIndex, { ranges: [...day.ranges, { start: newStart, end: '22:00' }] });
  }

  function removeRange(dayIndex: number, rangeIndex: number) {
    const day = value[dayIndex]!;
    const ranges = day.ranges.filter((_, i) => i !== rangeIndex);
    if (ranges.length === 0) {
      updateDay(dayIndex, { open: false, ranges: [] });
    } else {
      updateDay(dayIndex, { ranges });
    }
  }

  function copyToOtherDays(sourceIndex: number) {
    const source = value[sourceIndex]!;
    const next = [...value] as WeekHours;
    for (let i = 0; i < 7; i++) {
      if (i !== sourceIndex) {
        next[i] = { open: source.open, ranges: source.ranges.map(r => ({ ...r })) };
      }
    }
    onChange(next);
    setCopySource(null);
  }

  // Crossing midnight indicator
  function crossesMidnight(start: string, end: string): boolean {
    return end <= start && end !== '00:00';
  }

  const timeSelect = (val: string, onChangeVal: (v: string) => void, label: string) => (
    <select
      value={val}
      onChange={(e) => onChangeVal(e.target.value)}
      aria-label={label}
      style={{
        ...styles.select,
        padding: '6px 28px 6px 8px',
        fontSize: '13px',
        minHeight: '36px',
        width: 'auto',
        minWidth: '100px',
      }}
    >
      {TIME_OPTIONS.map((t) => (
        <option key={t} value={t}>{fmtTime12(t)}</option>
      ))}
    </select>
  );

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {value.map((day, dayIndex) => (
          <div
            key={dayIndex}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: '10px',
              padding: '8px 12px', borderRadius: radii.sm,
              background: day.open ? 'transparent' : colors.bg,
              transition: 'background var(--motion-prop)',
            }}
          >
            {/* Day label + toggle */}
            <div style={{ width: '44px', flexShrink: 0, paddingTop: '6px' }}>
              <span style={{
                fontSize: '13px', fontWeight: 500,
                color: day.open ? colors.text : colors.dim,
              }}>
                {DAY_SHORT[dayIndex]}
              </span>
            </div>

            {/* Toggle */}
            <button
              type="button"
              onClick={() => toggleOpen(dayIndex)}
              aria-label={`${DAY_LABELS[dayIndex]} ${day.open ? 'open' : 'closed'}`}
              style={{
                width: '34px', height: '20px', borderRadius: '10px',
                background: day.open ? colors.accent : colors.border,
                border: 'none', cursor: 'pointer', position: 'relative',
                transition: 'background var(--motion-prop)',
                flexShrink: 0, marginTop: '5px',
              }}
            >
              <span style={{
                position: 'absolute', top: '2px',
                left: day.open ? '16px' : '2px',
                width: '16px', height: '16px', borderRadius: '50%',
                background: '#fff',
                transition: 'left var(--motion-prop)',
                boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
              }} />
            </button>

            {/* Time ranges or "Closed" */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {day.open ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {day.ranges.map((range, rangeIndex) => (
                    <div key={rangeIndex} style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      {timeSelect(range.start, (v) => updateRange(dayIndex, rangeIndex, 'start', v), `${DAY_LABELS[dayIndex]} open`)}
                      <span style={{ fontSize: '12px', color: colors.dim }}>to</span>
                      {timeSelect(range.end, (v) => updateRange(dayIndex, rangeIndex, 'end', v), `${DAY_LABELS[dayIndex]} close`)}
                      {crossesMidnight(range.start, range.end) && (
                        <span style={{ fontSize: '10px', color: colors.muted, whiteSpace: 'nowrap' }}>next day</span>
                      )}
                      {day.ranges.length > 1 && (
                        <button type="button" onClick={() => removeRange(dayIndex, rangeIndex)}
                          style={{ background: 'none', border: 'none', color: colors.dim, cursor: 'pointer',
                            fontSize: '14px', padding: '2px 4px', lineHeight: 1 }}
                          aria-label="Remove time range">
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: '10px', marginTop: '2px' }}>
                    <button type="button" onClick={() => addRange(dayIndex)}
                      className="btn-text"
                      style={{ ...styles.buttonText, fontSize: '11px', padding: 0 }}>
                      + Add hours
                    </button>
                    {copySource === dayIndex ? (
                      <button type="button" onClick={() => copyToOtherDays(dayIndex)}
                        className="btn-text"
                        style={{ ...styles.buttonText, fontSize: '11px', padding: 0, color: colors.accent }}>
                        Apply to all days
                      </button>
                    ) : (
                      <button type="button" onClick={() => setCopySource(dayIndex)}
                        className="btn-text"
                        style={{ ...styles.buttonText, fontSize: '11px', padding: 0 }}>
                        Copy to other days
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <span style={{ fontSize: '13px', color: colors.dim, paddingTop: '6px', display: 'block' }}>
                  Closed
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
