import { useMemo } from 'react';
import { colors } from '../lib/styles';

interface TimePickerProps {
  value: string; // HH:MM (24h)
  onChange: (time: string) => void;
  label?: string;
}

function parse24h(value: string): { hour12: number; minute: number; ampm: 'AM' | 'PM' } {
  const [hStr, mStr] = value.split(':');
  let h = parseInt(hStr ?? '12', 10);
  const m = parseInt(mStr ?? '0', 10);

  const ampm: 'AM' | 'PM' = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;

  return { hour12: h, minute: m, ampm };
}

function to24h(hour12: number, minute: number, ampm: 'AM' | 'PM'): string {
  let h = hour12;
  if (ampm === 'AM' && h === 12) h = 0;
  else if (ampm === 'PM' && h !== 12) h += 12;
  return `${h < 10 ? '0' : ''}${h}:${minute < 10 ? '0' : ''}${minute}`;
}

const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES = [0, 15, 30, 45];

export function TimePicker({ value, onChange }: TimePickerProps) {
  const { hour12, minute, ampm } = useMemo(() => parse24h(value || '19:00'), [value]);

  // Snap minute to nearest 15
  const snappedMinute = MINUTES.reduce((prev, curr) =>
    Math.abs(curr - minute) < Math.abs(prev - minute) ? curr : prev
  );

  const handleHour = (h: number) => onChange(to24h(h, snappedMinute, ampm));
  const handleMinute = (m: number) => onChange(to24h(hour12, m, ampm));
  const handleAmPm = (v: 'AM' | 'PM') => onChange(to24h(hour12, snappedMinute, v));

  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
      {/* Hour */}
      <select
        value={hour12}
        onChange={(e) => handleHour(parseInt(e.target.value, 10))}
        style={selectStyle}
      >
        {HOURS.map((h) => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>

      <span style={{ color: colors.muted, fontSize: '16px', fontWeight: 500 }}>:</span>

      {/* Minute */}
      <select
        value={snappedMinute}
        onChange={(e) => handleMinute(parseInt(e.target.value, 10))}
        style={selectStyle}
      >
        {MINUTES.map((m) => (
          <option key={m} value={m}>{m < 10 ? `0${m}` : m}</option>
        ))}
      </select>

      {/* AM/PM */}
      <select
        value={ampm}
        onChange={(e) => handleAmPm(e.target.value as 'AM' | 'PM')}
        style={{ ...selectStyle, width: '64px' }}
      >
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: colors.bg,
  border: `1px solid ${colors.border}`,
  borderRadius: '8px',
  color: colors.text,
  fontSize: '14px',
  padding: '8px 10px',
  outline: 'none',
  width: '58px',
  textAlign: 'center',
  cursor: 'pointer',
  fontFamily: 'inherit',
  appearance: 'none',
  WebkitAppearance: 'none',
};
