import { useState, useEffect, useCallback } from 'react';
import { styles, colors } from '../lib/styles';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import { adminFetchEvents, adminBatchUpdateEvents, adminBatchDeleteEvents, type AdminPortalEvent } from '../lib/api';
import { EventRowSkeleton } from '../components/Skeleton';
import { BulkEditBar } from '../components/BulkEditBar';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface AdminAllEventsScreenProps {
  onNavigate: (hash: string) => void;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(time: string | null): string {
  if (!time) return '';
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

interface EventGroup { type: 'single'; event: AdminPortalEvent }
interface SeriesGroup {
  type: 'series';
  seriesId: string;
  events: AdminPortalEvent[];
  nextEvent: AdminPortalEvent;
}
type DashboardItem = EventGroup | SeriesGroup;

// =============================================================================
// CARD COMPONENTS
// =============================================================================

function AdminEventCard({ event, onClick, selected, onToggle, selectMode, today }: {
  event: AdminPortalEvent;
  onClick: () => void;
  selected: boolean;
  onToggle: (id: string) => void;
  selectMode: boolean;
  today: string;
}) {
  const cat = PORTAL_CATEGORIES[event.category as PortalCategory];
  const isPast = (event.event_date || '') < today;

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
              width: '18px', height: '18px', borderRadius: '3px',
              border: `1.5px solid ${selected ? colors.accent : colors.dim}`,
              background: selected ? colors.accent : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, cursor: 'pointer',
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
        {event.portal_accounts?.business_name || '—'} · {formatDate(event.event_date)} · {formatTime(event.start_time)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        {cat && <span style={{ fontSize: '11px', color: colors.dim }}>{cat.label}</span>}
        {event.recurrence !== 'none' && (
          <span style={{ fontSize: '11px', color: colors.dim }}>· {event.recurrence}</span>
        )}
      </div>
    </div>
  );
}

function AdminSeriesCard({ group, onClick, selectedIds, onToggle, selectMode, today }: {
  group: SeriesGroup;
  onClick: (event: AdminPortalEvent) => void;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  selectMode: boolean;
  today: string;
}) {
  const { nextEvent, events } = group;
  const cat = PORTAL_CATEGORIES[nextEvent.category as PortalCategory];
  const upcomingCount = events.filter((e) => (e.event_date || '') >= today).length;
  const totalCount = events.length;
  const allSelected = events.every((e) => selectedIds.has(e.id));
  const someSelected = events.some((e) => selectedIds.has(e.id));
  const rec = recurrenceLabel(nextEvent.recurrence);

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
              width: '18px', height: '18px', borderRadius: '3px',
              border: `1.5px solid ${allSelected ? colors.accent : colors.dim}`,
              background: allSelected ? colors.accent : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, cursor: 'pointer',
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
        {nextEvent.portal_accounts?.business_name || '—'} · Next: {formatDate(nextEvent.event_date)} · {formatTime(nextEvent.start_time)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        {rec && (
          <span style={{
            fontSize: '11px', color: colors.accent, background: colors.accentDim,
            border: `1px solid ${colors.accentBorder}`, borderRadius: '10px', padding: '1px 8px',
          }}>{rec}</span>
        )}
        <span style={{ fontSize: '11px', color: colors.dim }}>
          {upcomingCount} upcoming · {totalCount} total
        </span>
        {cat && <span style={{ fontSize: '11px', color: colors.dim }}>· {cat.label}</span>}
      </div>
    </div>
  );
}

// =============================================================================
// GROUPING
// =============================================================================

function buildItems(events: AdminPortalEvent[], today: string): { upcoming: DashboardItem[]; past: DashboardItem[] } {
  const seriesMap = new Map<string, AdminPortalEvent[]>();
  const singles: AdminPortalEvent[] = [];

  for (const e of events) {
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

  for (const [seriesId, seriesEvents] of seriesMap) {
    seriesEvents.sort((a, b) => (a.event_date || '').localeCompare(b.event_date || ''));
    const upcomingInSeries = seriesEvents.filter((e) => (e.event_date || '') >= today);
    const nextEvent = upcomingInSeries[0] || seriesEvents[seriesEvents.length - 1]!;
    const group: SeriesGroup = { type: 'series', seriesId, events: seriesEvents, nextEvent };
    if (upcomingInSeries.length > 0) upcomingItems.push(group);
    else pastItems.push(group);
  }

  for (const e of singles) {
    const item: EventGroup = { type: 'single', event: e };
    if ((e.event_date || '') >= today) upcomingItems.push(item);
    else pastItems.push(item);
  }

  upcomingItems.sort((a, b) => {
    const dateA = (a.type === 'series' ? a.nextEvent.event_date : a.event.event_date) || '';
    const dateB = (b.type === 'series' ? b.nextEvent.event_date : b.event.event_date) || '';
    return dateA.localeCompare(dateB);
  });
  pastItems.sort((a, b) => {
    const dateA = (a.type === 'series' ? a.nextEvent.event_date : a.event.event_date) || '';
    const dateB = (b.type === 'series' ? b.nextEvent.event_date : b.event.event_date) || '';
    return dateB.localeCompare(dateA);
  });

  return { upcoming: upcomingItems, past: pastItems };
}

// =============================================================================
// MAIN SCREEN
// =============================================================================

type Filter = 'upcoming' | 'past' | 'all';

type ViewMode = 'table' | 'cards';

export function AdminAllEventsScreen({ onNavigate }: AdminAllEventsScreenProps) {
  const [events, setEvents] = useState<AdminPortalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('upcoming');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('table');

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

  // Category counts for filter pills
  const categoryCounts: Record<string, number> = {};
  for (const e of events) {
    const cat = e.category || 'uncategorized';
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  }
  const categoryKeys = Object.keys(categoryCounts).sort((a, b) => (categoryCounts[b] || 0) - (categoryCounts[a] || 0));

  const filtered = events
    .filter((e) => {
      if (filter === 'upcoming') return (e.event_date || '') >= today;
      if (filter === 'past') return (e.event_date || '') < today;
      return true;
    })
    .filter((e) => {
      if (catFilter && e.category !== catFilter) return false;
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

  // Build grouped items
  const { upcoming, past } = buildItems(filtered, today);
  const displayItems = filter === 'upcoming' ? upcoming : filter === 'past' ? past : [...upcoming, ...past];

  const renderGrid = (items: DashboardItem[]) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '8px' }}>
      {items.map((item) => {
        if (item.type === 'series') {
          return (
            <AdminSeriesCard
              key={item.seriesId}
              group={item}
              onClick={(e) => onNavigate(`#/admin/events/${e.id}/edit`)}
              selectedIds={selectedIds}
              onToggle={toggleSelect}
              selectMode={selectMode}
              today={today}
            />
          );
        }
        return (
          <AdminEventCard
            key={item.event.id}
            event={item.event}
            onClick={() => onNavigate(`#/admin/events/${item.event.id}/edit`)}
            selected={selectedIds.has(item.event.id)}
            onToggle={toggleSelect}
            selectMode={selectMode}
            today={today}
          />
        );
      })}
    </div>
  );

  const renderTable = (items: DashboardItem[]) => {
    // Flatten items to individual events for table view
    const flatEvents: AdminPortalEvent[] = [];
    for (const item of items) {
      if (item.type === 'series') {
        flatEvents.push(item.nextEvent);
      } else {
        flatEvents.push(item.event);
      }
    }
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Title</th>
              <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Venue</th>
              <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Date</th>
              <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Category</th>
              <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: '11px', fontWeight: 600, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {flatEvents.map((e) => {
              const cat = PORTAL_CATEGORIES[e.category as PortalCategory];
              const isPast = (e.event_date || '') < today;
              return (
                <tr
                  key={e.id}
                  className="interactive-row"
                  onClick={() => onNavigate(`#/admin/events/${e.id}/edit`)}
                  style={{ borderBottom: `1px solid ${colors.border}`, cursor: 'pointer', opacity: isPast ? 0.5 : 1 }}
                >
                  <td style={{ padding: '10px 10px', color: colors.cream, fontWeight: 500 }}>{e.title}</td>
                  <td style={{ padding: '10px 10px', color: colors.muted }}>{e.venue_name || '—'}</td>
                  <td style={{ padding: '10px 10px', color: colors.muted, whiteSpace: 'nowrap' }}>{formatDate(e.event_date)} {formatTime(e.start_time)}</td>
                  <td style={{ padding: '10px 10px', color: colors.dim }}>{cat?.label || e.category}</td>
                  <td style={{ padding: '10px 10px' }}>
                    <span style={{
                      fontSize: '11px', padding: '2px 8px', borderRadius: '10px',
                      background: e.status === 'published' ? colors.successBg : colors.pendingBg,
                      color: e.status === 'published' ? colors.success : colors.pending,
                    }}>
                      {e.status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <h1 style={styles.pageTitle}>All Events</h1>
          <span style={{ fontSize: '14px', color: colors.muted }}>({displayItems.length} groups)</span>
          <div style={{ flex: 1 }} />
          {/* View toggle */}
          <div style={{ display: 'flex', gap: '2px', background: colors.bg, borderRadius: '6px', padding: '2px' }}>
            <button
              type="button"
              onClick={() => setViewMode('table')}
              style={{
                padding: '4px 10px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer',
                border: 'none', fontFamily: 'inherit',
                background: viewMode === 'table' ? colors.card : 'transparent',
                color: viewMode === 'table' ? colors.heading : colors.dim,
                fontWeight: viewMode === 'table' ? 600 : 400,
              }}
            >
              Table
            </button>
            <button
              type="button"
              onClick={() => setViewMode('cards')}
              style={{
                padding: '4px 10px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer',
                border: 'none', fontFamily: 'inherit',
                background: viewMode === 'cards' ? colors.card : 'transparent',
                color: viewMode === 'cards' ? colors.heading : colors.dim,
                fontWeight: viewMode === 'cards' ? 600 : 400,
              }}
            >
              Cards
            </button>
          </div>
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
                      fontFamily: 'inherit',
                    }}
                  >
                    Delete ({selectedIds.size})
                  </button>
                )}
                <button
                  type="button"
                  onClick={exitSelectMode}
                  style={{ ...styles.buttonSecondary, width: 'auto', padding: '6px 14px', fontSize: '12px' }}
                >
                  Done
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSelectMode(true)}
                style={{ ...styles.buttonSecondary, width: 'auto', padding: '6px 14px', fontSize: '12px' }}
              >
                Edit multiple
              </button>
            )
          )}
        </div>

        {/* Category filter pills */}
        {categoryKeys.length > 1 && (
          <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setCatFilter(null)}
              style={{
                ...styles.pill,
                ...(!catFilter ? styles.pillActive : styles.pillInactive),
              }}
            >
              All
            </button>
            {categoryKeys.map((key) => {
              const cat = PORTAL_CATEGORIES[key as PortalCategory];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCatFilter(catFilter === key ? null : key)}
                  style={{
                    ...styles.pill,
                    ...(catFilter === key ? styles.pillActive : styles.pillInactive),
                  }}
                >
                  {cat?.label || key} ({categoryCounts[key]})
                </button>
              );
            })}
          </div>
        )}

        {/* Time filters */}
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
            background: toast.type === 'success' ? colors.successBg : colors.errorBg,
            color: toast.type === 'success' ? colors.success : colors.error,
            borderRadius: '8px', padding: '8px 12px', fontSize: '13px', marginBottom: '12px',
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

        {/* Event list */}
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <EventRowSkeleton />
            <EventRowSkeleton />
            <EventRowSkeleton />
          </div>
        ) : displayItems.length === 0 ? (
          <div style={{ color: colors.dim, fontSize: '14px', padding: '24px', textAlign: 'center' }}>
            {search ? 'No events match your search' : 'No events yet'}
          </div>
        ) : filter === 'all' ? (
          <>
            {upcoming.length > 0 && (
              <div style={{ marginBottom: '20px' }}>
                <div style={{ fontSize: '12px', fontWeight: 500, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '10px' }}>
                  Upcoming ({upcoming.length})
                </div>
                {viewMode === 'table' ? renderTable(upcoming) : renderGrid(upcoming)}
              </div>
            )}
            {past.length > 0 && (
              <div style={{ marginBottom: '20px', opacity: 0.6 }}>
                <div style={{ fontSize: '12px', fontWeight: 500, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '10px' }}>
                  Past ({past.length})
                </div>
                {viewMode === 'table' ? renderTable(past) : renderGrid(past)}
              </div>
            )}
          </>
        ) : (
          viewMode === 'table' ? renderTable(displayItems) : renderGrid(displayItems)
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
    </>
  );
}
