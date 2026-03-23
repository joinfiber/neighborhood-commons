import { useState, useRef, useCallback } from 'react';
import { styles, colors } from '../lib/styles';
import { useBreakpoint } from '../hooks/useBreakpoint';

interface TooltipProps {
  id: string;
  content: string;
}

export function Tooltip({ id, content }: TooltipProps) {
  const { isDesktop } = useBreakpoint();
  const [open, setOpen] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    hideTimer.current = setTimeout(() => setOpen(false), 150);
  }, []);

  const toggle = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={isDesktop ? show : undefined}
      onMouseLeave={isDesktop ? hide : undefined}
    >
      <button
        type="button"
        className="tooltip-icon"
        style={styles.tooltipIcon}
        aria-label="More info"
        aria-expanded={open}
        onClick={isDesktop ? undefined : toggle}
        onFocus={isDesktop ? show : undefined}
        onBlur={isDesktop ? hide : undefined}
      >
        ?
      </button>

      {/* Desktop: popover anchored to the right of the icon */}
      {isDesktop && open && (
        <span
          id={id}
          role="tooltip"
          className="tooltip-popup"
          style={{
            ...styles.tooltipContent,
            left: 'calc(100% + 8px)',
            top: '50%',
            transform: 'translateY(-50%)',
            width: '220px',
            pointerEvents: 'none',
          }}
        >
          {content}
        </span>
      )}

      {/* Mobile: inline expansion below */}
      {!isDesktop && open && (
        <span
          id={id}
          role="tooltip"
          style={{
            display: 'block',
            padding: '6px 0 2px',
            fontSize: '12px',
            color: colors.muted,
            lineHeight: '1.5',
            fontWeight: 400,
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
}
