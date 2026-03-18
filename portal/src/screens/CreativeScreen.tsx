import { useState, useEffect, useCallback } from 'react';
import { PORTAL_CATEGORIES, type PortalCategory } from '../lib/categories';
import { colors } from '../lib/styles';
import { fetchEvents, type PortalEvent } from '../lib/api';
import { CATEGORY_COLORS, type RGB } from '../lib/share-studio';
import { EventRowSkeleton } from '../components/Skeleton';

interface CreativeScreenProps {
  onShareEvent: (event: PortalEvent) => void;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function rgbToString({ r, g, b }: RGB): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function lighten({ r, g, b }: RGB, amount: number): RGB {
  return { r: Math.min(255, r + amount), g: Math.min(255, g + amount), b: Math.min(255, b + amount) };
}

function getCategoryColor(category: string): RGB {
  return CATEGORY_COLORS[category] || { r: 140, g: 120, b: 200 };
}

// Mini preview card that hints at the share studio output
function CreativeEventCard({ event, onShare }: { event: PortalEvent; onShare: () => void }) {
  const cat = PORTAL_CATEGORIES[event.category as PortalCategory];
  const catColor = getCategoryColor(event.category);
  const today = new Date().toISOString().split('T')[0]!;
  const isPast = event.event_date < today;

  return (
    <div
      className="interactive-row"
      style={{
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
        opacity: isPast ? 0.5 : 1,
      }}
      onClick={onShare}
    >
      {/* Color band preview — evokes the share card */}
      <div style={{
        height: '48px',
        background: `linear-gradient(135deg, ${rgbToString(catColor)}, ${rgbToString(lighten(catColor, 40))})`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      }}>
        <div style={{
          fontSize: '13px',
          fontWeight: 600,
          color: '#fff',
          textShadow: '0 1px 3px rgba(0,0,0,0.3)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          padding: '0 16px',
          maxWidth: '100%',
        }}>
          {event.title}
        </div>
        {event.image_url && (
          <div style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `url(${event.image_url})`,
            backgroundSize: 'cover',
            backgroundPosition: `center ${(event.image_focal_y ?? 0.5) * 100}%`,
            opacity: 0.3,
          }} />
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '10px 14px' }}>
        <div style={{ fontSize: '13px', color: colors.cream, fontWeight: 500, marginBottom: '4px' }}>
          {event.title}
        </div>
        <div style={{ fontSize: '12px', color: colors.muted, marginBottom: '8px' }}>
          {formatDate(event.event_date)} · {event.venue_name}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {cat && (
            <span style={{ fontSize: '11px', color: colors.dim }}>{cat.label}</span>
          )}
          <span style={{
            fontSize: '11px',
            fontWeight: 500,
            color: colors.accent,
          }}>
            Create →
          </span>
        </div>
      </div>
    </div>
  );
}

export function CreativeScreen({ onShareEvent }: CreativeScreenProps) {
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    const res = await fetchEvents();
    if (res.data) setEvents(res.data.events);
    setLoading(false);
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  const today = new Date().toISOString().split('T')[0]!;

  // Dedupe series: show only the next upcoming instance per series
  const deduped: PortalEvent[] = [];
  const seenSeries = new Set<string>();
  const sorted = [...events].sort((a, b) => a.event_date.localeCompare(b.event_date));

  for (const e of sorted) {
    if (e.series_id) {
      if (seenSeries.has(e.series_id)) continue;
      seenSeries.add(e.series_id);
    }
    deduped.push(e);
  }

  // Upcoming first, then past
  const upcoming = deduped.filter((e) => e.event_date >= today);
  const past = deduped.filter((e) => e.event_date < today);

  return (
    <>
      {/* Header */}
      <div style={{ marginBottom: '20px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 600, color: colors.cream, margin: 0 }}>
          Creative
        </h1>
        <p style={{ fontSize: '13px', color: colors.muted, margin: '4px 0 0' }}>
          Generate social cards, stories, and share links for your events.
          Pick an event to create assets in the Share Studio.
        </p>
      </div>

      {/* What's possible */}
      <div style={{
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        padding: '16px',
        marginBottom: '24px',
        display: 'flex',
        gap: '20px',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <div style={{ fontSize: '14px', fontWeight: 500, color: colors.cream, marginBottom: '4px' }}>
            Share Studio
          </div>
          <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
            Each event gets its own branded social card — ready for Instagram stories, feed posts, and more.
            Colors are pulled from your event's category. Upload an image to make it yours.
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {/* Mini template previews */}
          <div style={{
            width: '40px',
            height: '70px',
            borderRadius: '6px',
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.7)' }}>Story</span>
          </div>
          <div style={{
            width: '55px',
            height: '55px',
            borderRadius: '6px',
            background: 'linear-gradient(135deg, #f59e0b, #ef4444)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            alignSelf: 'center',
          }}>
            <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.7)' }}>Post</span>
          </div>
        </div>
      </div>

      {/* Event grid */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <EventRowSkeleton />
          <EventRowSkeleton />
          <EventRowSkeleton />
        </div>
      ) : deduped.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: '15px', color: colors.cream, marginBottom: '4px' }}>
            No events yet
          </div>
          <div style={{ fontSize: '13px', color: colors.muted }}>
            Create an event first, then come back here to generate share assets.
          </div>
        </div>
      ) : (
        <>
          {upcoming.length > 0 && (
            <div style={{ marginBottom: '24px' }}>
              <div style={{ fontSize: '12px', fontWeight: 500, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '10px' }}>
                Upcoming ({upcoming.length})
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: '10px',
              }}>
                {upcoming.map((event) => (
                  <CreativeEventCard
                    key={event.id}
                    event={event}
                    onShare={() => onShareEvent(event)}
                  />
                ))}
              </div>
            </div>
          )}
          {past.length > 0 && (
            <div style={{ marginBottom: '24px' }}>
              <div style={{ fontSize: '12px', fontWeight: 500, color: colors.dim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '10px' }}>
                Past ({past.length})
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: '10px',
              }}>
                {past.map((event) => (
                  <CreativeEventCard
                    key={event.id}
                    event={event}
                    onShare={() => onShareEvent(event)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
