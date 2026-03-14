import { useState, useEffect, useCallback } from 'react';
import { styles, colors } from '../lib/styles';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import { adminFetchEvents, adminBatchUpdateEvents, adminBatchDeleteEvents, type AdminPortalEvent } from '../lib/api';
import { EventRowSkeleton } from '../components/Skeleton';
import { BulkEditBar } from '../components/BulkEditBar';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface AdminAllEventsScreenProps {
  onBack: () => void;
  onViewAccount: (accountId: string) => void;
}

type Filter = 'upcoming' | 'past' | 'all';

export function AdminAllEventsScreen({ onBack, onViewAccount }: AdminAllEventsScreenProps) {
  const [events, setEvents] = useState<AdminPortalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('upcoming');
  const [search, setSearch] = useState('');

  // Multi-select
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
      for (const e of filtered) allSelected ? next.delete(e.id) : next.add(e.id);
      return next;
    });
  };

  const handleBulkApply = async (updates: Record<string, unknown>) => {
    setApplying(true);
    const res = await adminBatchUpdateEvents(Array.from(selectedIds), updates);
    setApplying(false);
    if (res.error) {
      setToast({ text: res.error.message, type: 'error' });
    } else {
      setToast({ text: `Updated ${res.data?.updated || 0} event${(res.data?.updated || 0) !== 1 ? 's' : ''}`, type: 'success' });
      exitSelectMode();
      loadData();
    }
  };

  const handleBulkDelete = async () => {
    setConfirmDelete(false);
    setApplying(true);
    const result = await adminBatchDeleteEvents(Array.from(selectedIds));
    setApplying(false);
    setToast({ text: `Deleted ${result.deleted} event${result.deleted !== 1 ? 's' : ''}`, type: 'success' });
    exitSelectMode();
    loadData();
  };

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  const allVisibleSelected = filtered.length > 0 && filtered.every((e) => selectedIds.has(e.id));

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
            selectMode ? (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {selectedIds.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    disabled={applying}
                    style={{
                      background: 'transparent',
                      border: `1px solid ${colors.error}30`,
                      color: colors.error,
                      borderRadius: '6px',
                      padding: '6px 12px',
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    Delete ({selectedIds.size})
                  </button>
                )}
                <button
                  type="button"
                  onClick={exitSelectMode}
                  style={{
                    ...styles.buttonSecondary,
                    width: 'auto',
                    padding: '6px 14px',
                    fontSize: '12px',
                  }}
                >
                  Done
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSelectMode(true)}
                style={{
                  ...styles.buttonSecondary,
                  width: 'auto',
                  padding: '6px 14px',
                  fontSize: '12px',
                }}
              >
                Edit multiple
              </button>
            )
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

        {/* Toast */}
        {toast && (
          <div style={{
            background: toast.type === 'success' ? colors.successDim : '#fef2f2',
            color: toast.type === 'success' ? colors.success : colors.error,
            borderRadius: '8px',
            padding: '8px 12px',
            fontSize: '13px',
            marginBottom: '12px',
          }}>
            {toast.text}
          </div>
        )}

        {/* Bulk edit bar */}
        {selectMode && selectedIds.size > 0 && (
          <BulkEditBar
            selectedCount={selectedIds.size}
            onApply={handleBulkApply}
            onCancel={exitSelectMode}
            applying={applying}
          />
        )}

        {/* Select all toggle */}
        {selectMode && filtered.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '6px' }}>
            <button
              type="button"
              onClick={selectAllVisible}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '12px',
                color: colors.dim,
                cursor: 'pointer',
                padding: '2px 4px',
              }}
            >
              {allVisibleSelected ? 'Deselect all' : `Select all ${filtered.length}`}
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
            {filtered.map((event) => {
              const selected = selectedIds.has(event.id);
              return (
                <button
                  key={event.id}
                  type="button"
                  style={{
                    ...styles.eventRow,
                    display: 'grid',
                    gridTemplateColumns: selectMode ? 'auto 1fr auto' : '1fr auto',
                    gap: '12px',
                    alignItems: 'center',
                    background: 'transparent',
                    border: `1px solid ${colors.border}`,
                    borderLeft: selected ? `3px solid ${colors.accent}` : `1px solid ${colors.border}`,
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
                    <div style={{
                      width: '18px',
                      height: '18px',
                      borderRadius: '3px',
                      border: `1.5px solid ${selected ? colors.accent : colors.dim}`,
                      background: selected ? colors.accent : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      transition: 'all 0.1s',
                    }}>
                      {selected && (
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                          <path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
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
              );
            })}
            {filtered.length === 0 && (
              <div style={{ color: colors.dim, fontSize: '14px', padding: '24px', textAlign: 'center' }}>
                {search ? 'No events match your search' : 'No events yet'}
              </div>
            )}
          </div>
        )}

        {/* Delete confirmation */}
        {confirmDelete && (
          <ConfirmDialog
            title={`Delete ${selectedIds.size} event${selectedIds.size !== 1 ? 's' : ''}?`}
            message="This cannot be undone. Deleted events are removed from all feeds immediately."
            confirmLabel="Delete"
            destructive
            loading={applying}
            onConfirm={handleBulkDelete}
            onCancel={() => setConfirmDelete(false)}
          />
        )}
      </div>
    </div>
  );
}
