import { useMemo } from 'react';
import { colors, radii } from '../lib/styles';
import {
  getOrdinalWeekday,
  toOrdinalRecurrence,
  durationToInstanceCount,
} from '../lib/recurrence';

type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'ordinal';
type Duration = 1 | 3 | 6 | 0;

const DURATION_OPTIONS: { months: Duration; label: string }[] = [
  { months: 1, label: '1 mo' },
  { months: 3, label: '3 mo' },
  { months: 6, label: '6 mo' },
  { months: 0, label: 'Ongoing' },
];

interface RecurrencePickerProps {
  value: string;
  onChange: (recurrence: string) => void;
  eventDate: string;
  instanceCount: number;
  onInstanceCountChange: (count: number) => void;
}

export function RecurrencePicker({ value, onChange, eventDate, instanceCount, onInstanceCountChange }: RecurrencePickerProps) {
  const frequency: Frequency = useMemo(() => {
    if (value === 'biweekly') return 'biweekly';
    if (value.startsWith('ordinal_weekday:')) return 'ordinal';
    if (value === 'monthly') return 'monthly';
    return 'weekly';
  }, [value]);

  const freqForDuration = frequency === 'ordinal' ? 'monthly' as const : frequency;

  const duration: Duration = useMemo(() => {
    if (instanceCount === 0) return 0;
    for (const months of [1, 3, 6] as const) {
      if (instanceCount === durationToInstanceCount(freqForDuration, months)) return months;
    }
    if (instanceCount <= 4) return 1;
    if (instanceCount <= 13) return 3;
    return 6;
  }, [instanceCount, freqForDuration]);

  const ordinal = useMemo(() => {
    if (!eventDate) return null;
    return getOrdinalWeekday(eventDate);
  }, [eventDate]);

  // Summary
  const summary = useMemo(() => {
    if (!eventDate || instanceCount === 0) return null;
    const start = new Date(eventDate + 'T12:00:00');
    if (isNaN(start.getTime())) return null;

    const totalEvents = instanceCount;

    const endDate = new Date(start);
    switch (freqForDuration) {
      case 'weekly': endDate.setDate(endDate.getDate() + (instanceCount - 1) * 7); break;
      case 'biweekly': endDate.setDate(endDate.getDate() + (instanceCount - 1) * 14); break;
      case 'monthly': endDate.setMonth(endDate.getMonth() + instanceCount - 1); break;
    }

    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${totalEvents} event${totalEvents !== 1 ? 's' : ''} · through ${fmt(endDate)}`;
  }, [eventDate, instanceCount, frequency, freqForDuration]);

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
        onChange('monthly');
        onInstanceCountChange(durationToInstanceCount('monthly', duration));
        break;
      case 'ordinal':
        if (ordinal) {
          onChange(toOrdinalRecurrence(ordinal.ordinal, ordinal.dayName));
        } else {
          onChange('monthly');
        }
        onInstanceCountChange(durationToInstanceCount('monthly', duration));
        break;
    }
  }

  function handleDurationChange(months: Duration) {
    onInstanceCountChange(durationToInstanceCount(freqForDuration, months));
  }

  // --- Styles ---

  const chip = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: radii.pill, padding: '4px 12px', fontSize: '12px',
    cursor: 'pointer', transition: 'all 0.12s', border: '1px solid',
    userSelect: 'none', fontFamily: 'inherit', fontWeight: active ? 500 : 400,
    background: active ? colors.accentDim : 'transparent',
    color: active ? colors.accent : colors.dim,
    borderColor: active ? colors.accentBorder : colors.border,
  });

  return (
    <div style={{
      background: colors.bg,
      border: `1px solid ${colors.border}`,
      borderRadius: radii.md,
      padding: '12px 14px',
      height: '100%',
      boxSizing: 'border-box',
    }}>
      {/* ── Frequency ── */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => handleFrequencyChange('weekly')} style={chip(frequency === 'weekly')}>
          Weekly
        </button>
        <button type="button" onClick={() => handleFrequencyChange('biweekly')} style={chip(frequency === 'biweekly')}>
          Every 2 weeks
        </button>
        <button type="button" onClick={() => handleFrequencyChange('monthly')} style={chip(frequency === 'monthly')}>
          Monthly
        </button>
        {ordinal && (
          <button type="button" onClick={() => handleFrequencyChange('ordinal')} style={chip(frequency === 'ordinal')}>
            {ordinal.label}
          </button>
        )}
      </div>

      {/* ── Duration ── */}
      <div style={{ marginTop: '10px' }}>
        <div style={{ fontSize: '11px', fontWeight: 500, color: colors.muted, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Duration
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {DURATION_OPTIONS.map(({ months, label }) => (
            <button key={months} type="button" onClick={() => handleDurationChange(months)} style={chip(duration === months)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Summary ── */}
      {summary && (
        <div className="tnum" style={{ marginTop: '10px', fontSize: '12px', color: colors.muted }}>
          {summary}
        </div>
      )}
      {duration === 0 && (
        <div style={{ marginTop: '4px', fontSize: '11px', color: colors.dim }}>
          Creates 6 months of events, auto-renews
        </div>
      )}
    </div>
  );
}
