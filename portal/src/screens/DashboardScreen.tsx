import { useState, useEffect, useCallback } from 'react';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import { colors } from '../lib/styles';
import { fetchEvents, batchUpdateEvents, batchDeleteEvents, extendEventSeries, type PortalEvent, type PortalAccount } from '../lib/api';
import { EventRowSkeleton } from '../components/Skeleton';
import { BulkEditBar } from '../components/BulkEditBar';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface DashboardScreenProps {
  account: PortalAccount;
  onEditEvent: (event: PortalEvent) => void;
  onShareEvent: (event: PortalEvent) => void;
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
// EVENT CARD
// =============================================================================

function EventCard({ event, onClick, onShare, selected, onToggle, selectMode }: {
  event: PortalEvent;
  onClick: () => void;
  onShare: () => void;
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
        <div style={{ fontSize: '15px', color: colors.cream, fontWeight: 500, lineHeight: 1.3, flex: 1 }}>
          {event.title}
        </div>
        {selectMode ? (
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
        ) : (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onShare(); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', flexShrink: 0 }}
            title="Share"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4 12V14H12V12" stroke={colors.dim} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M8 10V3M5 5.5L8 2.5L11 5.5" stroke={colors.dim} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
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
            color: colors.pending,
            background: colors.pendingBg,
            border: `1px solid ${colors.pendingBorder}`,
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

function SeriesCard({ group, onClick, onShare, selectedIds, onToggle, selectMode, onExtend, onEditInstances }: {
  group: SeriesGroup;
  onClick: (event: PortalEvent) => void;
  onShare: (event: PortalEvent) => void;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  selectMode: boolean;
  onExtend: (seriesId: string) => void;
  onEditInstances: () => void;
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
        <div style={{ fontSize: '15px', color: colors.cream, fontWeight: 500, lineHeight: 1.3, flex: 1 }}>
          {nextEvent.title}
        </div>
        {selectMode ? (
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
        ) : (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onShare(nextEvent); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', flexShrink: 0 }}
            title="Share"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4 12V14H12V12" stroke={colors.dim} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M8 10V3M5 5.5L8 2.5L11 5.5" stroke={colors.dim} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
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
            color: colors.pending,
            background: colors.pendingBg,
            border: `1px solid ${colors.pendingBorder}`,
            borderRadius: '10px',
            padding: '1px 6px',
          }}>
            pending
          </span>
        )}
      </div>
      {!selectMode && (
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px' }}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEditInstances(); }}
            style={{
              background: 'transparent',
              color: colors.dim,
              border: `1px solid ${colors.border}`,
              borderRadius: '6px',
              fontSize: '11px',
              padding: '4px 10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Edit instances
          </button>
          {(runningLow || expired) && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onExtend(group.seriesId); }}
              style={{
                background: expired ? colors.accent : 'transparent',
                color: expired ? '#ffffff' : colors.accent,
                border: expired ? 'none' : `1px solid ${colors.accentBorder}`,
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 500,
                padding: '4px 10px',
                cursor: 'pointer',
              }}
            >
              {expired ? 'Renew 6 months' : `Renew (${upcomingCount} left)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// DASHBOARD
// =============================================================================

export function DashboardScreen({ account, onEditEvent, onShareEvent }: DashboardScreenProps) {
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [loading, setLoading] = useState(true);

  // Multi-select (per-series bulk edit)
  const [selectMode, setSelectMode] = useState(false);
  const [selectSeriesId, setSelectSeriesId] = useState<string | null>(null);
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
    setSelectSeriesId(null);
    setSelectedIds(new Set());
  };

  const enterSeriesSelectMode = (seriesId: string, eventIds: string[]) => {
    setSelectMode(true);
    setSelectSeriesId(seriesId);
    setSelectedIds(new Set(eventIds));
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

  const today = new Date().toISOString().split('T')[0]!;

  // Group events into Recurring (series) and One-off (singles)
  const buildSections = () => {
    const seriesMap = new Map<string, PortalEvent[]>();
    const singles: PortalEvent[] = [];

    for (const e of events) {
      if (e.series_id) {
        const arr = seriesMap.get(e.series_id) || [];
        arr.push(e);
        seriesMap.set(e.series_id, arr);
      } else {
        singles.push(e);
      }
    }

    const recurring: SeriesGroup[] = [];
    for (const [seriesId, seriesEvents] of seriesMap) {
      seriesEvents.sort((a, b) => a.event_date.localeCompare(b.event_date));
      const upcomingInSeries = seriesEvents.filter((e) => e.event_date >= today);
      const nextEvent = upcomingInSeries[0] || seriesEvents[seriesEvents.length - 1]!;
      recurring.push({ type: 'series', seriesId, events: seriesEvents, nextEvent });
    }
    // Active series first (have upcoming events), then expired, each sorted by next date
    recurring.sort((a, b) => {
      const aHasUpcoming = a.events.some((e) => e.event_date >= today);
      const bHasUpcoming = b.events.some((e) => e.event_date >= today);
      if (aHasUpcoming !== bHasUpcoming) return aHasUpcoming ? -1 : 1;
      return a.nextEvent.event_date.localeCompare(b.nextEvent.event_date);
    });

    // One-offs: upcoming first (ascending), then past (descending)
    const upcomingSingles = singles.filter((e) => e.event_date >= today).sort((a, b) => a.event_date.localeCompare(b.event_date));
    const pastSingles = singles.filter((e) => e.event_date < today).sort((a, b) => b.event_date.localeCompare(a.event_date));
    const oneOff = [...upcomingSingles, ...pastSingles];

    return { recurring, oneOff };
  };

  const { recurring, oneOff } = buildSections();

  const renderGrid = (items: DashboardItem[]) => (
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
              onShare={onShareEvent}
              selectedIds={selectedIds}
              onToggle={toggleSelect}
              selectMode={selectMode && selectSeriesId === item.seriesId}
              onExtend={handleExtendSeries}
              onEditInstances={() => enterSeriesSelectMode(item.seriesId, item.events.map((e) => e.id))}
            />
          );
        }
        return (
          <EventCard
            key={item.event.id}
            event={item.event}
            onClick={() => onEditEvent(item.event)}
            onShare={() => onShareEvent(item.event)}
            selected={selectedIds.has(item.event.id)}
            onToggle={toggleSelect}
            selectMode={false}
          />
        );
      })}
    </div>
  );

  return (
    <>
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

        {/* Toast */}
        {toast && (
          <div style={{
            background: toast.type === 'success' ? colors.successBg : colors.errorBg,
            color: toast.type === 'success' ? colors.success : colors.error,
            borderRadius: '6px',
            padding: '8px 12px',
            fontSize: '13px',
            marginBottom: '10px',
          }}>
            {toast.text}
          </div>
        )}

        {/* Bulk edit bar (shown when editing series instances) */}
        {selectMode && selectedIds.size > 0 && (
          <div style={{ marginBottom: '14px' }}>
            <BulkEditBar
              selectedCount={selectedIds.size}
              onApply={handleBulkApply}
              onCancel={exitSelectMode}
              applying={applying}
            />
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
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
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={exitSelectMode}
                style={{
                  background: 'none',
                  border: 'none',
                  color: colors.dim,
                  fontSize: '12px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Done
              </button>
            </div>
          </div>
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
        ) : (
          <>
            {recurring.length > 0 && (
              <div style={{ marginBottom: '24px' }}>
                <div style={{ fontSize: '12px', fontWeight: 500, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '10px' }}>
                  Recurring ({recurring.length})
                </div>
                {renderGrid(recurring)}
              </div>
            )}
            {oneOff.length > 0 && (
              <div style={{ marginBottom: '24px' }}>
                <div style={{ fontSize: '12px', fontWeight: 500, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '10px' }}>
                  One-off ({oneOff.length})
                </div>
                {renderGrid(oneOff.map((e) => ({ type: 'single' as const, event: e })))}
              </div>
            )}
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
    </>
  );
}
