/**
 * HTML rendering for the developer portal.
 *
 * Server-rendered, no JavaScript required. Templates are inline string
 * literals — matches the pattern in `src/routes/pages.ts` (event detail
 * pages). The portal feels distinct from the homepage but uses the same
 * typography and tone.
 *
 * Every dynamic interpolation runs through `escapeHtml` or `escapeAttr`.
 * Anything that's marked-up content (description-as-markdown, etc.) is
 * out of scope for PR 2 — registration form values are plain text or
 * URLs. URL fields are constrained at the validation layer.
 */

import { FONT_PRELOAD_HTML, FONT_FACE_CSS } from '../self-hosted-fonts.js';

/** Escape user-supplied content for safe HTML body interpolation. */
export function escapeHtml(text: string | null | undefined): string {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Same escape rules as HTML body — aliased for attribute-context clarity. */
export function escapeAttr(text: string | null | undefined): string {
  return escapeHtml(text);
}

const SHARED_STYLES = `
  :root {
    --bg: #faf9f7;
    --surface: #fff;
    --ink: #1a1917;
    --ink-2: #37352f;
    --muted: #7a7670;
    --muted-2: #9c9791;
    --border: #e8e5e0;
    --border-strong: #c8c4be;
    --accent: #2b4d2b;
    --accent-soft: #eaf2ea;
    --danger: #8b2c2c;
    --danger-soft: #f4e8e8;
    --radius: 6px;
    --font-sans: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --font-mono: 'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--ink-2);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:hover { text-decoration-thickness: 2px; }
  .nc-portal-wrap { max-width: 640px; margin: 0 auto; padding: 56px 24px 96px; }
  .nc-portal-eyebrow {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 16px;
  }
  h1 {
    font-family: var(--font-sans);
    font-size: 28px;
    font-weight: 600;
    line-height: 1.2;
    color: var(--ink);
    margin: 0 0 16px;
  }
  h2 {
    font-size: 18px;
    font-weight: 600;
    color: var(--ink);
    margin: 32px 0 12px;
  }
  .nc-portal-lede { font-size: 16px; color: var(--ink-2); margin: 0 0 32px; }
  form { margin: 0; }
  .nc-field { margin: 0 0 20px; }
  .nc-field label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-2);
    margin-bottom: 6px;
  }
  .nc-field .nc-field-hint {
    display: block;
    font-size: 12px;
    color: var(--muted);
    margin-top: 4px;
  }
  .nc-field input[type="text"],
  .nc-field input[type="email"],
  .nc-field input[type="url"],
  .nc-field textarea {
    width: 100%;
    padding: 10px 12px;
    font: inherit;
    font-size: 14px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    outline: none;
  }
  .nc-field textarea { resize: vertical; min-height: 96px; }
  .nc-field input:focus,
  .nc-field textarea:focus { border-color: var(--accent); }
  .nc-required { color: var(--accent); font-weight: 500; margin-left: 2px; }
  .nc-btn {
    display: inline-block;
    padding: 10px 18px;
    font: inherit;
    font-size: 14px;
    font-weight: 500;
    color: #fff;
    background: var(--accent);
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    text-decoration: none;
  }
  .nc-btn:hover { background: #1f3a1f; }
  .nc-btn--secondary {
    color: var(--ink-2);
    background: transparent;
    border: 1px solid var(--border-strong);
  }
  .nc-btn--secondary:hover { background: var(--surface); }
  .nc-error {
    padding: 12px 14px;
    background: var(--danger-soft);
    color: var(--danger);
    border-radius: var(--radius);
    font-size: 14px;
    margin-bottom: 24px;
  }
  .nc-callout {
    padding: 14px 16px;
    background: var(--accent-soft);
    color: var(--ink-2);
    border-radius: var(--radius);
    font-size: 14px;
    margin: 0 0 24px;
  }
  .nc-callout a { color: inherit; text-decoration: underline; }
  .nc-explainer {
    margin: 0 0 28px;
    padding: 10px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 14px;
  }
  .nc-explainer > summary {
    cursor: pointer;
    padding: 6px 0;
    font-weight: 500;
    color: var(--ink-2);
    list-style: none;
  }
  .nc-explainer > summary::-webkit-details-marker { display: none; }
  .nc-explainer > summary::before {
    content: "▸ ";
    font-family: var(--font-mono);
    color: var(--muted);
    margin-right: 4px;
  }
  .nc-explainer[open] > summary::before { content: "▾ "; }
  .nc-explainer p { margin: 12px 0; line-height: 1.6; }
  .nc-explainer ul { margin: 8px 0 12px 18px; padding: 0; line-height: 1.7; }
  .nc-explainer li { margin-bottom: 6px; }
  .nc-explainer li strong { color: var(--ink); }
  .nc-card {
    padding: 20px 22px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin: 0 0 20px;
  }
  .nc-card .nc-card-label {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .nc-key {
    font-family: var(--font-mono);
    font-size: 13px;
    word-break: break-all;
    color: var(--ink);
    background: #f1efea;
    padding: 10px 12px;
    border-radius: var(--radius);
    user-select: all;
  }
  .nc-meta { display: flex; flex-wrap: wrap; gap: 12px 24px; font-size: 13px; color: var(--muted); margin: 0 0 4px; }
  .nc-status {
    display: inline-block;
    padding: 2px 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-radius: 3px;
  }
  .nc-status--pending { background: #f7efe1; color: #8c6a1e; }
  .nc-status--active { background: var(--accent-soft); color: var(--accent); }
  .nc-status--suspended { background: var(--danger-soft); color: var(--danger); }
  .nc-portal-footer { margin-top: 56px; font-size: 13px; color: var(--muted-2); border-top: 1px solid var(--border); padding-top: 24px; }
`;

/** Render the page shell with shared chrome and styles. */
export function portalShell(args: { title: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(args.title)} — Neighborhood Commons Developers</title>
  <meta name="robots" content="noindex,nofollow">
  ${FONT_PRELOAD_HTML}
  <style>${FONT_FACE_CSS}${SHARED_STYLES}</style>
</head>
<body>
  <main class="nc-portal-wrap">
    <div class="nc-portal-eyebrow">Neighborhood Commons · Developers</div>
    ${args.body}
    <footer class="nc-portal-footer">
      Need help? Email <a href="mailto:hi@neighborhood-commons.org">hi@neighborhood-commons.org</a>.
      ·
      <a href="/llms.txt">Spec guide</a>
      ·
      <a href="/spec">API reference</a>
    </footer>
  </main>
</body>
</html>`;
}

/** Render an error banner. Pass null to render nothing. */
export function errorBanner(message: string | null): string {
  if (!message) return '';
  return `<div class="nc-error" role="alert">${escapeHtml(message)}</div>`;
}

/** Render a "you're good" callout. */
export function calloutBanner(message: string): string {
  return `<div class="nc-callout">${escapeHtml(message)}</div>`;
}

/** Render a hidden input — typically for CSRF tokens. */
export function hiddenInput(name: string, value: string): string {
  return `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">`;
}
