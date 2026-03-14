import { useState, useEffect, useCallback, useRef } from 'react';
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
// ACCOUNT DROPDOWN (gear menu)
// =============================================================================

function AccountDropdown({ account, onSignOut, onSignOutEverywhere, onClose }: {
  account: PortalAccount;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirmSignOutAll, setConfirmSignOutAll] = useState(false);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const row: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 0',
    fontSize: '13px',
  };

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        marginTop: '6px',
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        padding: '16px',
        width: '280px',
        zIndex: 100,
        boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
      }}
    >
      <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.dim, marginBottom: '8px' }}>
        Account
      </div>

      <div style={row}>
        <span style={{ color: colors.muted }}>Email</span>
        <span style={{ color: colors.cream }}>{account.email}</span>
      </div>
      <div style={row}>
        <span style={{ color: colors.muted }}>Status</span>
        <span style={{ color: colors.cream }}>{account.status}</span>
      </div>
      {account.default_venue_name && (
        <div style={row}>
          <span style={{ color: colors.muted }}>Venue</span>
          <span style={{ color: colors.cream }}>{account.default_venue_name}</span>
        </div>
      )}
      {account.default_address && (
        <div style={row}>
          <span style={{ color: colors.muted }}>Address</span>
          <span style={{ color: colors.cream, textAlign: 'right', maxWidth: '160px' }}>{account.default_address}</span>
        </div>
      )}
      {account.website && (
        <div style={row}>
          <span style={{ color: colors.muted }}>Website</span>
          <span style={{ color: colors.cream }}>{account.website}</span>
        </div>
      )}
      {account.phone && (
        <div style={row}>
          <span style={{ color: colors.muted }}>Phone</span>
          <span style={{ color: colors.cream }}>{account.phone}</span>
        </div>
      )}
      {account.wheelchair_accessible != null && (
        <div style={row}>
          <span style={{ color: colors.muted }}>Accessible</span>
          <span style={{ color: colors.cream }}>{account.wheelchair_accessible ? 'Yes' : 'No'}</span>
        </div>
      )}

      <div style={{ borderTop: `1px solid ${colors.border}`, marginTop: '8px', paddingTop: '10px' }}>
        {confirmSignOutAll ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '12px', color: colors.muted }}>Sign out all devices?</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                style={{ ...btnLink, color: colors.error }}
                onClick={() => { onSignOutEverywhere(); onClose(); }}
              >
                Yes, everywhere
              </button>
              <button type="button" style={btnLink} onClick={() => setConfirmSignOutAll(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <button type="button" style={btnLink} onClick={onSignOut}>
              Sign out
            </button>
            <button type="button" style={btnLink} onClick={() => setConfirmSignOutAll(true)}>
              All devices
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const btnLink: React.CSSProperties = {
  background: 'none',
  border: 'none',
  fontSize: '12px',
  color: colors.muted,
  cursor: 'pointer',
  padding: '2px 0',
};

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
        <div style={{ fontSize: '15px', color: colors.cream, fontWeight: 500 }}>
          {event.title}
        </div>
        <div style={{ fontSize: '13px', color: colors.muted, marginTop: '2px' }}>
          {formatDate(event.event_date)} · {formatTime(event.start_time)}
          {event.series_id && seriesTotal && (
            <span style={{ color: colors.dim }}> · {event.series_instance_number}/{seriesTotal}</span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        {cat && (
          <span style={{ fontSize: '11px', color: colors.dim }}>
            {cat.label}
          </span>
        )}
        {event.status === 'pending_review' && (
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
    </div>
  );
}

// =============================================================================
// DASHBOARD
// =============================================================================

export function DashboardScreen({ account, onCreateEvent, onEditEvent, onSignOut, onSignOutEverywhere }: DashboardScreenProps) {
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [loading, setLoading] = useState(true);

  // Account dropdown
  const [gearOpen, setGearOpen] = useState(false);

  // Search
  const [search, setSearch] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

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

  // Focus search field when it appears
  useEffect(() => {
    if (searchVisible) searchRef.current?.focus();
  }, [searchVisible]);

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

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  // Filter events by search
  const matchesSearch = (e: PortalEvent) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      e.title.toLowerCase().includes(s) ||
      e.venue_name.toLowerCase().includes(s) ||
      (e.category && PORTAL_CATEGORIES[e.category as PortalCategory]?.label.toLowerCase().includes(s)) ||
      formatDate(e.event_date).toLowerCase().includes(s) ||
      (e.description?.toLowerCase().includes(s))
    );
  };

  const today = new Date().toISOString().split('T')[0]!;
  const allFiltered = events.filter(matchesSearch);
  const upcoming = allFiltered.filter((e) => e.event_date >= today);
  const past = allFiltered.filter((e) => e.event_date < today);

  const seriesTotals = new Map<string, number>();
  for (const e of events) {
    if (e.series_id) seriesTotals.set(e.series_id, (seriesTotals.get(e.series_id) || 0) + 1);
  }

  const renderSection = (label: string, sectionEvents: PortalEvent[]) => {
    if (sectionEvents.length === 0) return null;
    const allSelected = sectionEvents.every((e) => selectedIds.has(e.id));

    return (
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
          <div style={{ fontSize: '12px', fontWeight: 500, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {label} ({sectionEvents.length})
          </div>
          {selectMode && (
            <button
              type="button"
              onClick={() => selectAllInSection(sectionEvents)}
              style={btnLink}
            >
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
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

        {/* ── Account bar ── */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '20px',
          position: 'relative',
        }}>
          <div>
            <div style={{ fontSize: '18px', fontWeight: 600, color: colors.cream, letterSpacing: '0.01em' }}>
              {account.business_name}
            </div>
            {account.default_address && (
              <div style={{ fontSize: '12px', color: colors.dim, marginTop: '1px' }}>
                {account.default_address}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            {/* Search toggle */}
            <button
              type="button"
              onClick={() => { setSearchVisible(!searchVisible); if (searchVisible) setSearch(''); }}
              style={{
                background: searchVisible ? colors.amberDim : 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '6px 8px',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
              }}
              title="Search events"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="7" cy="7" r="4.5" stroke={searchVisible ? colors.amber : colors.dim} strokeWidth="1.5" />
                <path d="M10.5 10.5L13.5 13.5" stroke={searchVisible ? colors.amber : colors.dim} strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            {/* Gear */}
            <button
              type="button"
              onClick={() => setGearOpen(!gearOpen)}
              style={{
                background: gearOpen ? colors.amberDim : 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '6px 8px',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
              }}
              title="Account settings"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="2" stroke={gearOpen ? colors.amber : colors.dim} strokeWidth="1.5" />
                <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke={gearOpen ? colors.amber : colors.dim} strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {/* Account dropdown */}
          {gearOpen && (
            <AccountDropdown
              account={account}
              onSignOut={onSignOut}
              onSignOutEverywhere={onSignOutEverywhere}
              onClose={() => setGearOpen(false)}
            />
          )}
        </div>

        {/* Verification banner */}
        {account.status === 'pending' && (
          <div style={{
            background: '#fef3cd',
            border: '1px solid #fde68a',
            borderRadius: '8px',
            padding: '10px 14px',
            marginBottom: '14px',
            fontSize: '13px',
            lineHeight: 1.5,
            color: colors.text,
          }}>
            <strong style={{ color: '#92600a' }}>Verification in progress</strong> — your events will appear once we verify your business.
          </div>
        )}

        {/* Search field (slides in) */}
        {searchVisible && (
          <input
            ref={searchRef}
            type="text"
            placeholder="Search by title, category, day..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              ...styles.input,
              marginBottom: '14px',
              padding: '8px 12px',
              fontSize: '14px',
            }}
          />
        )}

        {/* ── Action bar ── */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          {!selectMode && (
            <button
              className="btn-primary"
              style={{ ...styles.buttonPrimary, flex: 1 }}
              onClick={onCreateEvent}
            >
              + New Event
            </button>
          )}
          {events.length > 1 && (
            selectMode ? (
              <div style={{ display: 'flex', gap: '8px', flex: 1, alignItems: 'center' }}>
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
                      padding: '8px 14px',
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
                  className="btn-secondary"
                  onClick={exitSelectMode}
                  style={{
                    ...styles.buttonSecondary,
                    width: 'auto',
                    padding: '8px 16px',
                    fontSize: '13px',
                  }}
                >
                  Done
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn-secondary"
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
            borderRadius: '6px',
            padding: '8px 12px',
            fontSize: '13px',
            marginBottom: '10px',
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

        {/* ── Event list ── */}
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <EventRowSkeleton />
            <EventRowSkeleton />
            <EventRowSkeleton />
          </div>
        ) : events.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ fontSize: '15px', color: colors.cream, marginBottom: '4px' }}>
              No events yet
            </div>
            <div style={{ fontSize: '13px', color: colors.muted }}>
              Post your first event to reach the neighborhood.
            </div>
          </div>
        ) : allFiltered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 24px' }}>
            <div style={{ fontSize: '14px', color: colors.dim }}>
              No events match "{search}"
            </div>
          </div>
        ) : (
          <>
            {renderSection('Upcoming', upcoming)}
            {renderSection('Past', past)}
          </>
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
