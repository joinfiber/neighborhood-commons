import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'error-callback'?: (errorCode?: string) => void;
          'expired-callback'?: () => void;
          theme?: 'light' | 'dark' | 'auto';
        }
      ) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

interface TurnstileProps {
  onVerify: (token: string) => void;
  onError?: () => void;
  onExpire?: () => void;
}

export function Turnstile({ onVerify, onError, onExpire }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Use refs for callbacks to avoid re-running the effect on every render
  const callbacksRef = useRef({ onVerify, onError, onExpire });
  callbacksRef.current = { onVerify, onError, onExpire };

  useEffect(() => {
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
    if (!siteKey) return;

    let cancelled = false;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let pollTimeout: ReturnType<typeof setTimeout> | null = null;

    const renderWidget = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return;

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (token: string) => callbacksRef.current.onVerify(token),
        'error-callback': () => callbacksRef.current.onError?.(),
        'expired-callback': () => callbacksRef.current.onExpire?.(),
        theme: 'dark',
      });
    };

    if (window.turnstile) {
      renderWidget();
    } else {
      pollInterval = setInterval(() => {
        if (window.turnstile) {
          if (pollInterval) clearInterval(pollInterval);
          renderWidget();
        }
      }, 100);

      pollTimeout = setTimeout(() => {
        if (pollInterval) clearInterval(pollInterval);
      }, 10000);
    }

    return () => {
      cancelled = true;
      if (pollInterval) clearInterval(pollInterval);
      if (pollTimeout) clearTimeout(pollTimeout);
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current); } catch { /* already removed */ }
        widgetIdRef.current = null;
      }
    };
  }, []); // mount once — callbacks accessed via ref

  return <div ref={containerRef} />;
}
