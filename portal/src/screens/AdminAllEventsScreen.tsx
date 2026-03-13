import { useState, useEffect, useCallback } from 'react';
import { styles, colors } from '../lib/styles';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import { adminFetchEvents, type AdminPortalEvent } from '../lib/api';
import { EventRowSkeleton } from '../components/Skeleton';

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

  return (
    <div style={styles.page}>
      <div style={styles.contentWide} className="fade-up">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <button type="button" style={styles.buttonText} onClick={onBack}>← Back</button>
          <h1 style={styles.pageTitle}>All Events</h1>
          <span style={{ fontSize: '14px', color: colors.muted }}>({filtered.length})</span>
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
                  gridTemplateColumns: '1fr auto',
                  gap: '12px',
                  alignItems: 'center',
                  background: 'transparent',
                  border: `1px solid ${colors.border}`,
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: '100%',
                  opacity: event.event_date < today ? 0.5 : 1,
                }}
                className="interactive-row"
                onClick={() => event.portal_account_id && onViewAccount(event.portal_account_id)}
              >
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
