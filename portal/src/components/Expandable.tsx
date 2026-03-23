import { useRef, useEffect, useState } from 'react';

interface ExpandableProps {
  open: boolean;
  children: React.ReactNode;
}

/**
 * Animates content expand/collapse using measured height.
 * Content is always in the DOM (for measurement), clipped when collapsed.
 * Open: transitions max-height from 0 → measured (200ms ease-out).
 * Close: transitions max-height from measured → 0 (120ms linear).
 */
export function Expandable({ open, children }: ExpandableProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<string>(open ? 'none' : '0px');
  const [overflow, setOverflow] = useState<'hidden' | 'visible'>(open ? 'visible' : 'hidden');
  const [opacity, setOpacity] = useState(open ? 1 : 0);
  const isOpen = useRef(open);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    if (open && !isOpen.current) {
      // Opening
      isOpen.current = true;
      setOverflow('hidden');
      setMaxHeight('0px');
      setOpacity(0);

      // Frame 1: browser paints at 0px
      requestAnimationFrame(() => {
        const h = el.scrollHeight;
        setMaxHeight(`${h}px`);
        setOpacity(1);

        // After transition, free the height so content can reflow
        const timer = setTimeout(() => {
          setMaxHeight('none');
          setOverflow('visible');
        }, 220);
        // Store cleanup
        el.dataset.timer = String(timer);
      });
    }

    if (!open && isOpen.current) {
      // Closing
      isOpen.current = false;

      // Clear any pending open timer
      if (el.dataset.timer) {
        clearTimeout(Number(el.dataset.timer));
        delete el.dataset.timer;
      }

      // Capture current height
      const h = el.scrollHeight;
      setOverflow('hidden');
      setMaxHeight(`${h}px`);
      setOpacity(1);

      // Frame 1: browser paints at current height
      requestAnimationFrame(() => {
        // Frame 2: now transition to 0
        requestAnimationFrame(() => {
          setMaxHeight('0px');
          setOpacity(0);
        });
      });
    }
  }, [open]);

  const closing = maxHeight === '0px' && !open;

  return (
    <div
      ref={contentRef}
      style={{
        maxHeight: maxHeight === 'none' ? undefined : maxHeight,
        overflow,
        opacity,
        transition: closing
          ? 'max-height 120ms linear, opacity 100ms linear'
          : 'max-height 200ms ease-out, opacity 150ms ease-out',
      }}
    >
      {children}
    </div>
  );
}
