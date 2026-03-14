/**
 * BulkEditBar — inline bulk-edit form for selected events.
 *
 * All fields are shown at once. Each starts in an "unchanged" state.
 * Only fields the user actually touches get included in the update.
 * Quiet, flat design — feels like part of the list, not a modal.
 */

import { useState } from 'react';
import { PORTAL_CATEGORIES, PORTAL_CATEGORY_KEYS, type PortalCategory } from '../lib/categories';
import { colors } from '../lib/styles';

// Sentinel value meaning "don't change this field"
const UNCHANGED = '__unchanged__';

interface BulkEditBarProps {
  selectedCount: number;
  onApply: (updates: Record<string, unknown>) => void;
  onCancel: () => void;
  applying: boolean;
}

export function BulkEditBar({ selectedCount, onApply, onCancel, applying }: BulkEditBarProps) {
  const [category, setCategory] = useState(UNCHANGED);
  const [wheelchair, setWheelchair] = useState(UNCHANGED);
  const [startTimeReq, setStartTimeReq] = useState(UNCHANGED);

  const dirty =
    category !== UNCHANGED ||
    wheelchair !== UNCHANGED ||
    startTimeReq !== UNCHANGED;

  const handleApply = () => {
    const updates: Record<string, unknown> = {};

    if (category !== UNCHANGED) updates.category = category;
    if (wheelchair !== UNCHANGED) {
      updates.wheelchair_accessible =
        wheelchair === 'true' ? true : wheelchair === 'false' ? false : null;
    }
    if (startTimeReq !== UNCHANGED) {
      updates.start_time_required = startTimeReq === 'true';
    }

    if (Object.keys(updates).length > 0) onApply(updates);
  };

  const fieldLabel: React.CSSProperties = {
    fontSize: '12px',
    fontWeight: 500,
    color: colors.muted,
    marginBottom: '4px',
    display: 'block',
  };

  const fieldSelect: React.CSSProperties = {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: '6px',
    color: colors.text,
    fontSize: '13px',
    padding: '7px 28px 7px 8px',
    outline: 'none',
    width: '100%',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 4l3 3 3-3' stroke='%236b6660' fill='none' stroke-width='1.2'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 8px center',
  };

  const unchangedStyle: React.CSSProperties = {
    color: colors.dim,
  };

  return (
    <div style={{
      background: colors.card,
      border: `1px solid ${colors.border}`,
      borderRadius: '10px',
      padding: '14px 16px',
      marginBottom: '12px',
    }}>
      {/* Header row */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '12px',
      }}>
        <span style={{ fontSize: '13px', color: colors.text }}>
          Edit <strong>{selectedCount}</strong> event{selectedCount !== 1 ? 's' : ''}
        </span>
        <button
          type="button"
          onClick={onCancel}
          style={{
            background: 'none',
            border: 'none',
            fontSize: '12px',
            color: colors.muted,
            cursor: 'pointer',
            padding: '2px 6px',
          }}
        >
          Cancel
        </button>
      </div>

      {/* Fields — horizontal on wider screens, stacked on narrow */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '10px',
        marginBottom: '12px',
      }}>
        {/* Category */}
        <div>
          <label style={fieldLabel}>Category</label>
          <select
            style={{ ...fieldSelect, ...(category === UNCHANGED ? unchangedStyle : {}) }}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value={UNCHANGED}>No change</option>
            {PORTAL_CATEGORY_KEYS.map((key) => (
              <option key={key} value={key}>
                {PORTAL_CATEGORIES[key].label}
              </option>
            ))}
          </select>
        </div>

        {/* Wheelchair */}
        <div>
          <label style={fieldLabel}>Accessible</label>
          <select
            style={{ ...fieldSelect, ...(wheelchair === UNCHANGED ? unchangedStyle : {}) }}
            value={wheelchair}
            onChange={(e) => setWheelchair(e.target.value)}
          >
            <option value={UNCHANGED}>No change</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
            <option value="null">Account default</option>
          </select>
        </div>

        {/* Start time required */}
        <div>
          <label style={fieldLabel}>Arrive by start</label>
          <select
            style={{ ...fieldSelect, ...(startTimeReq === UNCHANGED ? unchangedStyle : {}) }}
            value={startTimeReq}
            onChange={(e) => setStartTimeReq(e.target.value)}
          >
            <option value={UNCHANGED}>No change</option>
            <option value="true">Yes</option>
            <option value="false">No (anytime)</option>
          </select>
        </div>
      </div>

      {/* Apply button */}
      <button
        type="button"
        onClick={handleApply}
        disabled={!dirty || applying}
        style={{
          background: dirty ? colors.amber : colors.border,
          color: dirty ? '#fff' : colors.dim,
          border: 'none',
          borderRadius: '6px',
          padding: '8px 20px',
          fontSize: '13px',
          fontWeight: 500,
          cursor: dirty ? 'pointer' : 'default',
          transition: 'background 0.15s, color 0.15s',
          width: '100%',
        }}
      >
        {applying ? 'Applying...' : dirty ? 'Apply changes' : 'Choose a field to change'}
      </button>
    </div>
  );
}
