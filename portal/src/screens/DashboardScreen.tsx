import { useState, useEffect, useCallback, useMemo } from 'react';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import { colors, categoryColors, styles, spacing, radii } from '../lib/styles';
import { fetchEvents, extendEventSeries, deleteEvent, type PortalEvent, type PortalAccount } from '../lib/api';
import { EventRowSkeleton } from '../components/Skeleton';
import { formatRecurrenceLabel } from '../lib/recurrence';

interface DashboardScreenProps {
  account: PortalAccount;
  onEditEvent: (event: PortalEvent) => void;
  onShareEvent: (event: PortalEvent) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(d: string): string {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTime(t: string): string {
  const [h, m] = t.split(':');
  const hour = parseInt(h!, 10);
  return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => n < 10 ? `0${n}` : `${n}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SeriesGroup {
  seriesId: string;
  title: string;
  category: string;
  recurrence: string;
  startTime: string;
  endTime: string | null;
  events: PortalEvent[];
  nextEvent: PortalEvent | null;
  upcomingCount: number;
}

interface DateGroup {
  date: string;
  label: string;
  events: PortalEvent[];
}

// ---------------------------------------------------------------------------
// Event Row — expandable
// ---------------------------------------------------------------------------

function EventRow({ event, onEdit, onDelete, isPast, expanded, onToggle }: {
  event: PortalEvent; onEdit: () => void; onDelete: () => void;
  isPast: boolean; expanded: boolean; onToggle: () => void;
}) {
  const catColor = categoryColors[event.category];
  const catLabel = PORTAL_CATEGORIES[event.category as PortalCategory]?.label;

  return (
    <div style={{
      background: colors.card, border: `1px solid ${expanded ? colors.accentBorder : colors.border}`,
      borderRadius: radii.md, opacity: isPast ? 0.5 : 1,
      transition: 'border-color 0.15s',
    }}>
      {/* Collapsed row — always visible */}
      <button
        type="button"
        onClick={onToggle}
        className="interactive-row"
        style={{
          display: 'flex', alignItems: 'center', gap: '12px',
          width: '100%', padding: '10px 14px', background: 'transparent',
          border: 'none', borderRadius: radii.md,
          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 500, color: colors.heading, lineHeight: 1.3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {event.title}
          </div>
          {!expanded && event.venue_name && (
            <div style={{ fontSize: '12px', color: colors.dim, marginTop: '1px',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {event.venue_name}
            </div>
          )}
        </div>

        {catLabel && (
          <span style={{
            fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
            padding: '2px 8px', borderRadius: radii.pill, flexShrink: 0,
            background: catColor?.bg || colors.bg, color: catColor?.fg || colors.muted,
          }}>
            {catLabel}
          </span>
        )}

        <span className="tnum" style={{ fontSize: '13px', color: colors.muted, flexShrink: 0, fontWeight: 500 }}>
          {fmtTime(event.start_time)}
          {event.end_time && <span style={{ color: colors.dim }}> – {fmtTime(event.end_time)}</span>}
        </span>
      </button>

      {/* Expanded detail — full event info */}
      {expanded && (
        <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${colors.border}` }}>
          <div style={{ display: 'flex', gap: '14px', paddingTop: '12px' }}>

            {/* Thumbnail */}
            {event.image_url && (
              <img src={event.image_url} alt="" style={{
                width: '100px', height: '56px', objectFit: 'cover',
                objectPosition: `center ${(event.image_focal_y ?? 0.5) * 100}%`,
                borderRadius: radii.sm, flexShrink: 0,
              }} />
            )}

            {/* Details */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* Date + Time */}
              <div className="tnum" style={{ fontSize: '13px', fontWeight: 500, color: colors.text, marginBottom: '4px' }}>
                {fmtDate(event.event_date)} · {fmtTime(event.start_time)}
                {event.end_time && <> – {fmtTime(event.end_time)}</>}
              </div>

              {/* Venue */}
              {event.venue_name && (
                <div style={{ fontSize: '13px', color: colors.muted, marginBottom: '2px' }}>
                  {event.venue_name}
                </div>
              )}
              {event.address && (
                <div style={{ fontSize: '12px', color: colors.dim, marginBottom: '6px' }}>
                  {event.address}
                </div>
              )}

              {/* Price */}
              {event.price && (
                <div style={{ fontSize: '13px', fontWeight: 500, color: colors.text, marginBottom: '6px' }}>
                  {event.price}
                </div>
              )}

              {/* Description */}
              {event.description && (
                <div style={{ fontSize: '13px', color: colors.text, lineHeight: 1.5, marginBottom: '6px',
                  whiteSpace: 'pre-wrap', maxHeight: '80px', overflow: 'hidden' }}>
                  {event.description}
                </div>
              )}

              {/* Tags */}
              {event.tags && event.tags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' }}>
                  {event.tags.map((tag) => (
                    <span key={tag} style={{
                      fontSize: '10px', padding: '1px 6px', borderRadius: radii.pill,
                      background: colors.bg, color: colors.dim, border: `1px solid ${colors.border}`,
                    }}>
                      {tag.replace(/-/g, ' ')}
                    </span>
                  ))}
                </div>
              )}

              {/* Link */}
              {event.ticket_url && (
                <div style={{ fontSize: '12px', color: colors.dim, overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '6px' }}>
                  {event.ticket_url.replace(/^https?:\/\//, '')}
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '12px', marginTop: '10px', borderTop: `1px solid ${colors.border}`, paddingTop: '10px' }}>
            <button type="button" onClick={onEdit}
              style={{ ...styles.buttonPrimary, width: 'auto', padding: '7px 20px', fontSize: '13px' }}>
              Edit
            </button>
            <button type="button" onClick={onDelete}
              style={{ ...styles.buttonText, color: colors.error, fontSize: '12px', padding: '4px 0' }}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Series Card
// ---------------------------------------------------------------------------

function SeriesCard({ series, onEditSeries, onEditNext, onExtend }: {
  series: SeriesGroup;
  onEditSeries: () => void;
  onEditNext: () => void;
  onExtend: () => void;
}) {
  const catColor = categoryColors[series.category];
  const catLabel = PORTAL_CATEGORIES[series.category as PortalCategory]?.label;
  const recLabel = formatRecurrenceLabel(series.recurrence);
  const runningLow = series.upcomingCount > 0 && series.upcomingCount <= 5;
  const expired = series.upcomingCount === 0;

  return (
    <div style={{
      background: colors.card, border: `1px solid ${colors.border}`,
      borderRadius: radii.md, padding: '14px 16px',
      opacity: expired ? 0.6 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '15px', fontWeight: 600, color: colors.heading, lineHeight: 1.3 }}>
            {series.title}
          </div>
          <div className="tnum" style={{ fontSize: '13px', color: colors.muted, marginTop: '3px' }}>
            {recLabel} · {fmtTime(series.startTime)}
            {series.endTime && <> – {fmtTime(series.endTime)}</>}
          </div>
          <div style={{ fontSize: '12px', color: colors.dim, marginTop: '2px' }}>
            {series.nextEvent && <>Next: {fmtDate(series.nextEvent.event_date)} · </>}
            {series.upcomingCount} upcoming
          </div>
        </div>
        {catLabel && (
          <span style={{
            fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
            padding: '2px 8px', borderRadius: radii.pill, flexShrink: 0,
            background: catColor?.bg || colors.bg, color: catColor?.fg || colors.muted,
          }}>
            {catLabel}
          </span>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '12px', marginTop: '10px', alignItems: 'center' }}>
        <button type="button" onClick={onEditSeries} className="btn-text"
          style={{ ...styles.buttonText, padding: 0, fontSize: '12px' }}>
          Edit series
        </button>
        {series.nextEvent && (
          <button type="button" onClick={onEditNext} className="btn-text"
            style={{ ...styles.buttonText, padding: 0, fontSize: '12px' }}>
            Edit next
          </button>
        )}
        {(runningLow || expired) && (
          <button type="button" onClick={onExtend}
            style={{
              background: expired ? colors.accent : 'transparent',
              color: expired ? '#fff' : colors.accent,
              border: expired ? 'none' : `1px solid ${colors.accentBorder}`,
              borderRadius: radii.sm, padding: '3px 10px', fontSize: '11px',
              fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
              marginLeft: 'auto',
            }}>
            {expired ? 'Renew' : `${series.upcomingCount} left — extend`}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function DashboardScreen({ account, onEditEvent, onShareEvent: _onShareEvent }: DashboardScreenProps) {
  void _onShareEvent; // retained for future use
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    const res = await fetchEvents();
    if (res.data) setEvents(res.data.events);
    setLoading(false);
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  const today = todayStr();

  // ── Build sections ─────────────────────────────────────────────────────

  const { upcoming, series, pastEvents } = useMemo(() => {
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

    // Build series groups
    const seriesGroups: SeriesGroup[] = [];
    for (const [seriesId, seriesEvents] of seriesMap) {
      seriesEvents.sort((a, b) => a.event_date.localeCompare(b.event_date));
      const upcomingInSeries = seriesEvents.filter((e) => e.event_date >= today);
      const nextEvent = upcomingInSeries[0] || null;
      const representative = nextEvent || seriesEvents[seriesEvents.length - 1]!;
      seriesGroups.push({
        seriesId,
        title: representative.title,
        category: representative.category,
        recurrence: representative.recurrence,
        startTime: representative.start_time,
        endTime: representative.end_time,
        events: seriesEvents,
        nextEvent,
        upcomingCount: upcomingInSeries.length,
      });
    }
    // Active series first, then expired
    seriesGroups.sort((a, b) => {
      if (a.upcomingCount > 0 && b.upcomingCount === 0) return -1;
      if (a.upcomingCount === 0 && b.upcomingCount > 0) return 1;
      const aDate = a.nextEvent?.event_date || 'z';
      const bDate = b.nextEvent?.event_date || 'z';
      return aDate.localeCompare(bDate);
    });

    // Build upcoming (all upcoming events — series instances + one-offs — grouped by date)
    const allUpcoming = [
      ...events.filter((e) => e.event_date >= today),
    ].sort((a, b) => a.event_date.localeCompare(b.event_date) || a.start_time.localeCompare(b.start_time));

    const dateGroups: DateGroup[] = [];
    for (const event of allUpcoming) {
      const last = dateGroups[dateGroups.length - 1];
      if (last && last.date === event.event_date) {
        last.events.push(event);
      } else {
        dateGroups.push({
          date: event.event_date,
          label: fmtDate(event.event_date),
          events: [event],
        });
      }
    }

    // Past events (most recent first)
    const past = singles
      .filter((e) => e.event_date < today)
      .sort((a, b) => b.event_date.localeCompare(a.event_date));

    return { upcoming: dateGroups, series: seriesGroups, pastEvents: past };
  }, [events, today]);

  const handleDelete = async (event: PortalEvent) => {
    if (!confirm(`Delete "${event.title}"? This cannot be undone.`)) return;
    const res = await deleteEvent(event.id);
    if (res.error) {
      setToast({ text: res.error.message, type: 'error' });
    } else {
      setToast({ text: 'Event deleted', type: 'success' });
      setExpandedId(null);
      loadEvents();
    }
  };

  const handleExtend = async (seriesId: string) => {
    const res = await extendEventSeries(seriesId);
    if (res.error) {
      setToast({ text: res.error.message, type: 'error' });
    } else {
      setToast({ text: `Added ${res.data?.added || 0} events`, type: 'success' });
      loadEvents();
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: '720px', width: '100%' }}>

      {/* Toast */}
      {toast && (
        <div style={{
          background: toast.type === 'success' ? colors.successBg : colors.errorBg,
          color: toast.type === 'success' ? colors.success : colors.error,
          borderRadius: radii.sm, padding: '8px 12px', fontSize: '13px', marginBottom: '14px',
        }}>
          {toast.text}
        </div>
      )}

      {/* Pending account banner */}
      {account.status === 'pending' && (
        <div style={{
          background: colors.pendingBg, border: `1px solid ${colors.pendingBorder}`,
          borderRadius: radii.md, padding: '10px 14px', marginBottom: '14px',
          fontSize: '13px', lineHeight: 1.5, color: colors.text,
        }}>
          <strong style={{ color: colors.pending }}>Review in progress</strong> — your events will appear once we've reviewed your account.
        </div>
      )}

      {/* ═══ Loading ══════════════════════════════════════════════════════ */}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <EventRowSkeleton />
          <EventRowSkeleton />
          <EventRowSkeleton />
        </div>
      ) : events.length === 0 ? (

        /* ═══ Empty state ═════════════════════════════════════════════════ */

        <div style={{ textAlign: 'center', padding: '60px 24px' }}>
          <div style={{ fontSize: '16px', color: colors.heading, marginBottom: '6px', fontWeight: 500 }}>
            Your event schedule lives here.
          </div>
          <div style={{ fontSize: '14px', color: colors.muted, marginBottom: '24px', lineHeight: 1.5 }}>
            Add your recurring programs and one-off events.<br />
            They'll appear across neighborhood apps.
          </div>
        </div>
      ) : (
        <>
          {/* ═══ Upcoming — events grouped by date ════════════════════════ */}

          {upcoming.length > 0 && (
            <section style={{ marginBottom: spacing.xl }}>
              <div style={{ ...styles.sectionLabel, marginBottom: '12px' }}>
                Upcoming
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {upcoming.slice(0, 14).map((group) => (
                  <div key={group.date}>
                    {/* Date pillar */}
                    <div className="tnum" style={{
                      fontSize: '12px', fontWeight: 600, color: colors.muted,
                      marginBottom: '6px', letterSpacing: '0.02em',
                    }}>
                      {group.date === today ? 'Today' : group.label}
                    </div>
                    {/* Events for this date */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {group.events.map((event) => (
                        <EventRow
                          key={event.id}
                          event={event}
                          onEdit={() => onEditEvent(event)}
                          onDelete={() => handleDelete(event)}
                          isPast={false}
                          expanded={expandedId === event.id}
                          onToggle={() => setExpandedId(expandedId === event.id ? null : event.id)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ═══ Your Programming — series as named programs ══════════════ */}

          {series.length > 0 && (
            <section style={{ marginBottom: spacing.xl }}>
              <div style={{ ...styles.sectionLabel, marginBottom: '12px' }}>
                Your Programming
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {series.map((s) => (
                  <SeriesCard
                    key={s.seriesId}
                    series={s}
                    onEditSeries={() => {
                      // Edit the next upcoming instance (series template editing via instance)
                      const target = s.nextEvent || s.events[s.events.length - 1];
                      if (target) onEditEvent(target);
                    }}
                    onEditNext={() => {
                      if (s.nextEvent) onEditEvent(s.nextEvent);
                    }}
                    onExtend={() => handleExtend(s.seriesId)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* ═══ Past events — collapsed by default ══════════════════════ */}

          {pastEvents.length > 0 && (
            <section>
              <button
                type="button"
                onClick={() => setShowHistory(!showHistory)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', padding: '10px 0', background: 'none', border: 'none',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <span style={{ ...styles.sectionLabel, margin: 0 }}>
                  Past events ({pastEvents.length})
                </span>
                <span style={{ fontSize: '12px', color: colors.dim, transition: 'transform 0.15s',
                  transform: showHistory ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                  ▸
                </span>
              </button>
              {showHistory && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingBottom: spacing.lg }}>
                  {pastEvents.slice(0, 20).map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      onEdit={() => onEditEvent(event)}
                      onDelete={() => handleDelete(event)}
                      isPast={true}
                      expanded={expandedId === event.id}
                      onToggle={() => setExpandedId(expandedId === event.id ? null : event.id)}
                    />
                  ))}
                  {pastEvents.length > 20 && (
                    <div style={{ fontSize: '12px', color: colors.dim, padding: '8px 0', textAlign: 'center' }}>
                      Showing 20 of {pastEvents.length}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
