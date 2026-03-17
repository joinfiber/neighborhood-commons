import { useState } from 'react';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import { colors, styles } from '../lib/styles';
import { importPreview, importConfirm } from '../lib/api';
import type { ImportPreviewEvent, ImportPreviewResponse, ImportConfirmResponse, PortalAccount } from '../lib/api';
import { ImageCropPreview } from '../components/ImageCropPreview';

// =============================================================================
// TYPES
// =============================================================================

type Step = 'input' | 'preview' | 'result';

interface ImportEventsScreenProps {
  account: PortalAccount;
  onDone: (count: number) => void;
}

// =============================================================================
// HELPERS
// =============================================================================

function formatPreviewDate(iso: string, tz: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatPreviewTime(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

// =============================================================================
// SCREEN
// =============================================================================

export function ImportEventsScreen({ onDone }: ImportEventsScreenProps) {
  // Step 1: input
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState<string>('live_music');
  const [timezone, setTimezone] = useState('America/New_York');

  // Step 2: preview
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [focalYMap, setFocalYMap] = useState<Record<number, number>>({});

  // Step 3: result
  const [result, setResult] = useState<ImportConfirmResponse | null>(null);

  // UI state
  const [step, setStep] = useState<Step>('input');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Step 1: Preview ──

  async function handlePreview(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError(null);
    const res = await importPreview(url.trim(), category, timezone);
    setLoading(false);

    if (res.error) {
      setError(res.error.message);
      return;
    }

    if (res.data) {
      setPreview(res.data);
      // Auto-select all events that aren't already imported
      const indices = new Set(
        res.data.events
          .filter((ev) => !ev.already_exists)
          .map((ev) => ev.index),
      );
      setSelected(indices);
      setStep('preview');
    }
  }

  // ── Step 2: Confirm ──

  async function handleConfirm() {
    if (!preview || selected.size === 0) return;

    setLoading(true);
    setError(null);

    // Build overrides for events that have custom focal points
    const overrides: Record<string, { image_focal_y?: number }> = {};
    for (const idx of selected) {
      const fy = focalYMap[idx];
      if (fy !== undefined) {
        overrides[String(idx)] = { image_focal_y: fy };
      }
    }

    const res = await importConfirm({
      url: preview.source_url,
      source_type: preview.source_type,
      category,
      event_timezone: timezone,
      events: Array.from(selected),
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    });
    setLoading(false);

    if (res.error) {
      setError(res.error.message);
      return;
    }

    if (res.data) {
      setResult(res.data);
      setStep('result');
    }
  }

  // ── Toggle selection ──

  function toggleEvent(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleAll() {
    if (!preview) return;
    const selectable = preview.events.filter((ev) => !ev.already_exists);
    if (selected.size === selectable.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable.map((ev) => ev.index)));
    }
  }

  // ── Render ──

  return (
    <>
      <h1 style={{ ...styles.pageTitle, marginBottom: '24px' }}>Import Events</h1>

        {error && (
          <div style={{
            background: '#fef2f2',
            color: colors.error,
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: '14px',
            marginBottom: '16px',
          }}>
            {error}
          </div>
        )}

        {step === 'input' && (
          <InputStep
            url={url}
            setUrl={setUrl}
            category={category}
            setCategory={setCategory}
            timezone={timezone}
            setTimezone={setTimezone}
            loading={loading}
            onSubmit={handlePreview}
          />
        )}

        {step === 'preview' && preview && (
          <PreviewStep
            preview={preview}
            selected={selected}
            category={category}
            timezone={timezone}
            loading={loading}
            focalYMap={focalYMap}
            onFocalYChange={(idx, y) => setFocalYMap((prev) => ({ ...prev, [idx]: y }))}
            onToggle={toggleEvent}
            onToggleAll={toggleAll}
            onConfirm={handleConfirm}
            onBack={() => { setStep('input'); setPreview(null); setError(null); }}
          />
        )}

        {step === 'result' && result && (
          <ResultStep
            result={result}
            onDone={() => onDone(result.total_created)}
          />
        )}
    </>
  );
}

// =============================================================================
// STEP 1: URL INPUT
// =============================================================================

function InputStep({ url, setUrl, category, setCategory, timezone, setTimezone, loading, onSubmit }: {
  url: string;
  setUrl: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
  timezone: string;
  setTimezone: (v: string) => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit}>
      <div style={{ ...styles.card, marginBottom: '16px' }}>
        <label style={styles.formLabel}>Feed URL</label>
        <input
          type="url"
          placeholder="https://example.com/events.ics or Eventbrite URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={styles.input}
          required
          autoFocus
        />
        <p style={{ ...styles.helperText, marginTop: '8px' }}>
          Paste an iCal feed URL (.ics) or an Eventbrite event/organizer page URL.
        </p>
      </div>

      <div style={{ ...styles.card, marginBottom: '16px' }}>
        <label style={styles.formLabel}>Default category</label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={styles.select}
        >
          {Object.entries(PORTAL_CATEGORIES).map(([key, cat]) => (
            <option key={key} value={key}>{cat.label}</option>
          ))}
        </select>
        <p style={styles.helperText}>
          Applied to all imported events. You can change individual events later.
        </p>
      </div>

      <div style={{ ...styles.card, marginBottom: '20px' }}>
        <label style={styles.formLabel}>Timezone</label>
        <select
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          style={styles.select}
        >
          <option value="America/New_York">Eastern (New York)</option>
          <option value="America/Chicago">Central (Chicago)</option>
          <option value="America/Denver">Mountain (Denver)</option>
          <option value="America/Los_Angeles">Pacific (Los Angeles)</option>
          <option value="UTC">UTC</option>
        </select>
        <p style={styles.helperText}>
          Used when the feed doesn't include timezone information.
        </p>
      </div>

      <button
        type="submit"
        className="btn-primary"
        style={styles.buttonPrimary}
        disabled={loading || !url.trim()}
      >
        {loading ? 'Fetching events...' : 'Preview Events'}
      </button>
    </form>
  );
}

// =============================================================================
// STEP 2: PREVIEW
// =============================================================================

function PreviewStep({ preview, selected, category, timezone, loading, focalYMap, onFocalYChange, onToggle, onToggleAll, onConfirm, onBack }: {
  preview: ImportPreviewResponse;
  selected: Set<number>;
  category: string;
  timezone: string;
  loading: boolean;
  focalYMap: Record<number, number>;
  onFocalYChange: (index: number, y: number) => void;
  onToggle: (index: number) => void;
  onToggleAll: () => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const selectable = preview.events.filter((ev) => !ev.already_exists);
  const allSelected = selectable.length > 0 && selected.size === selectable.length;
  const catLabel = PORTAL_CATEGORIES[category as PortalCategory]?.label || category;

  return (
    <div>
      {/* Source info */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '12px',
      }}>
        <div>
          <span style={{ fontSize: '13px', color: colors.muted }}>
            {preview.total_parsed} event{preview.total_parsed !== 1 ? 's' : ''} found
          </span>
          <span style={{ fontSize: '13px', color: colors.dim, marginLeft: '8px' }}>
            via {preview.source_type === 'eventbrite' ? 'Eventbrite' : 'iCal feed'}
          </span>
        </div>
        <span style={{
          fontSize: '11px',
          padding: '2px 8px',
          borderRadius: '10px',
          background: colors.accentDim,
          color: colors.accent,
          border: `1px solid ${colors.accentBorder}`,
        }}>
          {catLabel}
        </span>
      </div>

      {/* Warnings */}
      {preview.warnings.map((w, i) => (
        <div key={i} style={{
          background: '#fef3cd',
          border: '1px solid #fde68a',
          borderRadius: '8px',
          padding: '8px 12px',
          fontSize: '13px',
          color: '#92600a',
          marginBottom: '10px',
        }}>
          {w}
        </div>
      ))}

      {/* Select all */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '10px',
        padding: '0 2px',
      }}>
        <button
          type="button"
          onClick={onToggleAll}
          style={{
            background: 'none',
            border: 'none',
            fontSize: '13px',
            color: colors.muted,
            cursor: 'pointer',
            padding: '4px 0',
            fontFamily: 'inherit',
          }}
        >
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
        <span style={{ fontSize: '13px', color: colors.dim }}>
          {selected.size} selected
        </span>
      </div>

      {/* Event list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '20px' }}>
        {preview.events.map((ev) => (
          <PreviewEventRow
            key={ev.index}
            event={ev}
            timezone={timezone}
            checked={selected.has(ev.index)}
            focalY={focalYMap[ev.index] ?? 0.5}
            onFocalYChange={(y) => onFocalYChange(ev.index, y)}
            onToggle={() => onToggle(ev.index)}
          />
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          type="button"
          className="btn-primary"
          style={{ ...styles.buttonPrimary, flex: 1 }}
          disabled={loading || selected.size === 0}
          onClick={onConfirm}
        >
          {loading ? 'Importing...' : `Import ${selected.size} Event${selected.size !== 1 ? 's' : ''}`}
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{ ...styles.buttonSecondary, width: 'auto', padding: '12px 20px' }}
          onClick={onBack}
          disabled={loading}
        >
          Back
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// PREVIEW EVENT ROW
// =============================================================================

function PreviewEventRow({ event, timezone, checked, focalY, onFocalYChange, onToggle }: {
  event: ImportPreviewEvent;
  timezone: string;
  checked: boolean;
  focalY: number;
  onFocalYChange: (y: number) => void;
  onToggle: () => void;
}) {
  const [showCrop, setShowCrop] = useState(false);
  const tz = event.timezone || timezone;
  const disabled = event.already_exists;
  const hasImage = !!event.image_url;

  return (
    <div
      style={{
        background: colors.card,
        border: `1px solid ${checked ? colors.accent : colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
        opacity: disabled ? 0.45 : 1,
        transition: 'border-color 0.15s',
      }}
    >
      {/* Image thumbnail strip — shows how the image looks with current focal point */}
      {hasImage && checked && (
        <div
          onClick={(e) => { e.stopPropagation(); if (!disabled) setShowCrop(!showCrop); }}
          style={{
            position: 'relative',
            width: '100%',
            height: '80px',
            overflow: 'hidden',
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          <img
            src={event.image_url!}
            alt=""
            draggable={false}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: `center ${focalY * 100}%`,
              display: 'block',
            }}
          />
          {!disabled && (
            <div style={{
              position: 'absolute',
              bottom: '4px',
              right: '6px',
              fontSize: '10px',
              color: '#fff',
              background: 'rgba(0,0,0,0.55)',
              padding: '1px 6px',
              borderRadius: '6px',
              pointerEvents: 'none',
            }}>
              {showCrop ? 'tap to close' : 'tap to adjust crop'}
            </div>
          )}
        </div>
      )}

      {/* Main row: checkbox + info */}
      <div
        onClick={disabled ? undefined : onToggle}
        style={{
          padding: '12px 14px',
          cursor: disabled ? 'default' : 'pointer',
          display: 'flex',
          gap: '12px',
          alignItems: 'flex-start',
        }}
      >
        {/* Checkbox */}
        <div
          style={{
            width: '18px',
            height: '18px',
            borderRadius: '3px',
            border: `1.5px solid ${checked ? colors.accent : colors.dim}`,
            background: checked ? colors.accent : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginTop: '2px',
          }}
        >
          {checked && (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>

        {/* Unchecked image thumbnail */}
        {hasImage && !checked && (
          <div style={{
            width: '48px',
            height: '48px',
            borderRadius: '6px',
            overflow: 'hidden',
            flexShrink: 0,
          }}>
            <img
              src={event.image_url!}
              alt=""
              draggable={false}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: `center ${focalY * 100}%`,
                display: 'block',
              }}
            />
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 500, color: colors.cream, marginBottom: '3px' }}>
            {event.name}
          </div>
          <div style={{ fontSize: '13px', color: colors.muted }}>
            {formatPreviewDate(event.start, tz)} &middot; {formatPreviewTime(event.start, tz)}
            {event.end && ` – ${formatPreviewTime(event.end, tz)}`}
          </div>
          {event.venue_name && (
            <div style={{ fontSize: '12px', color: colors.dim, marginTop: '2px' }}>
              {event.venue_name}
            </div>
          )}
          {event.already_exists && (
            <span style={{
              fontSize: '10px',
              color: '#92600a',
              background: '#fef3cd',
              border: '1px solid #fde68a',
              borderRadius: '10px',
              padding: '1px 6px',
              marginTop: '4px',
              display: 'inline-block',
            }}>
              already imported
            </span>
          )}
        </div>
      </div>

      {/* Expanded crop preview */}
      {hasImage && checked && showCrop && !disabled && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ padding: '0 14px 14px' }}
        >
          <ImageCropPreview
            imageSrc={event.image_url!}
            focalY={focalY}
            onFocalYChange={onFocalYChange}
          />
        </div>
      )}
    </div>
  );
}

// =============================================================================
// STEP 3: RESULT
// =============================================================================

function ResultStep({ result, onDone }: {
  result: ImportConfirmResponse;
  onDone: () => void;
}) {
  return (
    <div>
      {/* Success summary */}
      <div style={{
        ...styles.card,
        textAlign: 'center' as const,
        marginBottom: '16px',
      }}>
        <div style={{ fontSize: '36px', marginBottom: '8px', opacity: 0.3 }}>
          {result.total_created > 0 ? '\u2713' : '\u2717'}
        </div>
        <div style={{ fontSize: '18px', fontWeight: 500, color: colors.cream, marginBottom: '4px' }}>
          {result.total_created} event{result.total_created !== 1 ? 's' : ''} imported
        </div>
        {result.total_skipped > 0 && (
          <div style={{ fontSize: '13px', color: colors.muted }}>
            {result.total_skipped} skipped
          </div>
        )}
      </div>

      {/* Created list */}
      {result.created.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '12px', fontWeight: 500, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>
            Created
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {result.created.map((ev) => (
              <div key={ev.id} style={{
                background: colors.card,
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
                padding: '10px 14px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <span style={{ fontSize: '14px', color: colors.cream }}>{ev.name}</span>
                {ev.status === 'pending_review' && (
                  <span style={{
                    fontSize: '10px',
                    color: '#92600a',
                    background: '#fef3cd',
                    border: '1px solid #fde68a',
                    borderRadius: '10px',
                    padding: '1px 6px',
                  }}>
                    pending
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Skipped list */}
      {result.skipped.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '12px', fontWeight: 500, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>
            Skipped
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {result.skipped.map((ev, i) => (
              <div key={i} style={{
                background: colors.card,
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
                padding: '10px 14px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                opacity: 0.6,
              }}>
                <span style={{ fontSize: '14px', color: colors.muted }}>{ev.name}</span>
                <span style={{ fontSize: '12px', color: colors.dim }}>{ev.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        className="btn-primary"
        style={styles.buttonPrimary}
        onClick={onDone}
      >
        Done
      </button>
    </div>
  );
}
