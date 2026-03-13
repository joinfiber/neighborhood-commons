import { useState, useEffect, useCallback } from 'react';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import { styles, colors } from '../lib/styles';
import { fetchEvents, type PortalEvent, type PortalAccount } from '../lib/api';
import { EventRowSkeleton } from '../components/Skeleton';

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

function EventRow({ event, onClick, seriesTotal }: { event: PortalEvent; onClick: () => void; seriesTotal?: number }) {
  const cat = PORTAL_CATEGORIES[event.category as PortalCategory];
  const today = new Date().toISOString().split('T')[0]!;
  const isPast = event.event_date < today;

  return (
    <div
      className="interactive-row"
      style={{
        ...styles.eventRow,
        opacity: isPast ? 0.5 : 1,
      }}
      onClick={onClick}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '14px', color: colors.cream, fontWeight: 500 }}>
          {event.title}
        </div>
        <div style={{ fontSize: '12px', color: colors.muted, marginTop: '3px' }}>
          {event.venue_name} · {formatDate(event.event_date)} · {formatTime(event.start_time)}
          {event.series_id && seriesTotal && (
            <span style={{ color: colors.dim }}> · {event.series_instance_number} of {seriesTotal}</span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        {cat && (
          <span style={{ ...styles.pill, ...styles.pillActive, fontSize: '10px', padding: '2px 8px', cursor: 'default' }}>
            {cat.label}
          </span>
        )}
        {event.status === 'pending_review' && (
          <span style={{
            fontSize: '10px',
            color: colors.amber,
            background: colors.amberDim,
            border: `1px solid ${colors.amberBorder}`,
            borderRadius: '12px',
            padding: '2px 8px',
          }}>
            pending
          </span>
        )}
        {event.series_id && (
          <span style={{
            fontSize: '10px',
            color: colors.dim,
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

export function DashboardScreen({ account, onCreateEvent, onEditEvent, onSignOut, onSignOutEverywhere }: DashboardScreenProps) {
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountExpanded, setAccountExpanded] = useState(false);
  const [confirmSignOutAll, setConfirmSignOutAll] = useState(false);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    const res = await fetchEvents();
    if (res.data) setEvents(res.data.events);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const today = new Date().toISOString().split('T')[0]!;
  const upcoming = events.filter((e) => e.event_date >= today);
  const past = events.filter((e) => e.event_date < today);

  // Compute series totals for badge display
  const seriesTotals = new Map<string, number>();
  for (const e of events) {
    if (e.series_id) seriesTotals.set(e.series_id, (seriesTotals.get(e.series_id) || 0) + 1);
  }

  return (
    <div style={styles.page}>
      <div style={styles.ambientGlow} />
      <div style={styles.content} className="fade-up">
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px' }}>
          <div>
            <h1 style={styles.pageTitle}>{account.business_name}</h1>
            <p style={{ fontSize: '12px', color: colors.dim, marginTop: '4px' }}>
              {account.email}
            </p>
          </div>
          <button style={styles.buttonText} onClick={onSignOut}>
            Sign Out
          </button>
        </div>

        {/* Verification banner for pending accounts */}
        {account.status === 'pending' && (
          <div style={{
            background: '#2a2418',
            border: `1px solid ${colors.amberBorder}`,
            borderRadius: '10px',
            padding: '14px 16px',
            marginBottom: '16px',
            fontSize: '13px',
            lineHeight: 1.5,
            color: colors.text,
          }}>
            <strong style={{ color: colors.amber }}>Account verification in progress</strong>
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
            <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em', color: colors.dim }}>
              Account
            </span>
            <span style={{ fontSize: '12px', color: colors.muted }}>
              {account.default_address || account.email}
              <span style={{ marginLeft: '8px', fontSize: '10px' }}>{accountExpanded ? '▲' : '▼'}</span>
            </span>
          </button>

          {accountExpanded && (
            <div style={{ padding: '0 16px 16px', borderTop: `1px solid ${colors.border}` }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '13px', paddingTop: '14px' }}>
                <div>
                  <div style={{ color: colors.muted, fontSize: '11px', marginBottom: '2px' }}>Email</div>
                  <div style={{ color: colors.cream }}>{account.email}</div>
                </div>
                <div>
                  <div style={{ color: colors.muted, fontSize: '11px', marginBottom: '2px' }}>Status</div>
                  <div style={{ color: colors.cream }}>{account.status}</div>
                </div>
                {account.default_venue_name && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '11px', marginBottom: '2px' }}>Venue</div>
                    <div style={{ color: colors.cream }}>{account.default_venue_name}</div>
                  </div>
                )}
                {account.default_address && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '11px', marginBottom: '2px' }}>Address</div>
                    <div style={{ color: colors.cream }}>{account.default_address}</div>
                  </div>
                )}
                {account.website && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '11px', marginBottom: '2px' }}>Website</div>
                    <div style={{ color: colors.cream }}>{account.website}</div>
                  </div>
                )}
                {account.phone && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '11px', marginBottom: '2px' }}>Phone</div>
                    <div style={{ color: colors.cream }}>{account.phone}</div>
                  </div>
                )}
                {account.wheelchair_accessible != null && (
                  <div>
                    <div style={{ color: colors.muted, fontSize: '11px', marginBottom: '2px' }}>Wheelchair Accessible</div>
                    <div style={{ color: colors.cream }}>{account.wheelchair_accessible ? 'Yes' : 'No'}</div>
                  </div>
                )}
              </div>

              <div style={{ borderTop: `1px solid ${colors.border}`, marginTop: '14px', paddingTop: '14px', display: 'flex', justifyContent: 'flex-end' }}>
                {confirmSignOutAll ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '12px', color: colors.muted }}>Sign out all devices?</span>
                    <button
                      type="button"
                      style={{ ...styles.buttonText, color: colors.error, fontSize: '12px' }}
                      onClick={() => { onSignOutEverywhere(); setConfirmSignOutAll(false); }}
                    >
                      Yes, sign out everywhere
                    </button>
                    <button
                      type="button"
                      style={{ ...styles.buttonText, fontSize: '12px' }}
                      onClick={() => setConfirmSignOutAll(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    style={{ ...styles.buttonText, fontSize: '12px' }}
                    onClick={() => setConfirmSignOutAll(true)}
                  >
                    Sign out everywhere
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* New Event Button */}
        <button
          style={{ ...styles.buttonPrimary, marginBottom: '24px' }}
          onClick={onCreateEvent}
        >
          + New Event
        </button>

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <EventRowSkeleton />
            <EventRowSkeleton />
            <EventRowSkeleton />
          </div>
        ) : events.length === 0 ? (
          <div style={{ ...styles.card, textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ fontSize: '15px', color: colors.cream, marginBottom: '6px' }}>
              No events yet
            </div>
            <div style={{ fontSize: '13px', color: colors.muted }}>
              Create your first event to reach the neighborhood.
            </div>
          </div>
        ) : (
          <>
            {/* Upcoming */}
            {upcoming.length > 0 && (
              <div style={{ marginBottom: '24px' }}>
                <div style={{ ...styles.sectionLabel, marginBottom: '10px' }}>
                  Upcoming ({upcoming.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {upcoming.map((event) => (
                    <EventRow key={event.id} event={event} onClick={() => onEditEvent(event)} seriesTotal={event.series_id ? seriesTotals.get(event.series_id) : undefined} />
                  ))}
                </div>
              </div>
            )}

            {/* Past */}
            {past.length > 0 && (
              <div>
                <div style={{ ...styles.sectionLabel, marginBottom: '10px' }}>
                  Past ({past.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {past.map((event) => (
                    <EventRow key={event.id} event={event} onClick={() => onEditEvent(event)} seriesTotal={event.series_id ? seriesTotals.get(event.series_id) : undefined} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
