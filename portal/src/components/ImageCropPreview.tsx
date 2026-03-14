import { useRef, useCallback } from 'react';
import { colors } from '../lib/styles';

interface ImageCropPreviewProps {
  imageSrc: string;
  focalY: number;
  onFocalYChange: (y: number) => void;
}

/**
 * Overlay crop preview on the uploaded image.
 * A draggable horizontal line shows where the vertical center of the crop
 * will be. The visible "crop window" band shows what the browse card sees.
 */
export function ImageCropPreview({ imageSrc, focalY, onFocalYChange }: ImageCropPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const updateFocal = useCallback((clientY: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    onFocalYChange(Math.round(y * 100) / 100);
  }, [onFocalYChange]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    updateFocal(e.clientY);
  }, [updateFocal]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    updateFocal(e.clientY);
  }, [updateFocal]);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // Crop band: proportionally represents the browse card's 160px view height
  // relative to a ~400px wide card image (roughly 40% of image height)
  const bandHeight = 35; // percent of container
  const bandTop = Math.max(0, Math.min(100 - bandHeight, focalY * 100 - bandHeight / 2));

  return (
    <div style={{ marginTop: '12px' }}>
      <div style={{ fontSize: '12px', color: colors.muted, marginBottom: '6px' }}>
        Drag to set vertical crop center
      </div>
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          position: 'relative',
          borderRadius: '8px',
          overflow: 'hidden',
          cursor: 'ns-resize',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        {/* Full image (dimmed) */}
        <img
          src={imageSrc}
          alt="Crop preview"
          draggable={false}
          style={{
            width: '100%',
            display: 'block',
            opacity: 0.4,
          }}
        />
        {/* Visible crop band */}
        <div style={{
          position: 'absolute',
          top: `${bandTop}%`,
          left: 0,
          right: 0,
          height: `${bandHeight}%`,
          overflow: 'hidden',
          pointerEvents: 'none',
        }}>
          <img
            src={imageSrc}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              top: `-${bandTop / (100 - 0) * 100}%`,
              left: 0,
              width: '100%',
              // Position the full image so the band shows the correct slice
              marginTop: `${-bandTop}%`,
            }}
          />
        </div>
        {/* Center line */}
        <div style={{
          position: 'absolute',
          top: `${focalY * 100}%`,
          left: 0,
          right: 0,
          height: '2px',
          background: colors.accent,
          transform: 'translateY(-1px)',
          pointerEvents: 'none',
        }} />
        {/* Drag handle */}
        <div style={{
          position: 'absolute',
          top: `${focalY * 100}%`,
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '24px',
          height: '24px',
          borderRadius: '50%',
          background: colors.accent,
          border: '2px solid #fff',
          boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
          pointerEvents: 'none',
        }} />
        {/* Top/bottom dim overlays */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: `${bandTop}%`,
          background: 'rgba(0,0,0,0.45)',
          pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute',
          top: `${bandTop + bandHeight}%`,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.45)',
          pointerEvents: 'none',
        }} />
      </div>
    </div>
  );
}
