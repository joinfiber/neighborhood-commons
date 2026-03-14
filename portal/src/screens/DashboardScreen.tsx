import { useState, useEffect, useCallback } from 'react';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import { styles, colors } from '../lib/styles';
import { fetchEvents, batchUpdateEvents, batchDeleteEvents, type PortalEvent, type PortalAccount } from '../lib/api';
import { EventRowSkeleton } from '../components/Skeleton';
import { BulkEditBar } from '../components/BulkEditBar';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface DashboardScreenProps {
  account: PortalAccount;
  onCreateEvent: () => void;
  onEditEvent: (event: PortalEvent) => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(time: string): string {
  const [h, m] = time.split(':');
  const hour = parseInt(h!, 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

// =============================================================================
// EVENT ROW
// =============================================================================

function EventRow({ event, onClick, seriesTotal, selected, onToggle, selectMode }: {
  event: PortalEvent;
  onClick: () => void;
  seriesTotal?: number;
  selected: boolean;
  onToggle: (id: string) => void;
  selectMode: boolean;
}) {
  const cat = PORTAL_CATEGORIES[event.category as PortalCategory];
  const today = new Date().toISOString().split('T')[0]!;
  const isPast = event.event_date < today;

  return (
    <div
      className="interactive-row"
      style={{
        ...styles.eventRow,
        opacity: isPast ? 0.5 : 1,
        // Subtle left border when selected instead of full highlight
        borderLeft: selected ? `3px solid ${colors.amber}` : `1px solid ${colors.border}`,
        paddingLeft: selected ? '13px' : '16px',
      }}
      onClick={() => selectMode ? onToggle(event.id) : onClick()}
    >
      {selectMode && (
        <div
          onClick={(e) => { e.stopPropagation(); onToggle(event.id); }}
          style={{
            width: '18px',
            height: '18px',
            borderRadius: '3px',
            border: `1.5px solid ${selected ? colors.amber : colors.dim}`,
            background: selected ? colors.amber : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: '10px',
            flexShrink: 0,
            cursor: 'pointer',
            transition: 'all 0.1s',
          }}
        >
          {selected && (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '16px', color: colors.cream, fontWeight: 500 }}>
          {event.title}
        </div>
        <div style={{ fontSize: '13px', color: colors.muted, marginTop: '3px' }}>
          {event.venue_name} · {formatDate(event.event_date)} · {formatTime(event.start_time)}
          {event.series_id && seriesTotal && (
            <span style={{ color: colors.dim }}> · {event.series_instance_number} of {seriesTotal}</span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        {cat && (
          <span style={{ ...styles.pill, ...styles.pillActive, fontSize: '11px', padding: '2px 8px', cursor: 'default' }}>
            {cat.label}
          </span>
        )}
        {event.status === 'pending_review' && (
          <span style={{
            fontSize: '11px',
            color: '#92600a',
            background: '#fef3cd',
            border: '1px solid #fde68a',
            borderRadius: '12px',
            padding: '2px 8px',
          }}>
            pending
          </span>
        )}
        {event.series_id && (
          <span style={{
            fontSize: '11px',
            color: colors.muted,
            background: colors.bg,
            border: `1px solid ${colors.border}`,
            borderRadius: '12px',
            padding: '2px 8px',
          }}>
            series
          </span>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// DASHBOARD SCREEN
// =============================================================================

export function DashboardScreen({ account, onCreateEvent, onEditEvent, onSignOut, onSignOutEverywhere }: DashboardScreenProps) {
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountExpanded, setAccountExpanded] = useState(false);
  const [confirmSignOutAll, setConfirmSignOutAll] = useState(false);

  // Multi-select
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    const res = await fetchEvents();
    if (res.data) setEvents(res.data.events);
    setLoading(false);
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

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

  const selectAllInSection = (sectionEvents: PortalEvent[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = sectionEvents.every((e) => next.has(e.id));
      for (const e of sectionEvents) allSelected ? next.delete(e.id) : next.add(e.id);
      return next;
    });
  };

  const handleBulkApply = async (updates: Record<string, unknown>) => {
    setApplying(true);
    const res = await batchUpdateEvents(Array.from(selectedIds), updates);
    setApplying(false);
    if (res.error) {
      setToast({ text: res.error.message, type: 'error' });
    } else {
      setToast({ text: `Updated ${res.data?.updated || 0} event${(res.data?.updated || 0) !== 1 ? 's' : ''}`, type: 'success' });
      exitSelectMode();
      loadEvents();
    }
  };

  const handleBulkDelete = async () => {
    setConfirmDelete(false);
    setApplying(true);
    const result = await batchDeleteEvents(Array.from(selectedIds));
    setApplying(false);
    setToast({ text: `Deleted ${result.deleted} event${result.deleted !== 1 ? 's' : ''}`, type: 'success' });
    exitSelectMode();
    loadEvents();
  };

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  const today = new Date().toISOString().split('T')[0]!;
  const upcoming = events.filter((e) => e.event_date >= today);
  const past = events.filter((e) => e.event_date < today);

  const seriesTotals = new Map<string, number>();
  for (const e of events) {
    if (e.series_id) seriesTotals.set(e.series_id, (seriesTotals.get(e.series_id) || 0) + 1);
  }

  const renderSection = (label: string, sectionEvents: PortalEvent[]) => {
    if (sectionEvents.length === 0) return null;
    const allSelected = sectionEvents.every((e) => selectedIds.has(e.id));

    return (
      <div style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div style={styles.sectionLabel}>
            {label} ({sectionEvents.length})
          </div>
          {selectMode && (
            <button
              type="button"
              onClick={() => selectAllInSection(sectionEvents)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '12px',
                color: colors.dim,
                cursor: 'pointer',
                padding: '2px 4px',
              }}
            >
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {sectionEvents.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              onClick={() => onEditEvent(event)}
              seriesTotal={event.series_id ? seriesTotals.get(event.series_id) : undefined}
              selected={selectedIds.has(event.id)}
              onToggle={toggleSelect}
              selectMode={selectMode}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div style={styles.page}>
      <div style={styles.content} className="fade-up">
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px' }}>
          <div>
            <h1 style={styles.pageTitle}>{account.business_name}</h1>
            <p style={{ fontSize: '13px', color: colors.muted, marginTop: '4px' }}>
              {account.email}
            </p>
          </div>
          <button style={styles.buttonText} onClick={onSignOut}>
            Sign Out
          </button>
        </div>

        {/* Verification banner */}
        {account.status === 'pending' && (
          <div style={{
            background: '#fef3cd',
            border: '1px solid #fde68a',
            borderRadius: '10px',
            padding: '14px 16px',
            marginBottom: '16px',
            fontSize: '14px',
            lineHeight: 1.5,
            color: colors.text,
          }}>
            <strong style={{ color: '#92600a' }}>Account verification in progress</strong>
            <br />
            Your events are saved and ready to go — they'll appear once we verify your business. This usually takes less than 24 hours.
          </div>
        )}

        {/* Account section (collapsible) */}
        <div style={{ ...styles.card, marginBottom: '16px', padding: 0, overflow: 'hidden' }}>
          <button
            type="button"
            onClick={() => setAccountExpanded(!accountExpanded)}
            style={{
              background: 'transparent',
              border: 'none',
              width: '100%',
              padding: '14px 16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', color: colors.muted }}>
              Account
            </span>
            <span style={{ fontSize: '13px', color: colors.text }}>
              {account.default_address || account.email}
              <span style={{ marginLeft: '8px', fontSize: '10px' }}>{accountExpanded ? '▲' : '▼'}</span>
            </span>
          </button>

          {accountExpanded && (
            <div style={{ padding: '0 16px 16px', borderTop: `1px solid ${colors.border}` }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '14px', paddingTop: '14px' }}>
                <div>
                  <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Email</div>
                  <div style={{ color: colors.cream }}>{account.email}</div>
                </div>
                <div>
                  <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Status</div>
                  <div style={{ color: colors.cream }}>{account.status}</div>
                </div>
                {account.default_venue_name && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Venue</div>
                    <div style={{ color: colors.cream }}>{account.default_venue_name}</div>
                  </div>
                )}
                {account.default_address && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Address</div>
                    <div style={{ color: colors.cream }}>{account.default_address}</div>
                  </div>
                )}
                {account.website && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Website</div>
                    <div style={{ color: colors.cream }}>{account.website}</div>
                  </div>
                )}
                {account.phone && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Phone</div>
                    <div style={{ color: colors.cream }}>{account.phone}</div>
                  </div>
                )}
                {account.wheelchair_accessible != null && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Wheelchair Accessible</div>
                    <div style={{ color: colors.cream }}>{account.wheelchair_accessible ? 'Yes' : 'No'}</div>
                  </div>
                )}
              </div>

              <div style={{ borderTop: `1px solid ${colors.border}`, marginTop: '14px', paddingTop: '14px', display: 'flex', justifyContent: 'flex-end' }}>
                {confirmSignOutAll ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '13px', color: colors.muted }}>Sign out all devices?</span>
                    <button
                      type="button"
                      style={{ ...styles.buttonText, color: colors.error, fontSize: '13px' }}
                      onClick={() => { onSignOutEverywhere(); setConfirmSignOutAll(false); }}
                    >
                      Yes, sign out everywhere
                    </button>
                    <button
                      type="button"
                      style={{ ...styles.buttonText, fontSize: '13px' }}
                      onClick={() => setConfirmSignOutAll(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    style={{ ...styles.buttonText, fontSize: '13px' }}
                    onClick={() => setConfirmSignOutAll(true)}
                  >
                    Sign out everywhere
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Action bar: New Event + Select toggle */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          {!selectMode && (
            <button style={{ ...styles.buttonPrimary, flex: 1 }} onClick={onCreateEvent}>
              + New Event
            </button>
          )}
          {events.length > 1 && (
            selectMode ? (
              <div style={{ display: 'flex', gap: '8px', flex: 1 }}>
                {selectedIds.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    disabled={applying}
                    style={{
                      background: 'transparent',
                      border: `1px solid ${colors.error}30`,
                      color: colors.error,
                      borderRadius: '8px',
                      padding: '10px 16px',
                      fontSize: '13px',
                      cursor: 'pointer',
                    }}
                  >
                    Delete ({selectedIds.size})
                  </button>
                )}
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={exitSelectMode}
                  style={{
                    ...styles.buttonSecondary,
                    width: 'auto',
                    padding: '10px 20px',
                    fontSize: '13px',
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
                  padding: '12px 16px',
                  fontSize: '13px',
                }}
              >
                Edit multiple
              </button>
            )
          )}
        </div>

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

        {/* Bulk edit bar — appears when events are selected */}
        {selectMode && selectedIds.size > 0 && (
          <BulkEditBar
            selectedCount={selectedIds.size}
            onApply={handleBulkApply}
            onCancel={exitSelectMode}
            applying={applying}
          />
        )}

        {/* Event list */}
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <EventRowSkeleton />
            <EventRowSkeleton />
            <EventRowSkeleton />
          </div>
        ) : events.length === 0 ? (
          <div style={{ ...styles.card, textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ fontSize: '16px', color: colors.cream, marginBottom: '6px' }}>
              No events yet
            </div>
            <div style={{ fontSize: '14px', color: colors.muted }}>
              Create your first event to reach the neighborhood.
            </div>
          </div>
        ) : (
          <>
            {renderSection('Upcoming', upcoming)}
            {renderSection('Past', past)}
          </>
        )}

        {/* Delete confirmation dialog */}
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
