import { useState, useEffect, useCallback } from 'react';
import { styles, colors } from '../lib/styles';
import { PORTAL_CATEGORIES, PORTAL_CATEGORY_KEYS, type PortalCategory } from '../lib/categories';
import { adminFetchEvents, adminBatchUpdateEvents, adminBatchDeleteEvents, type AdminPortalEvent } from '../lib/api';
import { EventRowSkeleton } from '../components/Skeleton';

interface AdminAllEventsScreenProps {
  onBack: () => void;
  onViewAccount: (accountId: string) => void;
}

type Filter = 'upcoming' | 'past' | 'all';

// =============================================================================
// BULK EDIT PANEL (shared shape with DashboardScreen)
// =============================================================================

function BulkEditPanel({ selectedCount, onApply, onDelete, onCancel, applying }: {
  selectedCount: number;
  onApply: (updates: Record<string, unknown>) => void;
  onDelete: () => void;
  onCancel: () => void;
  applying: boolean;
}) {
  const [field, setField] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [wheelchairAccessible, setWheelchairAccessible] = useState<string>('');
  const [startTimeRequired, setStartTimeRequired] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleApply = () => {
    const updates: Record<string, unknown> = {};
    if (field === 'category' && category) {
      updates.category = category;
    } else if (field === 'wheelchair') {
      if (wheelchairAccessible === 'true') updates.wheelchair_accessible = true;
      else if (wheelchairAccessible === 'false') updates.wheelchair_accessible = false;
      else if (wheelchairAccessible === 'null') updates.wheelchair_accessible = null;
    } else if (field === 'start_time_required') {
      if (startTimeRequired === 'true') updates.start_time_required = true;
      else if (startTimeRequired === 'false') updates.start_time_required = false;
    }

    if (Object.keys(updates).length > 0) {
      onApply(updates);
    }
  };

  const canApply =
    (field === 'category' && category !== '') ||
    (field === 'wheelchair' && wheelchairAccessible !== '') ||
    (field === 'start_time_required' && startTimeRequired !== '');

  return (
    <div style={{
      ...styles.card,
      marginBottom: '16px',
      borderColor: colors.amberBorder,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <span style={{ fontSize: '14px', fontWeight: 500, color: colors.cream }}>
          {selectedCount} event{selectedCount !== 1 ? 's' : ''} selected
        </span>
        <button type="button" style={styles.buttonText} onClick={onCancel}>
          Cancel
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div>
          <label style={styles.formLabel}>Change field</label>
          <select style={styles.select} value={field} onChange={(e) => setField(e.target.value)}>
            <option value="">Choose a field...</option>
            <option value="category">Category</option>
            <option value="wheelchair">Wheelchair Accessible</option>
            <option value="start_time_required">Arrive by Start Time</option>
          </select>
        </div>

        {field === 'category' && (
          <div>
            <label style={styles.formLabel}>New category</label>
            <select style={styles.select} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Choose...</option>
              {PORTAL_CATEGORY_KEYS.map((key) => (
                <option key={key} value={key}>{PORTAL_CATEGORIES[key].label}</option>
              ))}
            </select>
          </div>
        )}

        {field === 'wheelchair' && (
          <div>
            <label style={styles.formLabel}>Set to</label>
            <select style={styles.select} value={wheelchairAccessible} onChange={(e) => setWheelchairAccessible(e.target.value)}>
              <option value="">Choose...</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
              <option value="null">Use account default</option>
            </select>
          </div>
        )}

        {field === 'start_time_required' && (
          <div>
            <label style={styles.formLabel}>Set to</label>
            <select style={styles.select} value={startTimeRequired} onChange={(e) => setStartTimeRequired(e.target.value)}>
              <option value="">Choose...</option>
              <option value="true">Yes — arrive by start time</option>
              <option value="false">No — arrive anytime</option>
            </select>
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
          <button
            type="button"
            className="btn-primary"
            style={{ ...styles.buttonPrimary, flex: 1, opacity: canApply && !applying ? 1 : 0.5 }}
            disabled={!canApply || applying}
            onClick={handleApply}
          >
            {applying ? 'Applying...' : 'Apply'}
          </button>
        </div>

        <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: '10px', marginTop: '4px' }}>
          {confirmDelete ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', color: colors.error }}>
                Delete {selectedCount} event{selectedCount !== 1 ? 's' : ''}?
              </span>
              <button
                type="button"
                style={{ ...styles.buttonText, color: colors.error, fontSize: '13px' }}
                onClick={() => { setConfirmDelete(false); onDelete(); }}
                disabled={applying}
              >
                Yes, delete
              </button>
              <button
                type="button"
                style={{ ...styles.buttonText, fontSize: '13px' }}
                onClick={() => setConfirmDelete(false)}
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              style={{ ...styles.buttonText, color: colors.error, fontSize: '13px', padding: 0 }}
              onClick={() => setConfirmDelete(true)}
              disabled={applying}
            >
              Delete selected events
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// ADMIN ALL EVENTS SCREEN
// =============================================================================

export function AdminAllEventsScreen({ onBack, onViewAccount }: AdminAllEventsScreenProps) {
  const [events, setEvents] = useState<AdminPortalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('upcoming');
  const [search, setSearch] = useState('');

  // Multi-select state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    const res = await adminFetchEvents();
    if (res.data) setEvents(res.data.events);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const today = new Date().toISOString().split('T')[0] ?? '';

  const filtered = events
    .filter((e) => {
      if (filter === 'upcoming') return e.event_date >= today;
      if (filter === 'past') return e.event_date < today;
      return true;
    })
    .filter((e) => {
      if (!search) return true;
      const s = search.toLowerCase();
      return (
        e.title.toLowerCase().includes(s) ||
        e.venue_name.toLowerCase().includes(s) ||
        e.portal_accounts?.business_name.toLowerCase().includes(s) ||
        e.portal_accounts?.email.toLowerCase().includes(s)
      );
    });

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = filtered.every((e) => next.has(e.id));
      if (allSelected) {
        for (const e of filtered) next.delete(e.id);
      } else {
        for (const e of filtered) next.add(e.id);
      }
      return next;
    });
  };

  const handleBulkApply = async (updates: Record<string, unknown>) => {
    setApplying(true);
    setBulkMessage(null);
    const ids = Array.from(selectedIds);
    const res = await adminBatchUpdateEvents(ids, updates);
    setApplying(false);
    if (res.error) {
      setBulkMessage({ text: res.error.message, type: 'error' });
    } else {
      setBulkMessage({ text: `Updated ${res.data?.updated || 0} event${(res.data?.updated || 0) !== 1 ? 's' : ''}`, type: 'success' });
      exitSelectMode();
      loadData();
    }
  };

  const handleBulkDelete = async () => {
    setApplying(true);
    setBulkMessage(null);
    const ids = Array.from(selectedIds);
    const result = await adminBatchDeleteEvents(ids);
    setApplying(false);
    setBulkMessage({ text: `Deleted ${result.deleted} event${result.deleted !== 1 ? 's' : ''}`, type: 'success' });
    exitSelectMode();
    loadData();
  };

  useEffect(() => {
    if (bulkMessage) {
      const t = setTimeout(() => setBulkMessage(null), 3000);
      return () => clearTimeout(t);
    }
  }, [bulkMessage]);

  return (
    <div style={styles.page}>
      <div style={styles.contentWide} className="fade-up">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <button type="button" style={styles.buttonText} onClick={onBack}>← Back</button>
          <h1 style={styles.pageTitle}>All Events</h1>
          <span style={{ fontSize: '14px', color: colors.muted }}>({filtered.length})</span>
          <div style={{ flex: 1 }} />
          {events.length > 0 && (
            <button
              className="btn-secondary"
              type="button"
              style={{
                ...styles.buttonSecondary,
                width: 'auto',
                padding: '8px 14px',
                fontSize: '13px',
                background: selectMode ? colors.amberDim : 'transparent',
                borderColor: selectMode ? colors.amberBorder : colors.border,
                color: selectMode ? colors.amber : colors.text,
              }}
              onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)}
            >
              {selectMode ? 'Done' : 'Select'}
            </button>
          )}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          {(['upcoming', 'past', 'all'] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              style={{
                ...styles.pill,
                ...(filter === f ? styles.pillActive : styles.pillInactive),
              }}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Search events or businesses..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...styles.input, marginBottom: '16px', padding: '8px 12px', fontSize: '14px' }}
        />

        {/* Bulk message */}
        {bulkMessage && (
          <div style={{
            background: bulkMessage.type === 'success' ? colors.successDim : '#fef2f2',
            color: bulkMessage.type === 'success' ? colors.success : colors.error,
            border: `1px solid ${bulkMessage.type === 'success' ? colors.success + '30' : colors.error + '30'}`,
            borderRadius: '8px',
            padding: '10px 14px',
            fontSize: '14px',
            marginBottom: '16px',
          }}>
            {bulkMessage.text}
          </div>
        )}

        {/* Bulk edit panel */}
        {selectMode && selectedIds.size > 0 && (
          <BulkEditPanel
            selectedCount={selectedIds.size}
            onApply={handleBulkApply}
            onDelete={handleBulkDelete}
            onCancel={exitSelectMode}
            applying={applying}
          />
        )}

        {/* Select all for visible */}
        {selectMode && filtered.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
            <button
              type="button"
              style={{ ...styles.buttonText, fontSize: '12px' }}
              onClick={selectAllVisible}
            >
              {filtered.every((e) => selectedIds.has(e.id)) ? 'Deselect all' : `Select all ${filtered.length}`}
            </button>
          </div>
        )}

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <EventRowSkeleton />
            <EventRowSkeleton />
            <EventRowSkeleton />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {filtered.map((event) => (
              <button
                key={event.id}
                type="button"
                style={{
                  ...styles.eventRow,
                  display: 'grid',
                  gridTemplateColumns: selectMode ? 'auto 1fr auto' : '1fr auto',
                  gap: '12px',
                  alignItems: 'center',
                  background: selectedIds.has(event.id) ? colors.amberDim : 'transparent',
                  border: `1px solid ${selectedIds.has(event.id) ? colors.amber : colors.border}`,
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: '100%',
                  opacity: event.event_date < today ? 0.5 : 1,
                }}
                className="interactive-row"
                onClick={() => selectMode
                  ? toggleSelect(event.id)
                  : event.portal_account_id && onViewAccount(event.portal_account_id)
                }
              >
                {selectMode && (
                  <div
                    style={{
                      width: '22px',
                      height: '22px',
                      borderRadius: '4px',
                      border: `2px solid ${selectedIds.has(event.id) ? colors.amber : colors.border}`,
                      background: selectedIds.has(event.id) ? colors.amber : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {selectedIds.has(event.id) && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                )}
                <div>
                  <div style={{ fontSize: '16px', fontWeight: 500, color: colors.cream }}>{event.title}</div>
                  <div style={{ fontSize: '14px', color: colors.muted }}>
                    {event.portal_accounts?.business_name || '—'} · {event.venue_name} · {event.event_date} · {event.start_time}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <span style={{ ...styles.pill, ...styles.pillInactive, fontSize: '11px', padding: '2px 8px' }}>
                    {PORTAL_CATEGORIES[event.category as PortalCategory]?.label || event.category}
                  </span>
                  {event.recurrence !== 'none' && (
                    <span style={{ fontSize: '11px', color: colors.dim }}>{event.recurrence}</span>
                  )}
                </div>
              </button>
            ))}
            {filtered.length === 0 && (
              <div style={{ color: colors.dim, fontSize: '14px', padding: '24px', textAlign: 'center' }}>
                {search ? 'No events match your search' : 'No events yet'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
