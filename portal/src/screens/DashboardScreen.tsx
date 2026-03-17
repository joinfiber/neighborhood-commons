import { useState, useEffect, useCallback, useRef } from 'react';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import { styles, colors } from '../lib/styles';
import { fetchEvents, batchUpdateEvents, batchDeleteEvents, extendEventSeries, type PortalEvent, type PortalAccount } from '../lib/api';
import { EventRowSkeleton } from '../components/Skeleton';
import { BulkEditBar } from '../components/BulkEditBar';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface DashboardScreenProps {
  account: PortalAccount;
  onCreateEvent: () => void;
  onImportEvents: () => void;
  onEditEvent: (event: PortalEvent) => void;
  onNavigateProfile: () => void;
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

function recurrenceLabel(recurrence: string): string | null {
  if (recurrence === 'none' || !recurrence) return null;
  if (recurrence === 'daily') return 'Daily';
  if (recurrence === 'weekly') return 'Weekly';
  if (recurrence === 'biweekly') return 'Every 2 weeks';
  if (recurrence === 'monthly') return 'Monthly';
  if (recurrence.startsWith('weekly_days:')) {
    const days = recurrence.replace('weekly_days:', '').split(',');
    const dayNames: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
    return days.map((d) => dayNames[d] || d).join(', ');
  }
  if (recurrence.startsWith('ordinal_weekday:')) {
    const [, ordStr, day] = recurrence.split(':');
    const ord = parseInt(ordStr!, 10);
    const ordinals = ['', '1st', '2nd', '3rd', '4th'];
    const dayName = day ? day.charAt(0).toUpperCase() + day.slice(1) : '';
    return `${ordinals[ord] || ord} ${dayName}`;
  }
  return null;
}

// =============================================================================
// TYPES
// =============================================================================

interface EventGroup {
  type: 'single';
  event: PortalEvent;
}

interface SeriesGroup {
  type: 'series';
  seriesId: string;
  events: PortalEvent[]; // sorted by event_date ascending
  nextEvent: PortalEvent; // first upcoming, or last if all past
}

type DashboardItem = EventGroup | SeriesGroup;

// =============================================================================
// ACCOUNT DROPDOWN (gear menu)
// =============================================================================

function AccountDropdown({ onNavigateProfile, onSignOut, onSignOutEverywhere, onClose }: {
  onNavigateProfile: () => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirmSignOutAll, setConfirmSignOutAll] = useState(false);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

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
        padding: '12px 16px',
        width: '200px',
        zIndex: 100,
        boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
      }}
    >
      <button
        type="button"
        onClick={() => { onNavigateProfile(); onClose(); }}
        style={{ ...btnLink, display: 'block', width: '100%', textAlign: 'left', padding: '6px 0', fontSize: '13px' }}
      >
        Profile & Settings
      </button>
      <div style={{ borderTop: `1px solid ${colors.border}`, margin: '6px 0' }} />
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
  );
}

const btnLink: React.CSSProperties = {
  background: 'none',
  border: 'none',
  fontSize: '12px',
  color: colors.muted,
  cursor: 'pointer',
  padding: '2px 0',
  fontFamily: 'inherit',
};

// =============================================================================
// EVENT CARD
// =============================================================================

function EventCard({ event, onClick, selected, onToggle, selectMode }: {
  event: PortalEvent;
  onClick: () => void;
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
        background: colors.card,
        border: `1px solid ${selected ? colors.accent : colors.border}`,
        borderRadius: '10px',
        padding: '14px 16px',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
        opacity: isPast ? 0.5 : 1,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        minHeight: '90px',
      }}
      onClick={() => selectMode ? onToggle(event.id) : onClick()}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div style={{ fontSize: '15px', color: colors.cream, fontWeight: 500, lineHeight: 1.3 }}>
          {event.title}
        </div>
        {selectMode && (
          <div
            onClick={(e) => { e.stopPropagation(); onToggle(event.id); }}
            style={{
              width: '18px',
              height: '18px',
              borderRadius: '3px',
              border: `1.5px solid ${selected ? colors.accent : colors.dim}`,
              background: selected ? colors.accent : 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              cursor: 'pointer',
            }}
          >
            {selected && (
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        )}
      </div>
      <div style={{ fontSize: '13px', color: colors.muted }}>
        {formatDate(event.event_date)} · {formatTime(event.start_time)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        {cat && (
          <span style={{ fontSize: '11px', color: colors.dim }}>{cat.label}</span>
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
// SERIES CARD
// =============================================================================

function SeriesCard({ group, onClick, selectedIds, onToggle, selectMode, onExtend }: {
  group: SeriesGroup;
  onClick: (event: PortalEvent) => void;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  selectMode: boolean;
  onExtend: (seriesId: string) => void;
}) {
  const { nextEvent, events } = group;
  const cat = PORTAL_CATEGORIES[nextEvent.category as PortalCategory];
  const today = new Date().toISOString().split('T')[0]!;
  const upcomingCount = events.filter((e) => e.event_date >= today).length;
  const totalCount = events.length;
  const allSelected = events.every((e) => selectedIds.has(e.id));
  const someSelected = events.some((e) => selectedIds.has(e.id));
  const rec = recurrenceLabel(nextEvent.recurrence);
  const runningLow = upcomingCount <= 5 && upcomingCount > 0;
  const expired = upcomingCount === 0;

  const toggleAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    for (const ev of events) onToggle(ev.id);
  };

  return (
    <div
      className="interactive-row"
      style={{
        background: colors.card,
        border: `1px solid ${someSelected ? colors.accent : colors.border}`,
        borderRadius: '10px',
        padding: '14px 16px',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        minHeight: '90px',
      }}
      onClick={() => selectMode ? toggleAll({ stopPropagation: () => {} } as React.MouseEvent) : onClick(nextEvent)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div style={{ fontSize: '15px', color: colors.cream, fontWeight: 500, lineHeight: 1.3 }}>
          {nextEvent.title}
        </div>
        {selectMode && (
          <div
            onClick={toggleAll}
            style={{
              width: '18px',
              height: '18px',
              borderRadius: '3px',
              border: `1.5px solid ${allSelected ? colors.accent : colors.dim}`,
              background: allSelected ? colors.accent : 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              cursor: 'pointer',
            }}
          >
            {allSelected && (
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        )}
      </div>
      <div style={{ fontSize: '13px', color: colors.muted }}>
        Next: {formatDate(nextEvent.event_date)} · {formatTime(nextEvent.start_time)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        {rec && (
          <span style={{
            fontSize: '11px',
            color: colors.accent,
            background: colors.accentDim,
            border: `1px solid ${colors.accentBorder}`,
            borderRadius: '10px',
            padding: '1px 8px',
          }}>
            {rec}
          </span>
        )}
        <span style={{ fontSize: '11px', color: colors.dim }}>
          {upcomingCount} upcoming · {totalCount} total
        </span>
        {cat && (
          <span style={{ fontSize: '11px', color: colors.dim }}>· {cat.label}</span>
        )}
        {nextEvent.status === 'pending_review' && (
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
      {(runningLow || expired) && !selectMode && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onExtend(group.seriesId); }}
          style={{
            background: expired ? colors.accent : 'transparent',
            color: expired ? '#ffffff' : colors.accent,
            border: expired ? 'none' : `1px solid ${colors.accentBorder}`,
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 500,
            padding: '5px 12px',
            cursor: 'pointer',
            alignSelf: 'flex-start',
            marginTop: '2px',
          }}
        >
          {expired ? 'Renew 6 months' : `Renew (${upcomingCount} left)`}
        </button>
      )}
    </div>
  );
}

// =============================================================================
// DASHBOARD
// =============================================================================

export function DashboardScreen({ account, onCreateEvent, onImportEvents, onEditEvent, onNavigateProfile, onSignOut, onSignOutEverywhere }: DashboardScreenProps) {
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

  const handleExtendSeries = async (seriesId: string) => {
    setApplying(true);
    const res = await extendEventSeries(seriesId);
    setApplying(false);
    if (res.error) {
      setToast({ text: res.error.message, type: 'error' });
    } else {
      setToast({ text: `Added ${res.data?.added || 0} events`, type: 'success' });
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

  // Group events: series_id → SeriesGroup, standalone → EventGroup
  const buildDashboardItems = (filtered: PortalEvent[]): { upcoming: DashboardItem[]; past: DashboardItem[] } => {
    const seriesMap = new Map<string, PortalEvent[]>();
    const singles: PortalEvent[] = [];

    for (const e of filtered) {
      if (e.series_id) {
        const arr = seriesMap.get(e.series_id) || [];
        arr.push(e);
        seriesMap.set(e.series_id, arr);
      } else {
        singles.push(e);
      }
    }

    const upcomingItems: DashboardItem[] = [];
    const pastItems: DashboardItem[] = [];

    // Process series groups
    for (const [seriesId, seriesEvents] of seriesMap) {
      seriesEvents.sort((a, b) => a.event_date.localeCompare(b.event_date));
      const upcomingInSeries = seriesEvents.filter((e) => e.event_date >= today);
      const nextEvent = upcomingInSeries[0] || seriesEvents[seriesEvents.length - 1]!;
      const group: SeriesGroup = { type: 'series', seriesId, events: seriesEvents, nextEvent };

      if (upcomingInSeries.length > 0) {
        upcomingItems.push(group);
      } else {
        pastItems.push(group);
      }
    }

    // Process singles
    for (const e of singles) {
      const item: EventGroup = { type: 'single', event: e };
      if (e.event_date >= today) {
        upcomingItems.push(item);
      } else {
        pastItems.push(item);
      }
    }

    // Sort: upcoming by next date ascending, past by date descending
    upcomingItems.sort((a, b) => {
      const dateA = a.type === 'series' ? a.nextEvent.event_date : a.event.event_date;
      const dateB = b.type === 'series' ? b.nextEvent.event_date : b.event.event_date;
      return dateA.localeCompare(dateB);
    });
    pastItems.sort((a, b) => {
      const dateA = a.type === 'series' ? a.nextEvent.event_date : a.event.event_date;
      const dateB = b.type === 'series' ? b.nextEvent.event_date : b.event.event_date;
      return dateB.localeCompare(dateA);
    });

    return { upcoming: upcomingItems, past: pastItems };
  };

  const { upcoming, past } = buildDashboardItems(allFiltered);

  const renderSection = (label: string, items: DashboardItem[]) => {
    if (items.length === 0) return null;

    return (
      <div style={{ marginBottom: '20px' }}>
        <div style={{ fontSize: '12px', fontWeight: 500, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '10px' }}>
          {label} ({items.length})
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: '8px',
        }}>
          {items.map((item) => {
            if (item.type === 'series') {
              return (
                <SeriesCard
                  key={item.seriesId}
                  group={item}
                  onClick={onEditEvent}
                  selectedIds={selectedIds}
                  onToggle={toggleSelect}
                  selectMode={selectMode}
                  onExtend={handleExtendSeries}
                />
              );
            }
            return (
              <EventCard
                key={item.event.id}
                event={item.event}
                onClick={() => onEditEvent(item.event)}
                selected={selectedIds.has(item.event.id)}
                onToggle={toggleSelect}
                selectMode={selectMode}
              />
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div style={styles.page}>
      <div style={styles.contentWide} className="fade-up">

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
                background: searchVisible ? colors.accentDim : 'none',
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
                <circle cx="7" cy="7" r="4.5" stroke={searchVisible ? colors.accent : colors.dim} strokeWidth="1.5" />
                <path d="M10.5 10.5L13.5 13.5" stroke={searchVisible ? colors.accent : colors.dim} strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            {/* Gear */}
            <button
              type="button"
              onClick={() => setGearOpen(!gearOpen)}
              style={{
                background: gearOpen ? colors.accentDim : 'none',
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
                <circle cx="8" cy="8" r="2" stroke={gearOpen ? colors.accent : colors.dim} strokeWidth="1.5" />
                <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke={gearOpen ? colors.accent : colors.dim} strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {/* Account dropdown */}
          {gearOpen && (
            <AccountDropdown
              onNavigateProfile={onNavigateProfile}
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
            <strong style={{ color: '#92600a' }}>Review in progress</strong> — your events will appear once we've reviewed your account. This usually takes less than a day.
          </div>
        )}

        {/* Search field */}
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
            <>
              <button
                className="btn-primary"
                style={{ ...styles.buttonPrimary, flex: 1 }}
                onClick={onCreateEvent}
              >
                + New Event
              </button>
              <button
                type="button"
                className="btn-secondary"
                style={{
                  ...styles.buttonSecondary,
                  width: 'auto',
                  padding: '12px 16px',
                  fontSize: '13px',
                }}
                onClick={onImportEvents}
              >
                Import
              </button>
            </>
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
                      fontFamily: 'inherit',
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

        {/* ── Event grid ── */}
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
