import { useState, useEffect, useCallback } from 'react';

export interface Route {
  screen: string;
  params: Record<string, string>;
}

interface RoutePattern {
  pattern: RegExp;
  screen: string;
  paramNames: string[];
}

const routes: RoutePattern[] = [
  { pattern: /^#\/terms$/, screen: 'terms', paramNames: [] },
  { pattern: /^#\/developers$/, screen: 'developers', paramNames: [] },
  { pattern: /^#\/profile$/, screen: 'profile', paramNames: [] },
  { pattern: /^#\/events\/import$/, screen: 'import-events', paramNames: [] },
  { pattern: /^#\/events\/new$/, screen: 'create-event', paramNames: [] },
  { pattern: /^#\/events\/([^/]+)\/edit$/, screen: 'edit-event', paramNames: ['id'] },
  { pattern: /^#\/$/, screen: 'dashboard', paramNames: [] },
];

function parseHash(hash: string): Route {
  // Strip query string for pattern matching, but parse it for params
  const [path, query] = hash.split('?');
  if (!path) return { screen: 'dashboard', params: {} };

  for (const route of routes) {
    const match = path.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1]!;
      });
      // Parse query params (e.g., ?account=abc)
      if (query) {
        const searchParams = new URLSearchParams(query);
        searchParams.forEach((value, key) => {
          params[key] = value;
        });
      }
      return { screen: route.screen, params };
    }
  }

  // Default: dashboard
  return { screen: 'dashboard', params: {} };
}

export function useHashRoute(): {
  route: Route;
  navigate: (hash: string) => void;
  back: () => void;
} {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash || '#/'));

  useEffect(() => {
    const handler = () => {
      setRoute(parseHash(window.location.hash || '#/'));
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash;
  }, []);

  const back = useCallback(() => {
    history.back();
  }, []);

  return { route, navigate, back };
}
