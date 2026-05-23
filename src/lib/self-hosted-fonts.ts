/**
 * Self-hosted font faces for server-rendered HTML surfaces (developer
 * portal, operator portal, public docs).
 *
 * These pages used to pull DM Sans / DM Mono from Google Fonts via a <link>
 * in <head> — a third-party request to fonts.googleapis.com on every
 * pageview (privacy ping + FOUT on first paint + extra DNS). The homepage
 * (public/index.html) already self-hosts the same faces from /fonts/*.woff2;
 * this mirrors that setup so every Commons-served surface loads fonts from
 * our own origin.
 *
 * The helmet CSP in src/app.ts depends on this: because no Commons-served
 * page references Google Fonts anymore, fonts.googleapis.com / fonts.gstatic.com
 * are dropped from style-src / font-src. Re-introducing a Google Fonts <link>
 * on any of these surfaces would break under that CSP — self-host instead.
 *
 * Weights mirror what the surfaces actually use (and what the old Google
 * request fetched): DM Sans 400/500/600, DM Mono 400/500. DM Serif Display
 * is homepage-only and intentionally omitted here.
 *
 * Cross-origin note: the widget (public/widget/events.js) embeds on
 * third-party pages, so it can't use these root-relative URLs and isn't
 * governed by this CSP — it's handled separately.
 */

/**
 * Preload of the body font, for the document <head> ahead of the <style>.
 * Only DM Sans is preloaded — it's the largest visible text surface, so a
 * late swap would be most jarring there. DM Mono arrives over the same
 * HTTP/2 connection under font-display: swap.
 */
export const FONT_PRELOAD_HTML =
  '<link rel="preload" href="/fonts/dm-sans-latin.woff2" as="font" type="font/woff2" crossorigin>';

/**
 * @font-face declarations. Prepend to each surface's existing <style> body so
 * the faces are defined before the rules that reference them. DM Sans maps
 * three weights onto one variable woff2 (the same trick the homepage uses);
 * DM Mono ships as two discrete weight files.
 */
export const FONT_FACE_CSS = `
  @font-face { font-family: 'DM Sans'; font-style: normal; font-weight: 400; font-display: swap; src: url('/fonts/dm-sans-latin.woff2') format('woff2'); }
  @font-face { font-family: 'DM Sans'; font-style: normal; font-weight: 500; font-display: swap; src: url('/fonts/dm-sans-latin.woff2') format('woff2'); }
  @font-face { font-family: 'DM Sans'; font-style: normal; font-weight: 600; font-display: swap; src: url('/fonts/dm-sans-latin.woff2') format('woff2'); }
  @font-face { font-family: 'DM Mono'; font-style: normal; font-weight: 400; font-display: swap; src: url('/fonts/dm-mono-400-latin.woff2') format('woff2'); }
  @font-face { font-family: 'DM Mono'; font-style: normal; font-weight: 500; font-display: swap; src: url('/fonts/dm-mono-500-latin.woff2') format('woff2'); }
`;
