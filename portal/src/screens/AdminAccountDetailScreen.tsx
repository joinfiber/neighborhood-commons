import { useState, useEffect, useCallback } from 'react';
import { styles, colors } from '../lib/styles';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import {
  adminFetchAccount, adminDeleteEvent,
  adminApproveAccount, adminRejectAccount,
  adminSuspendAccount, adminReactivateAccount,
  adminFetchAccountActivity,
  adminBatchUpdateEvents, adminBatchDeleteEvents,
  type PortalAccount, type PortalEvent, type ActivityLogEntry,
} from '../lib/api';
import { AccountInfoSkeleton, EventRowSkeleton } from '../components/Skeleton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BulkEditBar } from '../components/BulkEditBar';

const ACTION_LABELS: Record<string, string> = {
  portal_event_created: 'Event created',
  portal_event_updated: 'Event updated',
  portal_event_deleted: 'Event deleted',
  portal_account_suspended: 'Account suspended',
  portal_account_reactivated: 'Account reactivated',
  portal_account_approved: 'Account approved',
  portal_account_rejected: 'Account rejected',
  portal_creation_rate_limited: 'Rate limited',
};

function formatAction(action: string): string {
  return ACTION_LABELS[action] || action.replace(/_/g, ' ');
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

interface EventGroup { type: 'single'; event: PortalEvent }
interface SeriesGroup {
  type: 'series';
  seriesId: string;
  events: PortalEvent[];
  nextEvent: PortalEvent;
}
type DashboardItem = EventGroup | SeriesGroup;

// =============================================================================
// EVENT CARD (admin variant — includes delete)
// =============================================================================

function AdminEventCard({ event, onClick, onDelete, selected, onToggle, selectMode }: {
  event: PortalEvent;
  onClick: () => void;
  onDelete: () => void;
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
        {selectMode ? (
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
        ) : (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            style={{ background: 'none', border: 'none', color: colors.error, fontSize: '11px', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
          >
            Delete
          </button>
        )}
      </div>
      <div style={{ fontSize: '13px', color: colors.muted }}>
        {formatDate(event.event_date)} · {formatTime(event.start_time)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        {cat && <span style={{ fontSize: '11px', color: colors.dim }}>{cat.label}</span>}
        {event.status === 'pending_review' && (
          <span style={{
            fontSize: '10px', color: '#92600a', background: '#fef3cd',
            border: '1px solid #fde68a', borderRadius: '10px', padding: '1px 6px',
          }}>pending</span>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// SERIES CARD (admin variant)
// =============================================================================

function AdminSeriesCard({ group, onClick, selectedIds, onToggle, selectMode }: {
  group: SeriesGroup;
  onClick: (event: PortalEvent) => void;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  selectMode: boolean;
}) {
  const { nextEvent, events } = group;
  const cat = PORTAL_CATEGORIES[nextEvent.category as PortalCategory];
  const today = new Date().toISOString().split('T')[0]!;
  const upcomingCount = events.filter((e) => e.event_date >= today).length;
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
        Next: {formatDate(nextEvent.event_date)} · {formatTime(nextEvent.start_time)}
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
        {nextEvent.status === 'pending_review' && (
          <span style={{
            fontSize: '10px', color: '#92600a', background: '#fef3cd',
            border: '1px solid #fde68a', borderRadius: '10px', padding: '1px 6px',
          }}>pending</span>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// GROUPING LOGIC
// =============================================================================

function buildDashboardItems(events: PortalEvent[], today: string): { upcoming: DashboardItem[]; past: DashboardItem[] } {
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

  const upcomingItems: DashboardItem[] = [];
  const pastItems: DashboardItem[] = [];

  for (const [seriesId, seriesEvents] of seriesMap) {
    seriesEvents.sort((a, b) => a.event_date.localeCompare(b.event_date));
    const upcomingInSeries = seriesEvents.filter((e) => e.event_date >= today);
    const nextEvent = upcomingInSeries[0] || seriesEvents[seriesEvents.length - 1]!;
    const group: SeriesGroup = { type: 'series', seriesId, events: seriesEvents, nextEvent };
    if (upcomingInSeries.length > 0) upcomingItems.push(group);
    else pastItems.push(group);
  }

  for (const e of singles) {
    const item: EventGroup = { type: 'single', event: e };
    if (e.event_date >= today) upcomingItems.push(item);
    else pastItems.push(item);
  }

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
}

// =============================================================================
// MAIN SCREEN
// =============================================================================

interface AdminAccountDetailScreenProps {
  accountId: string;
  onBack: () => void;
  onCreateEvent: (account: PortalAccount) => void;
  onEditEvent: (event: PortalEvent, account: PortalAccount) => void;
  onActAs?: (account: PortalAccount) => void;
}

export function AdminAccountDetailScreen({ accountId, onBack, onCreateEvent, onEditEvent, onActAs }: AdminAccountDetailScreenProps) {
  const [account, setAccount] = useState<PortalAccount | null>(null);
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [deleteEventId, setDeleteEventId] = useState<string | null>(null);
  const [deleteEventLoading, setDeleteEventLoading] = useState(false);
  const [activity, setActivity] = useState<ActivityLogEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  // Bulk edit state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    const res = await adminFetchAccount(accountId);
    if (res.data) {
      setAccount(res.data.account);
      setEvents(res.data.events);
    } else if (res.error) {
      setError(res.error.message);
    }
    setLoading(false);
  }, [accountId]);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    const res = await adminFetchAccountActivity(accountId);
    if (res.data) setActivity(res.data.activity);
    setActivityLoading(false);
  }, [accountId]);

  useEffect(() => { loadData(); loadActivity(); }, [loadData, loadActivity]);

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  async function handleConfirmDeleteEvent() {
    if (!deleteEventId) return;
    setDeleteEventLoading(true);
    const res = await adminDeleteEvent(deleteEventId);
    if (!res.error) {
      setEvents((prev) => prev.filter((e) => e.id !== deleteEventId));
    }
    setDeleteEventLoading(false);
    setDeleteEventId(null);
  }

  async function handleApprove() {
    setActionLoading(true);
    const res = await adminApproveAccount(accountId);
    setActionLoading(false);
    if (res.data) { loadData(); loadActivity(); }
  }

  async function handleReject() {
    setActionLoading(true);
    const res = await adminRejectAccount(accountId);
    setActionLoading(false);
    setConfirmReject(false);
    if (res.data) { loadData(); loadActivity(); }
  }

  async function handleSuspend() {
    setActionLoading(true);
    const res = await adminSuspendAccount(accountId);
    setActionLoading(false);
    setConfirmSuspend(false);
    if (res.data) { loadData(); loadActivity(); }
  }

  async function handleReactivate() {
    setActionLoading(true);
    const res = await adminReactivateAccount(accountId);
    setActionLoading(false);
    if (res.data) { loadData(); loadActivity(); }
  }

  // Bulk edit handlers
  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()); };

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
    setConfirmBulkDelete(false);
    setApplying(true);
    const result = await adminBatchDeleteEvents(Array.from(selectedIds));
    setApplying(false);
    setToast({ text: `Deleted ${result.deleted} event${result.deleted !== 1 ? 's' : ''}`, type: 'success' });
    exitSelectMode();
    loadData();
  };

  if (loading) {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <button type="button" className="btn-text" style={styles.buttonText} onClick={onBack}>← Back</button>
        </div>
        <AccountInfoSkeleton />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '20px' }}>
          <EventRowSkeleton />
          <EventRowSkeleton />
        </div>
      </>
    );
  }

  if (error || !account) {
    return (
      <>
        <button type="button" style={styles.buttonText} onClick={onBack}>← Back</button>
        <div style={{ color: colors.error, padding: '24px' }}>{error || 'Account not found'}</div>
      </>
    );
  }

  const today = new Date().toISOString().split('T')[0] ?? '';
  const { upcoming, past } = buildDashboardItems(events, today);

  const renderSection = (label: string, items: DashboardItem[], faded = false) => {
    if (items.length === 0) return null;
    return (
      <div style={{ marginBottom: '20px', opacity: faded ? 0.6 : 1 }}>
        <div style={{ fontSize: '12px', fontWeight: 500, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '10px' }}>
          {label} ({items.length})
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '8px' }}>
          {items.map((item) => {
            if (item.type === 'series') {
              return (
                <AdminSeriesCard
                  key={item.seriesId}
                  group={item}
                  onClick={(e) => onEditEvent(e, account)}

                  selectedIds={selectedIds}
                  onToggle={toggleSelect}
                  selectMode={selectMode}
                />
              );
            }
            return (
              <AdminEventCard
                key={item.event.id}
                event={item.event}
                onClick={() => onEditEvent(item.event, account)}
                onDelete={() => setDeleteEventId(item.event.id)}
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
    <>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button type="button" style={styles.buttonText} onClick={onBack}>← Back</button>
          <h1 style={styles.pageTitle}>{account.business_name}</h1>
          <span style={{
            fontSize: '11px',
            padding: '2px 8px',
            borderRadius: '4px',
            background: account.status === 'pending' ? '#fef3cd' : account.status === 'rejected' ? '#fef2f2' : account.status === 'suspended' ? '#fef2f2' : account.claimed_at ? colors.successDim : colors.accentDim,
            color: account.status === 'pending' ? '#92600a' : account.status === 'rejected' ? colors.error : account.status === 'suspended' ? colors.error : account.claimed_at ? colors.success : colors.accent,
          }}>
            {account.status === 'pending' ? 'Pending' : account.status === 'rejected' ? 'Rejected' : account.status === 'suspended' ? 'Suspended' : account.claimed_at ? 'Claimed' : 'Managed'}
          </span>
        </div>

        {/* Pending verification actions */}
        {account.status === 'pending' && (
          <div style={{
            background: '#fef3cd',
            border: `1px solid #fde68a`,
            borderRadius: '10px',
            padding: '14px 16px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 500, color: '#92600a' }}>Pending Verification</div>
              <div style={{ fontSize: '14px', color: colors.muted, marginTop: '2px' }}>
                {events.filter((e) => e.status === 'pending_review').length} events waiting for approval
              </div>
            </div>
            {confirmReject ? (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: colors.error }}>Reject and delete events?</span>
                <button type="button" style={{ ...styles.buttonText, color: colors.error, fontSize: '14px' }} disabled={actionLoading} onClick={handleReject}>
                  Yes, reject
                </button>
                <button type="button" style={{ ...styles.buttonText, fontSize: '14px' }} onClick={() => setConfirmReject(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  style={{
                    background: colors.accent, color: '#ffffff', border: 'none',
                    borderRadius: '6px', padding: '8px 20px', fontSize: '14px',
                    fontWeight: 500, cursor: 'pointer',
                  }}
                  disabled={actionLoading}
                  onClick={handleApprove}
                >
                  {actionLoading ? '...' : 'Approve'}
                </button>
                <button
                  type="button"
                  style={{ ...styles.buttonText, color: colors.error, fontSize: '14px' }}
                  onClick={() => setConfirmReject(true)}
                >
                  Reject
                </button>
              </div>
            )}
          </div>
        )}

        {/* Suspended banner */}
        {account.status === 'suspended' && (
          <div style={{
            background: '#fef2f2',
            border: `1px solid #D4725C44`,
            borderRadius: '10px',
            padding: '14px 16px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 500, color: colors.error }}>Account Suspended</div>
              <div style={{ fontSize: '14px', color: colors.muted, marginTop: '2px' }}>
                All events are hidden. Reactivate to re-publish.
              </div>
            </div>
            <button
              type="button"
              style={{
                background: colors.success, color: '#ffffff', border: 'none',
                borderRadius: '6px', padding: '8px 20px', fontSize: '14px',
                fontWeight: 500, cursor: 'pointer',
              }}
              disabled={actionLoading}
              onClick={handleReactivate}
            >
              {actionLoading ? '...' : 'Reactivate'}
            </button>
          </div>
        )}

        {/* Suspend button for active accounts */}
        {account.status === 'active' && (
          <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'flex-end' }}>
            {confirmSuspend ? (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ fontSize: '14px', color: colors.error }}>Suspend and hide all events?</span>
                <button type="button" style={{ ...styles.buttonText, color: colors.error, fontSize: '14px' }} disabled={actionLoading} onClick={handleSuspend}>
                  Yes, suspend
                </button>
                <button type="button" style={{ ...styles.buttonText, fontSize: '14px' }} onClick={() => setConfirmSuspend(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" style={{ ...styles.buttonText, color: colors.error, fontSize: '14px' }} onClick={() => setConfirmSuspend(true)}>
                Suspend account
              </button>
            )}
          </div>
        )}

        {/* Account Info */}
        <div style={{ ...styles.card, marginBottom: '20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', fontSize: '14px' }}>
            <div>
              <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Email</div>
              <div style={{ color: colors.cream }}>{account.email}</div>
            </div>
            <div>
              <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Status</div>
              <div style={{ color: colors.cream }}>{account.status}</div>
            </div>
            {account.phone && (
              <div>
                <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Phone</div>
                <div style={{ color: colors.cream }}>{account.phone}</div>
              </div>
            )}
            {account.website && (
              <div>
                <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Website</div>
                <div style={{ color: colors.cream }}>{account.website}</div>
              </div>
            )}
            {account.default_venue_name && (
              <div>
                <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Default Venue</div>
                <div style={{ color: colors.cream }}>{account.default_venue_name}</div>
              </div>
            )}
            {account.default_address && (
              <div>
                <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Default Address</div>
                <div style={{ color: colors.cream }}>{account.default_address}</div>
              </div>
            )}
            <div>
              <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Created</div>
              <div style={{ color: colors.cream }}>{new Date(account.created_at).toLocaleDateString()}</div>
            </div>
            {account.claimed_at && (
              <div>
                <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Claimed</div>
                <div style={{ color: colors.cream }}>{new Date(account.claimed_at).toLocaleDateString()}</div>
              </div>
            )}
            {account.last_login_at && (
              <div>
                <div style={{ color: colors.muted, fontSize: '12px', marginBottom: '2px' }}>Last Login</div>
                <div style={{ color: colors.cream }}>{new Date(account.last_login_at).toLocaleString()}</div>
              </div>
            )}
          </div>
        </div>

        {/* Action bar */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          {!selectMode && (
            <>
              <button
                type="button"
                style={{ ...styles.buttonPrimary, flex: 1 }}
                onClick={() => onCreateEvent(account)}
              >
                + Post Event
              </button>
              {onActAs && (
                <button
                  type="button"
                  style={{
                    ...styles.buttonSecondary,
                    borderColor: '#2563eb',
                    color: '#2563eb',
                    flex: 1,
                  }}
                  onClick={() => onActAs(account)}
                >
                  Login as {account.business_name.length > 15 ? account.business_name.slice(0, 15) + '...' : account.business_name}
                </button>
              )}
            </>
          )}
          {events.length > 1 && (
            selectMode ? (
              <div style={{ display: 'flex', gap: '8px', flex: 1, alignItems: 'center' }}>
                {selectedIds.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setConfirmBulkDelete(true)}
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
                  style={{ ...styles.buttonSecondary, width: 'auto', padding: '8px 16px', fontSize: '13px' }}
                >
                  Done
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setSelectMode(true)}
                style={{ ...styles.buttonSecondary, width: 'auto', padding: '12px 16px', fontSize: '13px' }}
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
            borderRadius: '6px', padding: '8px 12px', fontSize: '13px', marginBottom: '10px',
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

        {/* Event grid */}
        {renderSection('Upcoming', upcoming)}
        {renderSection('Past', past, true)}

        {events.length === 0 && (
          <div style={{ color: colors.dim, fontSize: '14px', padding: '24px', textAlign: 'center' }}>
            No events yet
          </div>
        )}

        {/* Activity Log */}
        <div style={{ marginTop: '28px' }}>
          <div style={{ ...styles.sectionLabel, marginBottom: '10px' }}>Activity Log</div>
          {activityLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <EventRowSkeleton />
              <EventRowSkeleton />
            </div>
          ) : activity.length === 0 ? (
            <div style={{ color: colors.dim, fontSize: '14px' }}>No activity recorded yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {activity.map((entry) => (
                <div key={entry.id} style={{
                  background: colors.card,
                  border: `1px solid ${colors.border}`,
                  borderRadius: '8px',
                  padding: '10px 14px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}>
                  <div>
                    <span style={{ fontSize: '14px', color: colors.cream }}>
                      {formatAction(entry.action)}
                    </span>
                    {entry.reason && (
                      <span style={{ fontSize: '14px', color: colors.muted, marginLeft: '8px' }}>
                        ({entry.reason})
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: '12px', color: colors.dim, flexShrink: 0, marginLeft: '12px' }}>
                    {new Date(entry.created_at).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

      {deleteEventId && (
        <ConfirmDialog
          title="Delete Event"
          message="This event will be permanently removed. This cannot be undone."
          confirmLabel="Delete"
          destructive
          loading={deleteEventLoading}
          onConfirm={handleConfirmDeleteEvent}
          onCancel={() => setDeleteEventId(null)}
        />
      )}

      {confirmBulkDelete && (
        <ConfirmDialog
          title={`Delete ${selectedIds.size} event${selectedIds.size !== 1 ? 's' : ''}?`}
          message="This cannot be undone. Deleted events are removed from all feeds immediately."
          confirmLabel="Delete"
          destructive
          loading={applying}
          onConfirm={handleBulkDelete}
          onCancel={() => setConfirmBulkDelete(false)}
        />
      )}
    </>
  );
}
