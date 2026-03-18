import { useState, useEffect, useRef, useCallback } from 'react';
import { colors, styles } from '../lib/styles';
import { fetchEvent } from '../lib/api';
import { useBreakpoint } from '../hooks/useBreakpoint';
import type { PortalEvent } from '../lib/types';
import {
  loadShareFonts,
  extractDominantColor,
  renderBackground,
  renderTemplate,
  redrawText,
  downloadCanvas,
  generateCaption,
  slugify,
  CATEGORY_COLORS,
  FONT_OPTIONS,
  COLOR_SCHEMES,
  GRADIENT_STYLES,
  TEXT_POSITIONS,
  DEFAULT_DESIGN,
  SIZE_LIMITS,
  type TemplateType,
  type RGB,
  type CardDesign,
  type FontId,
} from '../lib/share-studio';

interface ShareStudioScreenProps {
  eventId: string;
  onDone: () => void;
}

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const sectionLabel: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: colors.dim,
  marginBottom: '8px',
};

function optionBtn(active: boolean): React.CSSProperties {
  return {
    padding: '5px 12px',
    borderRadius: '6px',
    border: active ? `2px solid ${colors.accent}` : `1px solid ${colors.border}`,
    background: active ? colors.accentDim : 'none',
    color: active ? colors.accent : colors.muted,
    fontSize: '12px',
    fontWeight: active ? 500 : 400,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'border-color 0.1s, background 0.1s',
  };
}

const sliderTrack: React.CSSProperties = {
  width: '100%',
  appearance: 'none',
  height: '4px',
  borderRadius: '2px',
  background: colors.border,
  outline: 'none',
  cursor: 'pointer',
};

const FONT_CATEGORIES = [
  { key: 'serif' as const, label: 'Serif' },
  { key: 'sans' as const, label: 'Sans' },
  { key: 'display' as const, label: 'Display' },
  { key: 'script' as const, label: 'Script' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ShareStudioScreen({ eventId, onDone }: ShareStudioScreenProps) {
  const { isDesktop } = useBreakpoint();

  const [event, setEvent] = useState<PortalEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTemplate, setActiveTemplate] = useState<TemplateType>('story');
  const [design, setDesign] = useState<CardDesign>({ ...DEFAULT_DESIGN });
  const [dominantColor, setDominantColor] = useState<RGB | null>(null);

  // Canvas refs — full composites (bg + text) for each template
  const storyCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const squareCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Background-only canvases (cached, reused during drag)
  const storyBgRef = useRef<HTMLCanvasElement | null>(null);
  const squareBgRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const [caption, setCaption] = useState('');
  const [copied, setCopied] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderComplete, setRenderComplete] = useState(false);

  // Drag state — stored in refs for 60fps performance, not React state
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartY = useRef(0);
  const dragBaseOffsetX = useRef(0);
  const dragBaseOffsetY = useRef(0);
  // Mutable design ref for drag (avoids stale closures)
  const designRef = useRef(design);
  designRef.current = design;

  // =========================================================================
  // Data fetching & color extraction
  // =========================================================================

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

  // =========================================================================
  // Rendering
  // =========================================================================

  const eventDataRef = useRef<ReturnType<typeof getEventData> | null>(null);

  function getEventData(ev: PortalEvent) {
    return {
      title: ev.title,
      venue_name: ev.venue_name,
      event_date: ev.event_date,
      start_time: ev.start_time,
      end_time: ev.end_time,
      category: ev.category,
      image_url: ev.image_url,
      image_focal_y: ev.image_focal_y,
      description: ev.description,
      price: ev.price,
    };
  }

  // Full render — background + text for both templates
  useEffect(() => {
    if (!event || !dominantColor) return;
    let cancelled = false;

    (async () => {
      setRendering(true);
      const eventData = getEventData(event);
      eventDataRef.current = eventData;

      const [storyBg, squareBg] = await Promise.all([
        renderBackground(eventData, 'story', dominantColor, design),
        renderBackground(eventData, 'square', dominantColor, design),
      ]);

      if (cancelled) return;
      storyBgRef.current = storyBg;
      squareBgRef.current = squareBg;

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

  // Mount preview canvas into DOM
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
    clone.style.cursor = 'grab';
    clone.setAttribute('data-preview-canvas', 'true');
    container.appendChild(clone);
  }, [activeTemplate, rendering, renderComplete]);

  // =========================================================================
  // Drag handling — manipulates canvas directly for 60fps
  // =========================================================================

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const previewCanvas = previewRef.current?.querySelector('canvas[data-preview-canvas]') as HTMLCanvasElement | null;
    if (!previewCanvas) return;

    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartY.current = e.clientY;
    dragBaseOffsetX.current = designRef.current.titleOffsetX;
    dragBaseOffsetY.current = designRef.current.titleOffsetY;
    previewCanvas.style.cursor = 'grabbing';
    previewCanvas.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;

    const previewCanvas = previewRef.current?.querySelector('canvas[data-preview-canvas]') as HTMLCanvasElement | null;
    if (!previewCanvas) return;

    // Scale mouse delta to canvas coordinates
    const rect = previewCanvas.getBoundingClientRect();
    const scale = previewCanvas.width / rect.width;
    const dx = (e.clientX - dragStartX.current) * scale;
    const dy = (e.clientY - dragStartY.current) * scale;

    const newOffsetX = dragBaseOffsetX.current + dx;
    const newOffsetY = dragBaseOffsetY.current + dy;

    // Get the source canvas and bg for active template
    const type = activeTemplate;
    const srcCanvas = type === 'story' ? storyCanvasRef.current : squareCanvasRef.current;
    const bgCanvas = type === 'story' ? storyBgRef.current : squareBgRef.current;
    if (!srcCanvas || !bgCanvas || !eventDataRef.current) return;

    // Redraw with new offsets directly on the source canvas
    const tempDesign = { ...designRef.current, titleOffsetX: newOffsetX, titleOffsetY: newOffsetY };
    redrawText(srcCanvas, bgCanvas, eventDataRef.current, type, tempDesign);

    // Copy to preview canvas
    const ctx = previewCanvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      ctx.drawImage(srcCanvas, 0, 0);
    }
  }, [activeTemplate]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    isDragging.current = false;

    const previewCanvas = previewRef.current?.querySelector('canvas[data-preview-canvas]') as HTMLCanvasElement | null;
    if (previewCanvas) {
      previewCanvas.style.cursor = 'grab';
      previewCanvas.releasePointerCapture(e.pointerId);
    }

    // Calculate final offset and commit to state
    const rect = previewCanvas?.getBoundingClientRect();
    if (!rect || !previewCanvas) return;
    const scale = previewCanvas.width / rect.width;
    const dx = (e.clientX - dragStartX.current) * scale;
    const dy = (e.clientY - dragStartY.current) * scale;

    setDesign(prev => ({
      ...prev,
      titleOffsetX: dragBaseOffsetX.current + dx,
      titleOffsetY: dragBaseOffsetY.current + dy,
    }));
  }, []);

  // =========================================================================
  // Actions
  // =========================================================================

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
    } catch { /* Clipboard API not available */ }
  };

  const updateDesign = useCallback((patch: Partial<CardDesign>) => {
    setDesign(prev => ({ ...prev, ...patch }));
    setRenderComplete(false);
  }, []);

  const resetPosition = useCallback(() => {
    updateDesign({ titleOffsetX: 0, titleOffsetY: 0 });
  }, [updateDesign]);

  // =========================================================================
  // Loading / Error
  // =========================================================================

  if (loading) {
    return (
      <div style={{ textAlign: 'center' as const, paddingTop: '80px' }}>
        <div style={{ color: colors.dim, fontSize: '14px' }}>Loading...</div>
      </div>
    );
  }

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

  // =========================================================================
  // Render
  // =========================================================================

  const controlsPanel = (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
      ...(isDesktop ? { width: '360px', flexShrink: 0, overflowY: 'auto' as const, maxHeight: 'calc(100vh - 120px)' } : {}),
    }}>
      {/* Header */}
      <div>
        <button
          type="button"
          className="btn-text"
          style={{ ...styles.buttonText, padding: '0 0 8px 0' }}
          onClick={onDone}
        >
          &larr; Creative Tools
        </button>
        <h1 style={{ ...styles.pageTitle, fontSize: '20px', margin: 0 }}>
          Share Studio
        </h1>
        <div style={{ fontSize: '13px', color: colors.muted, marginTop: '4px' }}>
          Design and download social media assets
        </div>
      </div>

      {/* Template Toggle */}
      <div style={{ display: 'flex', gap: '8px' }}>
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

      {/* Design Controls */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        padding: '16px',
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
      }}>

        {/* Overlay */}
        <div>
          <div style={sectionLabel}>Overlay</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {GRADIENT_STYLES.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => updateDesign({ gradient: g.id })}
                title={g.label}
                style={{
                  width: 40,
                  height: activeTemplate === 'story' ? 56 : 40,
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
          {/* Gradient Opacity */}
          <div style={{ marginTop: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <span style={{ fontSize: '11px', color: colors.dim }}>Opacity</span>
              <span style={{ fontSize: '11px', color: colors.dim }}>{Math.round(design.gradientOpacity * 100)}%</span>
            </div>
            <input
              type="range"
              min="30"
              max="100"
              value={Math.round(design.gradientOpacity * 100)}
              onChange={(e) => updateDesign({ gradientOpacity: Number(e.target.value) / 100 })}
              style={sliderTrack}
            />
          </div>
        </div>

        {/* Color */}
        <div>
          <div style={sectionLabel}>Color</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
            {COLOR_SCHEMES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  if (c.id === 'custom' && !design.customColor) {
                    updateDesign({ colorScheme: c.id, customColor: '#6366f1' });
                  } else {
                    updateDesign({ colorScheme: c.id });
                  }
                }}
                title={c.label}
                style={{
                  width: 28,
                  height: 28,
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
          {/* Color picker for custom */}
          {design.colorScheme === 'custom' && (
            <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="color"
                value={design.customColor || '#6366f1'}
                onChange={(e) => updateDesign({ customColor: e.target.value })}
                style={{
                  width: '36px',
                  height: '28px',
                  border: `1px solid ${colors.border}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                  padding: 0,
                  background: 'none',
                }}
              />
              <span style={{ fontSize: '12px', color: colors.dim, fontFamily: 'monospace' }}>
                {design.customColor || '#6366f1'}
              </span>
            </div>
          )}
        </div>

        {/* Font */}
        <div>
          <div style={sectionLabel}>Font</div>
          {FONT_CATEGORIES.map((cat) => {
            const fontsInCat = FONT_OPTIONS.filter(f => f.category === cat.key);
            if (fontsInCat.length === 0) return null;
            return (
              <div key={cat.key} style={{ marginBottom: '8px' }}>
                <div style={{ fontSize: '10px', color: colors.dim, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {cat.label}
                </div>
                <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                  {fontsInCat.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => updateDesign({ font: f.id as FontId })}
                      style={{
                        ...optionBtn(design.font === f.id),
                        fontFamily: f.family,
                        fontWeight: f.weight,
                        fontSize: '12px',
                        padding: '4px 10px',
                      }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Size Controls */}
        <div>
          <div style={sectionLabel}>Size</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontSize: '11px', color: colors.dim }}>Title</span>
                <span style={{ fontSize: '11px', color: colors.dim }}>{design.titleSize}px</span>
              </div>
              <input
                type="range"
                min={SIZE_LIMITS.titleMin}
                max={SIZE_LIMITS.titleMax}
                value={design.titleSize}
                onChange={(e) => updateDesign({ titleSize: Number(e.target.value) })}
                style={sliderTrack}
              />
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontSize: '11px', color: colors.dim }}>Details</span>
                <span style={{ fontSize: '11px', color: colors.dim }}>{design.supportSize}px</span>
              </div>
              <input
                type="range"
                min={SIZE_LIMITS.supportMin}
                max={SIZE_LIMITS.supportMax}
                value={design.supportSize}
                onChange={(e) => updateDesign({ supportSize: Number(e.target.value) })}
                style={sliderTrack}
              />
            </div>
          </div>
        </div>

        {/* Layout */}
        <div>
          <div style={sectionLabel}>Layout</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
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
          {(design.titleOffsetX !== 0 || design.titleOffsetY !== 0) && (
            <button
              type="button"
              onClick={resetPosition}
              style={{ ...styles.buttonText, fontSize: '11px', color: colors.dim, padding: '4px 0', marginTop: '6px' }}
            >
              Reset drag position
            </button>
          )}
        </div>

        {/* Background */}
        <div>
          <div style={sectionLabel}>Background</div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <span style={{ fontSize: '11px', color: colors.dim }}>Blur</span>
              <span style={{ fontSize: '11px', color: colors.dim }}>{design.blur}px</span>
            </div>
            <input
              type="range"
              min="0"
              max={SIZE_LIMITS.blurMax}
              value={design.blur}
              onChange={(e) => updateDesign({ blur: Number(e.target.value) })}
              style={sliderTrack}
            />
          </div>
        </div>

        {/* Details */}
        <div>
          <div style={sectionLabel}>Details</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
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

      {/* Download Button */}
      <button
        className="btn-primary"
        style={styles.buttonPrimary}
        onClick={handleDownload}
        disabled={rendering || !renderComplete}
      >
        Download {activeTemplate === 'story' ? 'Story' : 'Square'} Image
      </button>

      {/* Caption */}
      <div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '8px',
        }}>
          <div style={styles.sectionLabel}>Caption</div>
          <button
            onClick={handleCopy}
            style={{
              ...styles.pill,
              ...(copied
                ? { background: colors.successDim, color: colors.success, borderColor: colors.success }
                : styles.pillInactive),
              fontSize: '11px',
              padding: '3px 10px',
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
            minHeight: '140px',
            fontSize: '12px',
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
    </div>
  );

  const previewPanel = (
    <div style={{
      flex: 1,
      minWidth: 0,
      ...(isDesktop ? { position: 'sticky' as const, top: '20px', alignSelf: 'flex-start' } : {}),
    }}>
      <div
        ref={previewRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
          background: '#1a1a1a',
          borderRadius: '12px',
          overflow: 'hidden',
          minHeight: rendering ? '300px' : undefined,
          display: rendering ? 'flex' : 'block',
          alignItems: 'center',
          justifyContent: 'center',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        {rendering && (
          <div style={{ color: '#666', fontSize: '14px', padding: '60px 20px' }}>
            Generating preview...
          </div>
        )}
      </div>
      {!rendering && renderComplete && (
        <div style={{ textAlign: 'center', marginTop: '8px' }}>
          <span style={{ fontSize: '11px', color: colors.dim }}>
            Drag to reposition text
          </span>
        </div>
      )}
    </div>
  );

  // Desktop: side-by-side. Mobile: stacked (preview first, then controls).
  if (isDesktop) {
    return (
      <div style={{ display: 'flex', gap: '32px', width: '100%', alignItems: 'flex-start' }}>
        {controlsPanel}
        {previewPanel}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%' }}>
      {/* Header on mobile — above preview */}
      <div>
        <button
          type="button"
          className="btn-text"
          style={{ ...styles.buttonText, padding: '0 0 8px 0' }}
          onClick={onDone}
        >
          &larr; Creative Tools
        </button>
        <h1 style={{ ...styles.pageTitle, fontSize: '20px', margin: 0 }}>
          Share Studio
        </h1>
      </div>

      {/* Template Toggle */}
      <div style={{ display: 'flex', gap: '8px' }}>
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

      {previewPanel}

      {/* On mobile, render controls panel but without the redundant header/toggle */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {/* Design Controls */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
          padding: '16px',
          background: colors.card,
          border: `1px solid ${colors.border}`,
          borderRadius: '10px',
        }}>

          {/* Overlay */}
          <div>
            <div style={sectionLabel}>Overlay</div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {GRADIENT_STYLES.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => updateDesign({ gradient: g.id })}
                  title={g.label}
                  style={{
                    width: 40,
                    height: activeTemplate === 'story' ? 56 : 40,
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
            <div style={{ marginTop: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontSize: '11px', color: colors.dim }}>Opacity</span>
                <span style={{ fontSize: '11px', color: colors.dim }}>{Math.round(design.gradientOpacity * 100)}%</span>
              </div>
              <input
                type="range"
                min="30"
                max="100"
                value={Math.round(design.gradientOpacity * 100)}
                onChange={(e) => updateDesign({ gradientOpacity: Number(e.target.value) / 100 })}
                style={sliderTrack}
              />
            </div>
          </div>

          {/* Color */}
          <div>
            <div style={sectionLabel}>Color</div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
              {COLOR_SCHEMES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    if (c.id === 'custom' && !design.customColor) {
                      updateDesign({ colorScheme: c.id, customColor: '#6366f1' });
                    } else {
                      updateDesign({ colorScheme: c.id });
                    }
                  }}
                  title={c.label}
                  style={{
                    width: 28,
                    height: 28,
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
            {design.colorScheme === 'custom' && (
              <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="color"
                  value={design.customColor || '#6366f1'}
                  onChange={(e) => updateDesign({ customColor: e.target.value })}
                  style={{
                    width: '36px',
                    height: '28px',
                    border: `1px solid ${colors.border}`,
                    borderRadius: '4px',
                    cursor: 'pointer',
                    padding: 0,
                    background: 'none',
                  }}
                />
                <span style={{ fontSize: '12px', color: colors.dim, fontFamily: 'monospace' }}>
                  {design.customColor || '#6366f1'}
                </span>
              </div>
            )}
          </div>

          {/* Font */}
          <div>
            <div style={sectionLabel}>Font</div>
            {FONT_CATEGORIES.map((cat) => {
              const fontsInCat = FONT_OPTIONS.filter(f => f.category === cat.key);
              if (fontsInCat.length === 0) return null;
              return (
                <div key={cat.key} style={{ marginBottom: '8px' }}>
                  <div style={{ fontSize: '10px', color: colors.dim, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {cat.label}
                  </div>
                  <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                    {fontsInCat.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => updateDesign({ font: f.id as FontId })}
                        style={{
                          ...optionBtn(design.font === f.id),
                          fontFamily: f.family,
                          fontWeight: f.weight,
                          fontSize: '12px',
                          padding: '4px 10px',
                        }}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Size Controls */}
          <div>
            <div style={sectionLabel}>Size</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontSize: '11px', color: colors.dim }}>Title</span>
                  <span style={{ fontSize: '11px', color: colors.dim }}>{design.titleSize}px</span>
                </div>
                <input
                  type="range"
                  min={SIZE_LIMITS.titleMin}
                  max={SIZE_LIMITS.titleMax}
                  value={design.titleSize}
                  onChange={(e) => updateDesign({ titleSize: Number(e.target.value) })}
                  style={sliderTrack}
                />
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontSize: '11px', color: colors.dim }}>Details</span>
                  <span style={{ fontSize: '11px', color: colors.dim }}>{design.supportSize}px</span>
                </div>
                <input
                  type="range"
                  min={SIZE_LIMITS.supportMin}
                  max={SIZE_LIMITS.supportMax}
                  value={design.supportSize}
                  onChange={(e) => updateDesign({ supportSize: Number(e.target.value) })}
                  style={sliderTrack}
                />
              </div>
            </div>
          </div>

          {/* Layout */}
          <div>
            <div style={sectionLabel}>Layout</div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
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
            {(design.titleOffsetX !== 0 || design.titleOffsetY !== 0) && (
              <button
                type="button"
                onClick={resetPosition}
                style={{ ...styles.buttonText, fontSize: '11px', color: colors.dim, padding: '4px 0', marginTop: '6px' }}
              >
                Reset drag position
              </button>
            )}
          </div>

          {/* Background */}
          <div>
            <div style={sectionLabel}>Background</div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontSize: '11px', color: colors.dim }}>Blur</span>
                <span style={{ fontSize: '11px', color: colors.dim }}>{design.blur}px</span>
              </div>
              <input
                type="range"
                min="0"
                max={SIZE_LIMITS.blurMax}
                value={design.blur}
                onChange={(e) => updateDesign({ blur: Number(e.target.value) })}
                style={sliderTrack}
              />
            </div>
          </div>

          {/* Details */}
          <div>
            <div style={sectionLabel}>Details</div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
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

        {/* Download Button */}
        <button
          className="btn-primary"
          style={styles.buttonPrimary}
          onClick={handleDownload}
          disabled={rendering || !renderComplete}
        >
          Download {activeTemplate === 'story' ? 'Story' : 'Square'} Image
        </button>

        {/* Caption */}
        <div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '8px',
          }}>
            <div style={styles.sectionLabel}>Caption</div>
            <button
              onClick={handleCopy}
              style={{
                ...styles.pill,
                ...(copied
                  ? { background: colors.successDim, color: colors.success, borderColor: colors.success }
                  : styles.pillInactive),
                fontSize: '11px',
                padding: '3px 10px',
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
              minHeight: '140px',
              fontSize: '12px',
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
      </div>
    </div>
  );
}
