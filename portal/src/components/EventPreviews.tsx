import { useState } from 'react';
import { colors } from '../lib/styles';

interface EventPreviewsProps {
  imageSrc: string;
  focalY: number;
  title: string;
  venueName: string;
  eventDate: string;
  startTime: string;
  category: string;
}

function formatPreviewDate(date: string, time: string): string {
  if (!date) return '';
  try {
    const d = new Date(date + 'T12:00:00');
    const month = d.toLocaleDateString('en-US', { month: 'short' });
    const day = d.getDate();
    const [h, m] = time.split(':').map(Number);
    const hour = h! % 12 || 12;
    const ampm = h! >= 12 ? 'pm' : 'am';
    return `${month} ${day} · ${hour}${m ? `:${m.toString().padStart(2, '0')}` : ''}${ampm}`;
  } catch {
    return date;
  }
}

// Sizes — larger now that we show one at a time
const CARD_WIDTH = 280;
const CARD_IMAGE_HEIGHT = 130;
const SHEET_WIDTH = 280;
const SHEET_IMAGE_HEIGHT = 200;
const STORY_WIDTH = 168;
const STORY_HEIGHT = 299;

// Flutter dark-mode color tokens
const flutter = {
  bg3: '#1E1D1C',      // browse card bg
  sheetBg: '#242320',   // detail sheet bg
  storyBg: '#0F0E0D',   // story bg (ember palette)
  cream: '#F5F0E8',
  sand: '#D4C8B8',
  stone: '#C4B8A8',
};

/** Small inline map-pin icon (Phosphor-style) */
function MapPinIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 256 256" fill="currentColor" style={{ verticalAlign: 'middle', marginRight: '3px', opacity: 0.8 }}>
      <path d="M128 64a40 40 0 1 0 40 40 40 40 0 0 0-40-40Zm0 64a24 24 0 1 1 24-24 24 24 0 0 1-24 24Zm0-112a88.1 88.1 0 0 0-88 88c0 75.3 80 132.2 83.4 134.3a8 8 0 0 0 9.2 0C136 236.2 216 179.3 216 104a88.1 88.1 0 0 0-88-88Zm0 206c-16.5-13-72-60.8-72-118a72 72 0 0 1 144 0c0 57.2-55.5 105-72 118Z" />
    </svg>
  );
}

/** Small inline calendar icon (Phosphor-style) */
function CalendarIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 256 256" fill="currentColor" style={{ verticalAlign: 'middle', marginRight: '3px', opacity: 0.8 }}>
      <path d="M208 32h-24V24a8 8 0 0 0-16 0v8H88V24a8 8 0 0 0-16 0v8H48a16 16 0 0 0-16 16v160a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V48a16 16 0 0 0-16-16ZM72 48v8a8 8 0 0 0 16 0v-8h80v8a8 8 0 0 0 16 0v-8h24v32H48V48Zm136 160H48V96h160Z" />
    </svg>
  );
}

/** Browse card — matches Flutter browse_event_card.dart */
function BrowseCard({ imageSrc, focalY, title, venueName, eventDate, startTime, category }: EventPreviewsProps) {
  return (
    <div style={{
      width: CARD_WIDTH,
      background: flutter.bg3,
      borderRadius: '12px',
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      {/* Image with separate radius + margin (Flutter: padding + ClipRRect) */}
      <div style={{
        margin: '10px 10px 0',
        borderRadius: '8px',
        overflow: 'hidden',
        height: CARD_IMAGE_HEIGHT,
      }}>
        <img
          src={imageSrc}
          alt=""
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: `center ${focalY * 100}%`,
          }}
        />
      </div>
      <div style={{ padding: '10px 12px 12px' }}>
        {/* Title — browseTitle: 18px w500 → scaled 13px */}
        <div style={{
          fontSize: '13px',
          fontWeight: 500,
          color: flutter.cream,
          lineHeight: 1.33,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {title}
        </div>
        {/* Venue · Time — browseVenue 14px w400 + browseTime 14px w500 → scaled 10px */}
        <div style={{
          fontSize: '10px',
          color: flutter.stone,
          marginTop: '3px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {venueName}
          {eventDate && (
            <span style={{ color: flutter.sand, fontWeight: 500 }}>
              {' · '}{formatPreviewDate(eventDate, startTime)}
            </span>
          )}
        </div>
        {/* Category pill — cream@8% bg, sand text */}
        {category && (
          <div style={{
            display: 'inline-block',
            marginTop: '6px',
            padding: '2px 8px',
            borderRadius: '12px',
            background: 'rgba(245,240,232,0.08)',
            color: flutter.sand,
            fontSize: '9px',
            fontWeight: 500,
          }}>
            {category}
          </div>
        )}
      </div>
    </div>
  );
}

/** Detail sheet — matches Flutter browse_detail_sheet.dart with user's ease-in gradient */
function InfoSheet({ imageSrc, focalY, title, venueName, eventDate, startTime }: EventPreviewsProps) {
  // User's ease-in gradient: 70% vertical = 90% expressed
  const sheetGradient = `linear-gradient(to bottom,
    rgba(36,35,32, 0) 0%,
    rgba(36,35,32, 0.03) 30%,
    rgba(36,35,32, 0.15) 50%,
    rgba(36,35,32, 0.35) 60%,
    rgba(36,35,32, 0.90) 70%,
    rgba(36,35,32, 0.98) 85%,
    rgba(36,35,32, 1.0) 100%
  )`;

  return (
    <div style={{
      width: SHEET_WIDTH,
      background: flutter.sheetBg,
      borderRadius: '20px 20px 0 0',
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      {/* Image area with gradient overlay */}
      <div style={{
        height: SHEET_IMAGE_HEIGHT,
        overflow: 'hidden',
        position: 'relative',
      }}>
        <img
          src={imageSrc}
          alt=""
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: `center ${focalY * 100}%`,
          }}
        />
        {/* Ease-in gradient overlay */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: sheetGradient,
        }} />
        {/* Title block at bottom of image */}
        <div style={{
          position: 'absolute',
          bottom: '8px',
          left: '14px',
          right: '14px',
        }}>
          <div style={{
            fontSize: '16px',
            fontWeight: 600,
            color: flutter.cream,
            lineHeight: 1.2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {title}
          </div>
        </div>
      </div>
      {/* Content area — seamless with gradient end */}
      <div style={{ padding: '6px 14px 12px' }}>
        <div style={{
          fontSize: '11px',
          color: flutter.sand,
          display: 'flex',
          alignItems: 'center',
        }}>
          <span style={{ color: flutter.stone }}><MapPinIcon /></span>
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {venueName}
          </span>
        </div>
        <div style={{
          fontSize: '11px',
          color: flutter.sand,
          marginTop: '3px',
          display: 'flex',
          alignItems: 'center',
        }}>
          <span style={{ color: flutter.stone }}><CalendarIcon /></span>
          {formatPreviewDate(eventDate, startTime)}
        </div>
      </div>
    </div>
  );
}

/** Story mockup — matches Flutter story_frame_painter.dart (ember palette) */
function StoryMockup({ imageSrc, focalY, title, venueName }: EventPreviewsProps) {
  return (
    <div style={{
      width: STORY_WIDTH,
      height: STORY_HEIGHT,
      borderRadius: '10px',
      overflow: 'hidden',
      position: 'relative',
      flexShrink: 0,
    }}>
      <img
        src={imageSrc}
        alt=""
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: `center ${focalY * 100}%`,
        }}
      />
      {/* Top scrim — 35% height, 0.65→0 alpha */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: '35%',
        background: `linear-gradient(to bottom, rgba(15,14,13,0.65), rgba(15,14,13,0))`,
      }} />
      {/* Bottom vignette — from 25% to 100%, 0→0.88 alpha */}
      <div style={{
        position: 'absolute',
        top: '25%',
        left: 0,
        right: 0,
        bottom: 0,
        background: `linear-gradient(to bottom, rgba(15,14,13,0), rgba(15,14,13,0.88))`,
      }} />
      {/* Title + venue at bottom */}
      <div style={{
        position: 'absolute',
        bottom: '10px',
        left: '10px',
        right: '10px',
      }}>
        <div style={{
          fontFamily: "'Georgia', 'Times New Roman', serif",
          fontSize: '14px',
          fontWeight: 400,
          color: flutter.cream,
          lineHeight: 1.2,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {title}
        </div>
        <div style={{
          fontSize: '9px',
          color: 'rgba(245,240,232,0.7)',
          marginTop: '2px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {venueName}
        </div>
      </div>
    </div>
  );
}

const LABELS = ['Browse Card', 'Detail Sheet', 'Story'];
const COMPONENTS = [BrowseCard, InfoSheet, StoryMockup];

export function EventPreviews(props: EventPreviewsProps) {
  const [index, setIndex] = useState(0);
  const Component = COMPONENTS[index]!;

  return (
    <div>
      <div style={{ fontSize: '12px', color: colors.muted, marginBottom: '8px' }}>
        How it looks in the app
      </div>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      }}>
        {/* Prev arrow */}
        <button
          type="button"
          onClick={() => setIndex(i => i - 1)}
          disabled={index === 0}
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            border: `1px solid ${colors.border}`,
            background: 'transparent',
            color: colors.muted,
            fontSize: '14px',
            cursor: index === 0 ? 'default' : 'pointer',
            opacity: index === 0 ? 0.3 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'opacity 0.15s',
          }}
        >
          ‹
        </button>
        {/* Active mockup */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <Component {...props} />
        </div>
        {/* Next arrow */}
        <button
          type="button"
          onClick={() => setIndex(i => i + 1)}
          disabled={index === LABELS.length - 1}
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            border: `1px solid ${colors.border}`,
            background: 'transparent',
            color: colors.muted,
            fontSize: '14px',
            cursor: index === LABELS.length - 1 ? 'default' : 'pointer',
            opacity: index === LABELS.length - 1 ? 0.3 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'opacity 0.15s',
          }}
        >
          ›
        </button>
      </div>
      {/* Label */}
      <div style={{
        textAlign: 'center',
        fontSize: '10px',
        color: colors.dim,
        marginTop: '6px',
      }}>
        {LABELS[index]} ({index + 1}/{LABELS.length})
      </div>
    </div>
  );
}
