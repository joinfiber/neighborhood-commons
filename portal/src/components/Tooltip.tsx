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
  const iconRef = useRef<HTMLButtonElement>(null);

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

  // Desktop: positioned popover to the right of the icon
  const renderDesktopPopover = () => {
    if (!open || !iconRef.current) return null;
    const rect = iconRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const spaceRight = viewportWidth - rect.right;
    const placeLeft = spaceRight < 240;

    const popoverStyle: React.CSSProperties = {
      ...styles.tooltipContent,
      position: 'fixed',
      top: rect.top + rect.height / 2,
      transform: 'translateY(-50%)',
      ...(placeLeft
        ? { right: viewportWidth - rect.left + 8 }
        : { left: rect.right + 8 }),
    };

    return (
      <div id={id} role="tooltip" className="tooltip-popup" style={popoverStyle}>
        {content}
      </div>
    );
  };

  // Mobile: inline expansion below the label
  const renderMobileExpansion = () => {
    if (!open) return null;
    return (
      <div
        id={id}
        role="tooltip"
        style={{
          padding: '6px 0',
          fontSize: '12px',
          color: colors.muted,
          lineHeight: '1.5',
        }}
      >
        {content}
      </div>
    );
  };

  return (
    <>
      <button
        ref={iconRef}
        type="button"
        className="tooltip-icon"
        style={styles.tooltipIcon}
        aria-label="More info"
        aria-expanded={open}
        onClick={isDesktop ? undefined : toggle}
        onMouseEnter={isDesktop ? show : undefined}
        onMouseLeave={isDesktop ? hide : undefined}
        onFocus={isDesktop ? show : undefined}
        onBlur={isDesktop ? hide : undefined}
      >
        i
      </button>
      {isDesktop && renderDesktopPopover()}
      {!isDesktop && renderMobileExpansion()}
    </>
  );
}
