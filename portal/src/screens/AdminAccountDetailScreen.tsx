import { useState, useEffect, useCallback } from 'react';
import { styles, colors } from '../lib/styles';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import {
  adminFetchAccount, adminDeleteEvent,
  adminApproveAccount, adminRejectAccount,
  adminSuspendAccount, adminReactivateAccount,
  adminFetchAccountActivity,
  type PortalAccount, type PortalEvent, type ActivityLogEntry,
} from '../lib/api';
import { AccountInfoSkeleton, EventRowSkeleton } from '../components/Skeleton';
import { ConfirmDialog } from '../components/ConfirmDialog';

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

interface AdminAccountDetailScreenProps {
  accountId: string;
  onBack: () => void;
  onCreateEvent: (account: PortalAccount) => void;
  onEditEvent: (event: PortalEvent, account: PortalAccount) => void;
}

export function AdminAccountDetailScreen({ accountId, onBack, onCreateEvent, onEditEvent }: AdminAccountDetailScreenProps) {
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

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.contentWide}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <button type="button" className="btn-text" style={styles.buttonText} onClick={onBack}>← Back</button>
          </div>
          <AccountInfoSkeleton />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '20px' }}>
            <EventRowSkeleton />
            <EventRowSkeleton />
          </div>
        </div>
      </div>
    );
  }

  if (error || !account) {
    return (
      <div style={styles.page}>
        <div style={styles.contentWide}>
          <button type="button" style={styles.buttonText} onClick={onBack}>← Back</button>
          <div style={{ color: colors.error, padding: '24px' }}>{error || 'Account not found'}</div>
        </div>
      </div>
    );
  }

  const today = new Date().toISOString().split('T')[0] ?? '';
  const upcoming = events.filter((e) => e.event_date >= today);
  const past = events.filter((e) => e.event_date < today);

  return (
    <div style={styles.page}>
      <div style={styles.contentWide} className="fade-up">
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
                    background: colors.accent,
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '8px 20px',
                    fontSize: '14px',
                    fontWeight: 500,
                    cursor: 'pointer',
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
                background: colors.success,
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '8px 20px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '14px' }}>
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

        {/* Post Event Button */}
        <button
          type="button"
          style={{ ...styles.buttonPrimary, marginBottom: '20px' }}
          onClick={() => onCreateEvent(account)}
        >
          + Post Event for {account.business_name}
        </button>

        {/* Events */}
        {renderEventSection('Upcoming', upcoming, account)}
        {renderEventSection('Past', past, account, true)}

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
    </div>
  );

  function renderEventSection(label: string, items: PortalEvent[], acct: PortalAccount, faded = false) {
    if (items.length === 0) return null;
    return (
      <div style={{ marginBottom: '20px', opacity: faded ? 0.5 : 1 }}>
        <div style={{ ...styles.sectionLabel, marginBottom: '8px' }}>
          {label} ({items.length})
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {items.map((event) => (
            <div
              key={event.id}
              style={{
                ...styles.eventRow,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <button
                type="button"
                style={{ flex: 1, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
                onClick={() => onEditEvent(event, acct)}
              >
                <div style={{ fontSize: '16px', fontWeight: 500, color: colors.cream }}>{event.title}</div>
                <div style={{ fontSize: '14px', color: colors.muted }}>
                  {event.venue_name} · {event.event_date} · {event.start_time}
                </div>
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ ...styles.pill, ...styles.pillInactive, fontSize: '11px', padding: '2px 8px' }}>
                  {PORTAL_CATEGORIES[event.category as PortalCategory]?.label || event.category}
                </span>
                {event.status === 'pending_review' && (
                  <span style={{
                    fontSize: '11px',
                    color: '#92600a',
                    background: '#fef3cd',
                    border: `1px solid #fde68a`,
                    borderRadius: '12px',
                    padding: '2px 8px',
                  }}>
                    pending
                  </span>
                )}
                <button
                  type="button"
                  className="btn-text"
                  style={{ ...styles.buttonText, color: colors.error, fontSize: '12px' }}
                  onClick={() => setDeleteEventId(event.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
}
