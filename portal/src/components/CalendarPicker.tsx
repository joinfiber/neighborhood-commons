import { useState, useMemo, useEffect, useRef } from 'react';
import { colors } from '../lib/styles';

interface CalendarPickerProps {
  value: string; // YYYY-MM-DD
  onChange: (date: string) => void;
}

const DAY_HEADERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function formatDisplay(value: string): string {
  if (!value) return '';
  const d = new Date(value + 'T12:00:00');
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function CalendarPicker({ value, onChange }: CalendarPickerProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const today = new Date();
  const todayStr = toDateStr(today.getFullYear(), today.getMonth(), today.getDate());

  const selected = value ? new Date(value + 'T12:00:00') : null;
  const initialYear = selected ? selected.getFullYear() : today.getFullYear();
  const initialMonth = selected ? selected.getMonth() : today.getMonth();

  const [viewYear, setViewYear] = useState(initialYear);
  const [viewMonth, setViewMonth] = useState(initialMonth);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const { days } = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const offset = firstDay.getDay();

    const allDays: Array<{ day: number; dateStr: string; inMonth: boolean }> = [];

    const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();
    for (let i = offset - 1; i >= 0; i--) {
      const d = prevMonthDays - i;
      const m = viewMonth === 0 ? 11 : viewMonth - 1;
      const y = viewMonth === 0 ? viewYear - 1 : viewYear;
      allDays.push({ day: d, dateStr: toDateStr(y, m, d), inMonth: false });
    }

    for (let d = 1; d <= daysInMonth; d++) {
      allDays.push({ day: d, dateStr: toDateStr(viewYear, viewMonth, d), inMonth: true });
    }

    const remaining = 7 - (allDays.length % 7);
    if (remaining < 7) {
      for (let d = 1; d <= remaining; d++) {
        const m = viewMonth === 11 ? 0 : viewMonth + 1;
        const y = viewMonth === 11 ? viewYear + 1 : viewYear;
        allDays.push({ day: d, dateStr: toDateStr(y, m, d), inMonth: false });
      }
    }

    return { days: allDays };
  }, [viewYear, viewMonth]);

  const prevMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
    else setViewMonth(viewMonth - 1);
  };

  const nextMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
    else setViewMonth(viewMonth + 1);
  };

  const handleSelect = (dateStr: string) => {
    onChange(dateStr);
    setOpen(false);
  };

  const handleOpen = () => {
    // Sync view to current value when opening
    if (selected) {
      setViewYear(selected.getFullYear());
      setViewMonth(selected.getMonth());
    }
    setOpen(true);
  };

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      {/* Collapsed: styled input */}
      <button
        type="button"
        onClick={handleOpen}
        style={{
          ...triggerStyle,
          color: value ? colors.text : colors.dim,
          borderColor: open ? colors.accent : colors.border,
        }}
      >
        <span>{value ? formatDisplay(value) : 'Select date'}</span>
        <span style={{ color: colors.dim, fontSize: '10px' }}>&#9662;</span>
      </button>

      {/* Expanded: dropdown calendar */}
      {open && (
        <div style={dropdownStyle}>
          {/* Month nav */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <button type="button" onClick={prevMonth} style={navBtn}>&#8249;</button>
            <span style={{ fontSize: '11px', fontWeight: 500, color: colors.cream, letterSpacing: '0.02em' }}>
              {monthLabel}
            </span>
            <button type="button" onClick={nextMonth} style={navBtn}>&#8250;</button>
          </div>

          {/* Day headers */}
          <div style={gridStyle}>
            {DAY_HEADERS.map((d, i) => (
              <div key={i} style={{ textAlign: 'center', fontSize: '9px', color: colors.dim, padding: '1px 0', userSelect: 'none' }}>
                {d}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div style={gridStyle}>
            {days.map(({ day, dateStr, inMonth }, i) => {
              const isSelected = dateStr === value;
              const isToday = dateStr === todayStr;

              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleSelect(dateStr)}
                  style={{
                    ...cellStyle,
                    color: isSelected ? '#ffffff' : inMonth ? colors.text : colors.dim,
                    background: isSelected ? colors.accent : 'transparent',
                    borderRadius: '4px',
                    fontWeight: isSelected ? 600 : 400,
                    position: 'relative' as const,
                  }}
                >
                  {day}
                  {isToday && !isSelected && (
                    <span style={{
                      position: 'absolute' as const,
                      bottom: '1px',
                      left: '50%',
                      transform: 'translateX(-50%)',
                      width: '2px',
                      height: '2px',
                      borderRadius: '50%',
                      background: colors.accent,
                    }} />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const triggerStyle: React.CSSProperties = {
  background: colors.bg,
  border: `1px solid ${colors.border}`,
  borderRadius: '8px',
  color: colors.text,
  fontSize: '14px',
  padding: '10px 12px',
  outline: 'none',
  width: '100%',
  transition: 'border-color 0.15s',
  cursor: 'pointer',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontFamily: 'inherit',
  textAlign: 'left' as const,
};

const dropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  marginTop: '4px',
  background: colors.card,
  border: `1px solid ${colors.border}`,
  borderRadius: '10px',
  padding: '10px',
  zIndex: 50,
  width: '240px',
  boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
};

const navBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: colors.muted,
  fontSize: '14px',
  cursor: 'pointer',
  padding: '2px 6px',
  borderRadius: '4px',
  lineHeight: 1,
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(7, 1fr)',
  gap: '0px',
};

const cellStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  aspectRatio: '1',
  minHeight: '24px',
  border: 'none',
  cursor: 'pointer',
  fontSize: '11px',
  transition: 'background 0.1s',
  fontFamily: 'inherit',
};
