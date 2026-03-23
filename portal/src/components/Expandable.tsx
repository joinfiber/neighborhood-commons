import { useRef, useEffect, useState } from 'react';

interface ExpandableProps {
  open: boolean;
  children: React.ReactNode;
}

/**
 * Animates content expand/collapse using measured height.
 * Content is always in the DOM (for measurement), clipped when collapsed.
 * Open: transitions max-height from 0 to measured height, then removes max-height.
 * Close: sets max-height to current height, then transitions to 0.
 */
export function Expandable({ open, children }: ExpandableProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>(open ? 'auto' : 0);
  const [overflow, setOverflow] = useState<'hidden' | 'visible'>(open ? 'visible' : 'hidden');
  const prevOpen = useRef(open);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    if (open && !prevOpen.current) {
      // Opening: measure, set to 0, then animate to measured height
      const measured = el.scrollHeight;
      setOverflow('hidden');
      setHeight(0);
      // Force reflow so the browser registers the 0 state
      void el.offsetHeight;
      setHeight(measured);
      // After transition, remove max-height constraint so content can reflow
      const timer = setTimeout(() => {
        setHeight('auto');
        setOverflow('visible');
      }, 200); // matches --motion-open
      return () => clearTimeout(timer);
    }

    if (!open && prevOpen.current) {
      // Closing: set to current height, then animate to 0
      const measured = el.scrollHeight;
      setOverflow('hidden');
      setHeight(measured);
      void el.offsetHeight;
      setHeight(0);
    }

    prevOpen.current = open;
  }, [open]);

  return (
    <div
      ref={contentRef}
      style={{
        maxHeight: height === 'auto' ? undefined : `${height}px`,
        overflow,
        opacity: height === 0 ? 0 : 1,
        transition: height === 0
          ? 'max-height 120ms linear, opacity 120ms linear'
          : 'max-height 200ms ease-out, opacity 200ms ease-out',
      }}
    >
      {children}
    </div>
  );
}
