import { useState, useEffect, useRef, useCallback } from 'react';
import { colors, styles } from '../lib/styles';
import { fetchEvent } from '../lib/api';
import type { PortalEvent } from '../lib/types';
import {
  loadShareFonts,
  extractDominantColor,
  renderTemplate,
  downloadCanvas,
  generateCaption,
  slugify,
  CATEGORY_COLORS,
  FONT_OPTIONS,
  COLOR_SCHEMES,
  GRADIENT_STYLES,
  TEXT_POSITIONS,
  DEFAULT_DESIGN,
  type TemplateType,
  type RGB,
  type CardDesign,
} from '../lib/share-studio';

interface ShareStudioScreenProps {
  eventId: string;
  onDone: () => void;
}

const sectionLabel: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: colors.dim,
};

const optionRow: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
  marginTop: '8px',
  flexWrap: 'wrap',
};

function optionBtn(active: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    borderRadius: '6px',
    border: active ? `2px solid ${colors.accent}` : `1px solid ${colors.border}`,
    background: active ? colors.accentDim : 'none',
    color: active ? colors.accent : colors.muted,
    fontSize: '13px',
    fontWeight: active ? 500 : 400,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'border-color 0.1s, background 0.1s',
  };
}

export function ShareStudioScreen({ eventId, onDone }: ShareStudioScreenProps) {
  const [event, setEvent] = useState<PortalEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTemplate, setActiveTemplate] = useState<TemplateType>('story');
  const [design, setDesign] = useState<CardDesign>({ ...DEFAULT_DESIGN });
  const [dominantColor, setDominantColor] = useState<RGB | null>(null);

  const storyCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const squareCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const [caption, setCaption] = useState('');
  const [copied, setCopied] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderComplete, setRenderComplete] = useState(false);

  // Fetch event data
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchEvent(eventId);
      if (cancelled) return;
      if (res.data?.event) {
        setEvent(res.data.event);
      } else {
        setError(res.error?.message || 'Event not found');
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [eventId]);

  // Extract dominant color once when event loads
  useEffect(() => {
    if (!event) return;
    let cancelled = false;
    (async () => {
      await loadShareFonts();
      let color: RGB;
      if (event.image_url) {
        try {
          color = await extractDominantColor(event.image_url);
        } catch {
          color = CATEGORY_COLORS[event.category] || { r: 40, g: 40, b: 50 };
        }
      } else {
        color = CATEGORY_COLORS[event.category] || { r: 40, g: 40, b: 50 };
      }
      if (cancelled) return;
      setDominantColor(color);
      setCaption(generateCaption({
        title: event.title,
        venue_name: event.venue_name,
        event_date: event.event_date,
        start_time: event.start_time,
        end_time: event.end_time,
        category: event.category,
        description: event.description,
        price: event.price,
      }));
    })();
    return () => { cancelled = true; };
  }, [event]);

  // Render templates when design changes or color becomes available
  useEffect(() => {
    if (!event || !dominantColor) return;
    let cancelled = false;

    (async () => {
      setRendering(true);

      const eventData = {
        title: event.title,
        venue_name: event.venue_name,
        event_date: event.event_date,
        start_time: event.start_time,
        end_time: event.end_time,
        category: event.category,
        image_url: event.image_url,
        image_focal_y: event.image_focal_y,
        description: event.description,
        price: event.price,
      };

      const [sc, sqc] = await Promise.all([
        renderTemplate(eventData, 'story', dominantColor, design),
        renderTemplate(eventData, 'square', dominantColor, design),
      ]);

      if (cancelled) return;

      storyCanvasRef.current = sc;
      squareCanvasRef.current = sqc;
      setRenderComplete(true);
      setRendering(false);
    })();

    return () => { cancelled = true; };
  }, [event, dominantColor, design]);

  // Mount canvas preview into the DOM
  useEffect(() => {
    const container = previewRef.current;
    if (!container || rendering || !renderComplete) return;

    while (container.firstChild) container.removeChild(container.firstChild);

    const canvas = activeTemplate === 'story' ? storyCanvasRef.current : squareCanvasRef.current;
    if (!canvas) return;

    const clone = document.createElement('canvas');
    clone.width = canvas.width;
    clone.height = canvas.height;
    const ctx = clone.getContext('2d');
    if (ctx) ctx.drawImage(canvas, 0, 0);
    clone.style.width = '100%';
    clone.style.height = 'auto';
    clone.style.display = 'block';
    container.appendChild(clone);
  }, [activeTemplate, rendering, renderComplete]);

  const handleDownload = () => {
    const canvas = activeTemplate === 'story' ? storyCanvasRef.current : squareCanvasRef.current;
    if (!canvas || !event) return;
    downloadCanvas(canvas, `${slugify(event.title)}-${activeTemplate}.png`);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(caption);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  };

  const updateDesign = useCallback((patch: Partial<CardDesign>) => {
    setDesign(prev => ({ ...prev, ...patch }));
    setRenderComplete(false);
  }, []);

  // Loading
  if (loading) {
    return (
      <div style={{ textAlign: 'center' as const, paddingTop: '80px' }}>
        <div style={{ color: colors.dim, fontSize: '14px' }}>Loading...</div>
      </div>
    );
  }

  // Error
  if (error || !event) {
    return (
      <div style={{ textAlign: 'center' as const, paddingTop: '80px' }}>
        <div style={{ color: colors.error, fontSize: '14px', marginBottom: '16px' }}>
          {error || 'Event not found'}
        </div>
        <button
          className="btn-secondary"
          style={{ ...styles.buttonSecondary, width: 'auto', padding: '10px 24px' }}
          onClick={onDone}
        >
          Go back
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <button
          type="button"
          className="btn-text"
          style={{ ...styles.buttonText, padding: '0 0 8px 0' }}
          onClick={onDone}
        >
          &larr; Creative Tools
        </button>
        <h1 style={{ ...styles.pageTitle, fontSize: '20px', margin: 0 }}>
          Share your event
        </h1>
        <div style={{ fontSize: '14px', color: colors.muted, marginTop: '4px' }}>
          Download images and copy captions for social media
        </div>
      </div>

      {/* Template Toggle */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {(['story', 'square'] as TemplateType[]).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTemplate(t)}
            style={{
              ...styles.pill,
              ...(activeTemplate === t ? styles.pillActive : styles.pillInactive),
            }}
          >
            {t === 'story' ? 'Story 9:16' : 'Square 1:1'}
          </button>
        ))}
      </div>

      {/* Preview */}
      <div
        ref={previewRef}
        style={{
          background: '#1a1a1a',
          borderRadius: '12px',
          overflow: 'hidden',
          marginBottom: '16px',
          minHeight: rendering ? '300px' : undefined,
          display: rendering ? 'flex' : 'block',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {rendering && (
          <div style={{ color: '#666', fontSize: '14px', padding: '60px 20px' }}>
            Generating preview...
          </div>
        )}
      </div>

      {/* Download Button */}
      <button
        className="btn-primary"
        style={{ ...styles.buttonPrimary, marginBottom: '24px' }}
        onClick={handleDownload}
        disabled={rendering || !renderComplete}
      >
        Download {activeTemplate === 'story' ? 'Story' : 'Square'} Image
      </button>

      {/* ================================================================ */}
      {/* Design Controls                                                  */}
      {/* ================================================================ */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        marginBottom: '24px',
        padding: '20px',
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
      }}>

        {/* Overlay */}
        <div>
          <div style={sectionLabel}>Overlay</div>
          <div style={optionRow}>
            {GRADIENT_STYLES.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => updateDesign({ gradient: g.id })}
                title={g.label}
                style={{
                  width: 44,
                  height: activeTemplate === 'story' ? 62 : 44,
                  borderRadius: '6px',
                  border: design.gradient === g.id
                    ? `2px solid ${colors.accent}`
                    : `1px solid ${colors.border}`,
                  background: g.css,
                  cursor: 'pointer',
                  transition: 'border-color 0.1s',
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
        </div>

        {/* Color */}
        <div>
          <div style={sectionLabel}>Color</div>
          <div style={optionRow}>
            {COLOR_SCHEMES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => updateDesign({ colorScheme: c.id })}
                title={c.label}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  border: design.colorScheme === c.id
                    ? `2px solid ${colors.accent}`
                    : `1px solid ${colors.border}`,
                  background: c.swatch,
                  cursor: 'pointer',
                  transition: 'border-color 0.1s',
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
        </div>

        {/* Font */}
        <div>
          <div style={sectionLabel}>Font</div>
          <div style={optionRow}>
            {FONT_OPTIONS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => updateDesign({ font: f.id })}
                style={{
                  ...optionBtn(design.font === f.id),
                  fontFamily: f.family,
                  fontWeight: f.weight,
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Layout */}
        <div>
          <div style={sectionLabel}>Layout</div>
          <div style={optionRow}>
            {TEXT_POSITIONS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => updateDesign({ position: p.id })}
                style={optionBtn(design.position === p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Details */}
        <div>
          <div style={sectionLabel}>Details</div>
          <div style={optionRow}>
            <button
              type="button"
              onClick={() => updateDesign({ showVenue: !design.showVenue })}
              style={optionBtn(design.showVenue)}
            >
              Venue
            </button>
            <button
              type="button"
              onClick={() => updateDesign({ showDateTime: !design.showDateTime })}
              style={optionBtn(design.showDateTime)}
            >
              Date & Time
            </button>
          </div>
        </div>
      </div>

      <hr style={styles.divider} />

      {/* Caption Section */}
      <div style={{ marginTop: '20px', marginBottom: '24px' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '10px',
        }}>
          <div style={styles.sectionLabel}>Ready-to-post caption</div>
          <button
            onClick={handleCopy}
            style={{
              ...styles.pill,
              ...(copied
                ? { background: colors.successDim, color: colors.success, borderColor: colors.success }
                : styles.pillInactive),
              fontSize: '12px',
              padding: '4px 12px',
            }}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          style={{
            ...styles.textarea,
            minHeight: '180px',
            fontSize: '13px',
            lineHeight: '1.6',
          }}
        />
      </div>

      {/* Done */}
      <button
        className="btn-secondary"
        style={{ ...styles.buttonSecondary, width: '100%', textAlign: 'center' as const }}
        onClick={onDone}
      >
        Done
      </button>

      <div style={{ height: '40px' }} />
    </>
  );
}
