import { useState, useRef, useCallback } from 'react';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import { colors, styles } from '../lib/styles';
import { csvUpload, csvPreview, csvConfirm } from '../lib/api';
import type {
  PortalAccount,
  CsvUploadResponse,
  CsvPreviewResponse,
  CsvConfirmResponse,
  CsvPreviewRow,
} from '../lib/api';

// =============================================================================
// TYPES
// =============================================================================

type Step = 'upload' | 'map' | 'preview' | 'result';

interface ContributeScreenProps {
  account: PortalAccount;
  onDone: (count: number) => void;
}

// =============================================================================
// SCREEN
// =============================================================================

export function ContributeScreen({ account, onDone }: ContributeScreenProps) {
  // Step 1: upload
  const [csvText, setCsvText] = useState('');
  const [fileName, setFileName] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [uploadResult, setUploadResult] = useState<CsvUploadResponse | null>(null);

  // Step 2: map
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [defaultCategory, setDefaultCategory] = useState<string>('community');
  const [categoryColumn, setCategoryColumn] = useState<string>('');
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, string>>({});

  // Step 3: preview
  const [previewResult, setPreviewResult] = useState<CsvPreviewResponse | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Step 4: result
  const [confirmResult, setConfirmResult] = useState<CsvConfirmResponse | null>(null);

  // UI state
  const [step, setStep] = useState<Step>('upload');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Step 1: Upload ──

  async function handleUpload() {
    if (!csvText.trim()) return;
    setLoading(true);
    setError(null);

    const res = await csvUpload(csvText, fileName, timezone);
    setLoading(false);

    if (res.error) {
      setError(res.error.message);
      return;
    }

    if (res.data) {
      setUploadResult(res.data);
      setColumnMapping(res.data.suggested_mapping);

      // Auto-detect if there's a category column mapped
      const catHeader = Object.entries(res.data.suggested_mapping).find(([, v]) => v === 'category');
      if (catHeader) setCategoryColumn(catHeader[0]);

      setStep('map');
    }
  }

  // ── Step 2: Preview ──

  async function handlePreview() {
    if (!uploadResult) return;
    setLoading(true);
    setError(null);

    const res = await csvPreview({
      batch_id: uploadResult.batch_id,
      column_mapping: columnMapping,
      default_category: defaultCategory,
      category_column: categoryColumn || undefined,
      category_overrides: Object.keys(categoryOverrides).length > 0 ? categoryOverrides : undefined,
    });
    setLoading(false);

    if (res.error) {
      setError(res.error.message);
      return;
    }

    if (res.data) {
      setPreviewResult(res.data);
      // Auto-select all valid rows
      setSelected(new Set(res.data.valid_rows.map(r => r.row_number)));
      setStep('preview');
    }
  }

  // ── Step 3: Confirm ──

  async function handleConfirm() {
    if (!uploadResult || selected.size === 0) return;
    setLoading(true);
    setError(null);

    const res = await csvConfirm(uploadResult.batch_id, Array.from(selected));
    setLoading(false);

    if (res.error) {
      setError(res.error.message);
      return;
    }

    if (res.data) {
      setConfirmResult(res.data);
      setStep('result');
    }
  }

  // ── Render ──

  return (
    <>
      <h1 style={{ ...styles.pageTitle, marginBottom: '24px' }}>Upload CSV</h1>

      {error && (
        <div style={{
          background: colors.errorBg,
          color: colors.error,
          border: `1px solid ${colors.errorBorder}`,
          padding: '10px 14px',
          borderRadius: '8px',
          fontSize: '14px',
          marginBottom: '16px',
        }}>
          {error}
        </div>
      )}

      {step === 'upload' && (
        <UploadStep
          csvText={csvText}
          setCsvText={setCsvText}
          fileName={fileName}
          setFileName={setFileName}
          timezone={timezone}
          setTimezone={setTimezone}
          loading={loading}
          onSubmit={handleUpload}
        />
      )}

      {step === 'map' && uploadResult && (
        <MappingStep
          upload={uploadResult}
          columnMapping={columnMapping}
          setColumnMapping={setColumnMapping}
          defaultCategory={defaultCategory}
          setDefaultCategory={setDefaultCategory}
          categoryColumn={categoryColumn}
          setCategoryColumn={setCategoryColumn}
          loading={loading}
          onPreview={handlePreview}
          onBack={() => { setStep('upload'); setUploadResult(null); setError(null); }}
        />
      )}

      {step === 'preview' && previewResult && (
        <PreviewStep
          preview={previewResult}
          selected={selected}
          setSelected={setSelected}
          unmappedCategories={previewResult.unmapped_categories}
          categoryOverrides={categoryOverrides}
          setCategoryOverrides={setCategoryOverrides}
          loading={loading}
          onConfirm={handleConfirm}
          onBack={() => { setStep('map'); setPreviewResult(null); setError(null); }}
          onRepreview={async () => {
            // Re-run preview with updated category overrides
            setPreviewResult(null);
            setError(null);
            await handlePreview();
          }}
        />
      )}

      {step === 'result' && confirmResult && (
        <ResultStep
          result={confirmResult}
          onDone={() => onDone(confirmResult.total_created)}
        />
      )}
    </>
  );
}

// =============================================================================
// STEP 1: FILE UPLOAD
// =============================================================================

function UploadStep({ csvText, setCsvText, fileName, setFileName, timezone, setTimezone, loading, onSubmit }: {
  csvText: string;
  setCsvText: (v: string) => void;
  fileName: string;
  setFileName: (v: string) => void;
  timezone: string;
  setTimezone: (v: string) => void;
  loading: boolean;
  onSubmit: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.csv') && !file.type.includes('csv') && !file.type.includes('text')) {
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      if (text) setCsvText(text);
    };
    reader.readAsText(file);
  }, [setCsvText, setFileName]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div>
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
        style={{
          ...styles.card,
          border: `2px dashed ${isDragging ? colors.accent : colors.border}`,
          borderRadius: '12px',
          padding: '40px 20px',
          textAlign: 'center',
          cursor: 'pointer',
          marginBottom: '16px',
          transition: 'border-color 0.15s',
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        {fileName ? (
          <>
            <div style={{ fontSize: '14px', fontWeight: 500, color: colors.heading, marginBottom: '4px' }}>
              {fileName}
            </div>
            <div style={{ fontSize: '13px', color: colors.muted }}>
              {csvText.split('\n').length - 1} rows detected
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: '14px', color: colors.muted, marginBottom: '4px' }}>
              Drop a CSV file here or click to browse
            </div>
            <div style={{ fontSize: '12px', color: colors.dim }}>
              .csv files up to 500 rows
            </div>
          </>
        )}
      </div>

      {/* Timezone */}
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
          Used when dates in the CSV don't include timezone information.
        </p>
      </div>

      {/* Sample preview */}
      {csvText && (
        <div style={{ ...styles.card, marginBottom: '20px', overflow: 'auto' }}>
          <label style={styles.formLabel}>Preview</label>
          <SampleTable text={csvText} />
        </div>
      )}

      <button
        type="button"
        className="btn-primary"
        style={styles.buttonPrimary}
        disabled={loading || !csvText.trim()}
        onClick={onSubmit}
      >
        {loading ? 'Processing...' : 'Continue to Mapping'}
      </button>
    </div>
  );
}

/** Show first 5 rows of CSV as a small table */
function SampleTable({ text }: { text: string }) {
  const lines = text.split('\n').filter(l => l.trim());
  const headers = lines[0]?.split(',').map(h => h.replace(/^"(.*)"$/, '$1').trim()) || [];
  const sampleRows = lines.slice(1, 6);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{
                padding: '6px 10px',
                borderBottom: `1px solid ${colors.border}`,
                textAlign: 'left',
                color: colors.muted,
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sampleRows.map((row, i) => {
            const cells = row.split(',').map(c => c.replace(/^"(.*)"$/, '$1').trim());
            return (
              <tr key={i}>
                {headers.map((_, j) => (
                  <td key={j} style={{
                    padding: '4px 10px',
                    borderBottom: `1px solid ${colors.border}`,
                    color: colors.text,
                    maxWidth: '200px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {cells[j] || ''}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// =============================================================================
// STEP 2: COLUMN MAPPING
// =============================================================================

const DB_FIELD_LABELS: Record<string, string> = {
  name: 'Event Name',
  date: 'Date',
  start_time: 'Start Time',
  end_time: 'End Time',
  start: 'Start (datetime)',
  end: 'End (datetime)',
  venue_name: 'Venue Name',
  address: 'Address',
  category: 'Category',
  description: 'Description',
  price: 'Price / Cost',
  ticket_url: 'URL / Link',
  image_url: 'Image URL',
  latitude: 'Latitude',
  longitude: 'Longitude',
};

function MappingStep({ upload, columnMapping, setColumnMapping, defaultCategory, setDefaultCategory, categoryColumn, setCategoryColumn, loading, onPreview, onBack }: {
  upload: CsvUploadResponse;
  columnMapping: Record<string, string>;
  setColumnMapping: (v: Record<string, string>) => void;
  defaultCategory: string;
  setDefaultCategory: (v: string) => void;
  categoryColumn: string;
  setCategoryColumn: (v: string) => void;
  loading: boolean;
  onPreview: () => void;
  onBack: () => void;
}) {
  const usedFields = new Set(Object.values(columnMapping));

  function updateMapping(header: string, field: string) {
    const next = { ...columnMapping };
    if (field === '') {
      delete next[header];
    } else {
      // Remove any other header mapped to this field
      for (const [k, v] of Object.entries(next)) {
        if (v === field) delete next[k];
      }
      next[header] = field;
    }
    setColumnMapping(next);

    // Update category column tracking
    if (field === 'category') {
      setCategoryColumn(header);
    } else if (columnMapping[header] === 'category') {
      setCategoryColumn('');
    }
  }

  const hasRequiredName = Object.values(columnMapping).includes('name');
  const hasRequiredDate = Object.values(columnMapping).includes('date') || Object.values(columnMapping).includes('start');

  return (
    <div>
      <div style={{ ...styles.card, marginBottom: '16px' }}>
        <label style={styles.formLabel}>Column Mapping</label>
        <p style={{ ...styles.helperText, marginBottom: '16px' }}>
          Match your CSV columns to Commons fields. Name and Date are required.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {upload.headers.map(header => (
            <div key={header} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
            }}>
              <div style={{
                flex: 1,
                fontSize: '13px',
                fontWeight: 500,
                color: colors.heading,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {header}
              </div>
              <div style={{ fontSize: '12px', color: colors.dim }}>
                &rarr;
              </div>
              <select
                value={columnMapping[header] || ''}
                onChange={(e) => updateMapping(header, e.target.value)}
                style={{
                  ...styles.select,
                  flex: 1,
                  fontSize: '13px',
                }}
              >
                <option value="">Skip this column</option>
                {Object.entries(DB_FIELD_LABELS).map(([field, label]) => (
                  <option
                    key={field}
                    value={field}
                    disabled={usedFields.has(field) && columnMapping[header] !== field}
                  >
                    {label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {(!hasRequiredName || !hasRequiredDate) && (
          <div style={{
            marginTop: '12px',
            fontSize: '13px',
            color: colors.error,
          }}>
            {!hasRequiredName && 'Map a column to "Event Name". '}
            {!hasRequiredDate && 'Map a column to "Date" or "Start (datetime)".'}
          </div>
        )}
      </div>

      {/* Default category */}
      <div style={{ ...styles.card, marginBottom: '20px' }}>
        <label style={styles.formLabel}>Default Category</label>
        <select
          value={defaultCategory}
          onChange={(e) => setDefaultCategory(e.target.value)}
          style={styles.select}
        >
          {Object.entries(PORTAL_CATEGORIES).map(([key, cat]) => (
            <option key={key} value={key}>{cat.label}</option>
          ))}
        </select>
        <p style={styles.helperText}>
          {categoryColumn
            ? `Applied when a row's "${categoryColumn}" value isn't recognized.`
            : 'Applied to all rows. Map a column to "Category" above if your data includes categories.'}
        </p>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          type="button"
          className="btn-primary"
          style={{ ...styles.buttonPrimary, flex: 1 }}
          disabled={loading || !hasRequiredName || !hasRequiredDate}
          onClick={onPreview}
        >
          {loading ? 'Validating...' : 'Preview Events'}
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
// STEP 3: PREVIEW
// =============================================================================

function PreviewStep({ preview, selected, setSelected, unmappedCategories, categoryOverrides, setCategoryOverrides, loading, onConfirm, onBack, onRepreview }: {
  preview: CsvPreviewResponse;
  selected: Set<number>;
  setSelected: (v: Set<number>) => void;
  unmappedCategories: string[];
  categoryOverrides: Record<string, string>;
  setCategoryOverrides: (v: Record<string, string>) => void;
  loading: boolean;
  onConfirm: () => void;
  onBack: () => void;
  onRepreview: () => void;
}) {
  function toggleRow(rowNum: number) {
    setSelected((() => {
      const next = new Set(selected);
      if (next.has(rowNum)) next.delete(rowNum);
      else next.add(rowNum);
      return next;
    })());
  }

  function toggleAll() {
    if (selected.size === preview.valid_rows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(preview.valid_rows.map(r => r.row_number)));
    }
  }

  return (
    <div>
      {/* Stats */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '12px',
      }}>
        <span style={{ fontSize: '13px', color: colors.muted }}>
          {preview.total_valid} valid, {preview.total_errors} with errors
        </span>
        <span style={{ fontSize: '13px', color: colors.dim }}>
          {selected.size} selected
        </span>
      </div>

      {/* Unmapped categories warning */}
      {unmappedCategories.length > 0 && (
        <div style={{
          background: colors.pendingBg,
          border: `1px solid ${colors.pendingBorder}`,
          borderRadius: '8px',
          padding: '12px 14px',
          fontSize: '13px',
          color: colors.pending,
          marginBottom: '12px',
        }}>
          <div style={{ fontWeight: 500, marginBottom: '8px' }}>
            {unmappedCategories.length} unrecognized categor{unmappedCategories.length === 1 ? 'y' : 'ies'}
          </div>
          {unmappedCategories.map(term => (
            <div key={term} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <span style={{ fontWeight: 500, minWidth: '100px' }}>"{term}"</span>
              <span style={{ color: colors.dim }}>&rarr;</span>
              <select
                value={categoryOverrides[term] || ''}
                onChange={(e) => setCategoryOverrides({ ...categoryOverrides, [term]: e.target.value })}
                style={{ ...styles.select, flex: 1, fontSize: '12px', padding: '4px 8px' }}
              >
                <option value="">Use default category</option>
                {Object.entries(PORTAL_CATEGORIES).map(([key, cat]) => (
                  <option key={key} value={key}>{cat.label}</option>
                ))}
              </select>
            </div>
          ))}
          <button
            type="button"
            onClick={onRepreview}
            style={{
              background: 'none',
              border: 'none',
              color: colors.accent,
              fontSize: '12px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginTop: '4px',
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            Re-validate with updated categories
          </button>
        </div>
      )}

      {/* Select all */}
      {preview.valid_rows.length > 0 && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: '8px',
          padding: '0 2px',
        }}>
          <button
            type="button"
            onClick={toggleAll}
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
            {selected.size === preview.valid_rows.length ? 'Deselect all' : 'Select all'}
          </button>
        </div>
      )}

      {/* Valid rows */}
      {preview.valid_rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '16px' }}>
          {preview.valid_rows.map(row => (
            <CsvPreviewRowCard
              key={row.row_number}
              row={row}
              checked={selected.has(row.row_number)}
              onToggle={() => toggleRow(row.row_number)}
            />
          ))}
        </div>
      )}

      {/* Error rows */}
      {preview.error_rows.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '12px', fontWeight: 500, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>
            Rows with errors ({preview.error_rows.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {preview.error_rows.map(row => (
              <div key={row.row_number} style={{
                background: colors.errorBg,
                border: `1px solid ${colors.errorBorder}`,
                borderRadius: '8px',
                padding: '10px 14px',
                fontSize: '13px',
              }}>
                <span style={{ fontWeight: 500, color: colors.text }}>Row {row.row_number}: </span>
                {row.errors.map((e, i) => (
                  <span key={i} style={{ color: colors.error }}>
                    {e.message}{i < row.errors.length - 1 ? '; ' : ''}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          type="button"
          className="btn-primary"
          style={{ ...styles.buttonPrimary, flex: 1 }}
          disabled={loading || selected.size === 0}
          onClick={onConfirm}
        >
          {loading ? 'Creating events...' : `Submit ${selected.size} Event${selected.size !== 1 ? 's' : ''}`}
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

function CsvPreviewRowCard({ row, checked, onToggle }: {
  row: CsvPreviewRow;
  checked: boolean;
  onToggle: () => void;
}) {
  const catLabel = PORTAL_CATEGORIES[row.category as PortalCategory]?.label || row.category;

  return (
    <div
      onClick={onToggle}
      style={{
        background: colors.card,
        border: `1px solid ${checked ? colors.accent : colors.border}`,
        borderRadius: '10px',
        padding: '12px 14px',
        cursor: 'pointer',
        display: 'flex',
        gap: '12px',
        alignItems: 'flex-start',
        transition: 'border-color 0.15s',
      }}
    >
      {/* Checkbox */}
      <div style={{
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
      }}>
        {checked && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 500, color: colors.heading, marginBottom: '3px' }}>
          {row.name}
        </div>
        <div style={{ fontSize: '13px', color: colors.muted }}>
          {row.date}
          {row.venue_name && ` \u00B7 ${row.venue_name}`}
        </div>
        <span style={{
          fontSize: '10px',
          padding: '1px 6px',
          borderRadius: '10px',
          background: colors.accentDim,
          color: colors.muted,
          border: `1px solid ${colors.accentBorder}`,
          marginTop: '4px',
          display: 'inline-block',
        }}>
          {catLabel}
        </span>
      </div>
    </div>
  );
}

// =============================================================================
// STEP 4: RESULT
// =============================================================================

function ResultStep({ result, onDone }: {
  result: CsvConfirmResponse;
  onDone: () => void;
}) {
  return (
    <div>
      <div style={{
        ...styles.card,
        textAlign: 'center' as const,
        marginBottom: '16px',
      }}>
        <div style={{ fontSize: '36px', marginBottom: '8px', opacity: 0.3 }}>
          {result.total_created > 0 ? '\u2713' : '\u2717'}
        </div>
        <div style={{ fontSize: '18px', fontWeight: 500, color: colors.heading, marginBottom: '4px' }}>
          {result.total_created} event{result.total_created !== 1 ? 's' : ''} contributed
        </div>
        {result.total_skipped > 0 && (
          <div style={{ fontSize: '13px', color: colors.muted }}>
            {result.total_skipped} skipped
          </div>
        )}
      </div>

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
                <span style={{ fontSize: '14px', color: colors.heading }}>{ev.name}</span>
                {ev.status === 'pending_review' && (
                  <span style={{
                    fontSize: '10px',
                    color: colors.pending,
                    background: colors.pendingBg,
                    border: `1px solid ${colors.pendingBorder}`,
                    borderRadius: '10px',
                    padding: '1px 6px',
                  }}>
                    pending review
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

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
