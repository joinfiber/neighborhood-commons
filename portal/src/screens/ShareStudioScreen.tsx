import { useState, useEffect, useRef } from 'react';
import { colors, styles } from '../lib/styles';
import { fetchEvent } from '../lib/api';
import type { PortalEvent } from '../lib/types';
import {
  loadShareFonts,
  extractDominantColor,
  renderTemplate,
  downloadCanvas,
  generateCaption,
  canvasToUrl,
  slugify,
  CATEGORY_COLORS,
  type TemplateType,
  type RGB,
} from '../lib/share-studio';

interface ShareStudioScreenProps {
  eventId: string;
  onDone: () => void;
}

export function ShareStudioScreen({ eventId, onDone }: ShareStudioScreenProps) {
  const [event, setEvent] = useState<PortalEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTemplate, setActiveTemplate] = useState<TemplateType>('story');
  const [storyUrl, setStoryUrl] = useState<string | null>(null);
  const [squareUrl, setSquareUrl] = useState<string | null>(null);
  const storyCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const squareCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [caption, setCaption] = useState('');
  const [copied, setCopied] = useState(false);
  const [rendering, setRendering] = useState(false);

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

  // Render templates once event is loaded
  useEffect(() => {
    if (!event) return;
    let cancelled = false;

    (async () => {
      setRendering(true);
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
        renderTemplate(eventData, 'story', color),
        renderTemplate(eventData, 'square', color),
      ]);

      if (cancelled) return;

      storyCanvasRef.current = sc;
      squareCanvasRef.current = sqc;

      const [sUrl, sqUrl] = await Promise.all([
        canvasToUrl(sc),
        canvasToUrl(sqc),
      ]);

      if (cancelled) return;

      setStoryUrl(sUrl);
      setSquareUrl(sqUrl);
      setCaption(generateCaption(eventData));
      setRendering(false);
    })();

    return () => { cancelled = true; };
  }, [event]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    const sUrl = storyUrl;
    const sqUrl = squareUrl;
    return () => {
      if (sUrl) URL.revokeObjectURL(sUrl);
      if (sqUrl) URL.revokeObjectURL(sqUrl);
    };
  }, [storyUrl, squareUrl]);

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
          Go to Dashboard
        </button>
      </div>
    );
  }

  const previewUrl = activeTemplate === 'story' ? storyUrl : squareUrl;

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
            &larr; Dashboard
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
        <div style={{
          background: '#1a1a1a',
          borderRadius: '12px',
          overflow: 'hidden',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: rendering ? '300px' : undefined,
        }}>
          {rendering ? (
            <div style={{ color: '#666', fontSize: '14px', padding: '60px 20px' }}>
              Generating preview...
            </div>
          ) : previewUrl ? (
            <img
              src={previewUrl}
              alt={`${activeTemplate} preview`}
              style={{ width: '100%', display: 'block' }}
            />
          ) : null}
        </div>

        {/* Download Button */}
        <button
          className="btn-primary"
          style={{ ...styles.buttonPrimary, marginBottom: '24px' }}
          onClick={handleDownload}
          disabled={rendering || !previewUrl}
        >
          Download {activeTemplate === 'story' ? 'Story' : 'Square'} Image
        </button>

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
