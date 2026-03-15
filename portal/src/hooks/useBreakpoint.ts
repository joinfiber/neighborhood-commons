import { useState, useEffect } from 'react';

interface Breakpoint {
  isMobile: boolean;   // < 600px
  isTablet: boolean;   // 600–900px
  isDesktop: boolean;  // > 900px
}

export function useBreakpoint(): Breakpoint {
  const [width, setWidth] = useState(window.innerWidth);

  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return {
    isMobile: width < 600,
    isTablet: width >= 600 && width <= 900,
    isDesktop: width > 900,
  };
}
