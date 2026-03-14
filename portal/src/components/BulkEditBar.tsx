/**
 * BulkEditBar — inline bulk-edit form for selected events.
 *
 * All fields shown at once. Each starts "unchanged."
 * Only fields the user touches get sent.
 * Description + price are the high-frequency bulk fields;
 * category/accessible/arrive-by are less common but still useful.
 */

import { useState } from 'react';
import { PORTAL_CATEGORIES, PORTAL_CATEGORY_KEYS } from '../lib/categories';
import { colors } from '../lib/styles';

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
  const [description, setDescription] = useState(UNCHANGED);
  const [price, setPrice] = useState(UNCHANGED);

  const dirty =
    category !== UNCHANGED ||
    wheelchair !== UNCHANGED ||
    startTimeReq !== UNCHANGED ||
    description !== UNCHANGED ||
    price !== UNCHANGED;

  // Build a human-readable summary of what will change
  const changeSummary = (): string => {
    const parts: string[] = [];
    if (category !== UNCHANGED) parts.push('category');
    if (description !== UNCHANGED) parts.push('description');
    if (price !== UNCHANGED) parts.push('price');
    if (wheelchair !== UNCHANGED) parts.push('accessibility');
    if (startTimeReq !== UNCHANGED) parts.push('arrive-by-start');
    if (parts.length === 0) return 'Select a field to change';
    return `Update ${parts.join(', ')} on ${selectedCount} event${selectedCount !== 1 ? 's' : ''}`;
  };

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
    if (description !== UNCHANGED) {
      updates.description = description || null;
    }
    if (price !== UNCHANGED) {
      updates.price = price || null;
    }

    if (Object.keys(updates).length > 0) onApply(updates);
  };

  const label: React.CSSProperties = {
    fontSize: '12px',
    fontWeight: 500,
    color: colors.muted,
    marginBottom: '4px',
    display: 'block',
  };

  const selectStyle: React.CSSProperties = {
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

  const dimWhenUnchanged = (val: string): React.CSSProperties =>
    val === UNCHANGED ? { color: colors.dim } : {};

  const inputStyle: React.CSSProperties = {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: '6px',
    color: colors.text,
    fontSize: '13px',
    padding: '7px 8px',
    outline: 'none',
    width: '100%',
  };

  return (
    <div style={{
      background: colors.card,
      border: `1px solid ${colors.border}`,
      borderRadius: '10px',
      padding: '14px 16px',
      marginBottom: '12px',
    }}>
      {/* Header */}
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

      {/* Description — full width, most common bulk edit */}
      <div style={{ marginBottom: '10px' }}>
        <label style={label}>
          Description
          {description !== UNCHANGED && (
            <span style={{ fontWeight: 400, color: colors.dim, marginLeft: '6px' }}>
              — replaces existing
            </span>
          )}
        </label>
        <textarea
          style={{
            ...inputStyle,
            minHeight: '56px',
            resize: 'vertical',
            color: description === UNCHANGED ? colors.dim : colors.text,
          }}
          placeholder="No change"
          value={description === UNCHANGED ? '' : description}
          onFocus={() => { if (description === UNCHANGED) setDescription(''); }}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {/* Inline fields row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: '10px',
        marginBottom: '12px',
      }}>
        {/* Price */}
        <div>
          <label style={label}>Price</label>
          <input
            type="text"
            style={{
              ...inputStyle,
              color: price === UNCHANGED ? colors.dim : colors.text,
            }}
            placeholder="No change"
            value={price === UNCHANGED ? '' : price}
            onFocus={() => { if (price === UNCHANGED) setPrice(''); }}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>

        {/* Category */}
        <div>
          <label style={label}>Category</label>
          <select
            style={{ ...selectStyle, ...dimWhenUnchanged(category) }}
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

        {/* Accessible */}
        <div>
          <label style={label}>Accessible</label>
          <select
            style={{ ...selectStyle, ...dimWhenUnchanged(wheelchair) }}
            value={wheelchair}
            onChange={(e) => setWheelchair(e.target.value)}
          >
            <option value={UNCHANGED}>No change</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
            <option value="null">Account default</option>
          </select>
        </div>

        {/* Arrive by start */}
        <div>
          <label style={label}>Arrive by start</label>
          <select
            style={{ ...selectStyle, ...dimWhenUnchanged(startTimeReq) }}
            value={startTimeReq}
            onChange={(e) => setStartTimeReq(e.target.value)}
          >
            <option value={UNCHANGED}>No change</option>
            <option value="true">Yes</option>
            <option value="false">No (anytime)</option>
          </select>
        </div>
      </div>

      {/* Apply */}
      <button
        type="button"
        onClick={handleApply}
        disabled={!dirty || applying}
        style={{
          background: dirty ? colors.accent : colors.border,
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
        {applying ? 'Applying...' : changeSummary()}
      </button>
    </div>
  );
}
