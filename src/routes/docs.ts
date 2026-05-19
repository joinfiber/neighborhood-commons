/**
 * Public docs surface — server-rendered markdown.
 *
 * Routes /docs/:slug to the matching file in /docs/{slug}.md, rendered
 * via `marked` and wrapped in a minimal shell. Allowlist-gated — only
 * the docs we mean to expose publicly are servable. Internal docs
 * (onboarding-redesign.md, launch-runbook.md) stay private to the repo.
 *
 * Markdown source files are trusted (authored in-repo, reviewed via PR).
 * Marked's default options are fine — no sanitization needed for own
 * content. If we ever accept user-authored markdown, route it through
 * DOMPurify (or a parallel route that flips marked's policies).
 */

import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import { marked } from 'marked';
import rateLimit from 'express-rate-limit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(__dirname, '../../docs');

/**
 * Public docs allowlist. Adding to this list is the conscious act of
 * publishing a doc — internal-only files (onboarding plans, runbooks,
 * launch ops) stay off the list and 404 if anyone tries to reach them.
 *
 * Title is the short human label shown in the header + <title>.
 */
const PUBLIC_DOCS: Record<string, { title: string }> = {
  'four-roles': { title: 'The four roles of event provenance' },
  'provenance': { title: 'Provenance methods' },
  'stability-promise': { title: 'The Commons stability promise' },
  'quickstart': { title: 'Quickstart' },
  'consumer-guide': { title: 'Consumer guide' },
};

const router: ReturnType<typeof Router> = Router();

const docsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
});

const DOCS_STYLES = `
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
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:hover { text-decoration-thickness: 2px; }
  .nc-doc-wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 96px; }
  .nc-doc-eyebrow {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 12px;
  }
  .nc-doc-prose h1 {
    font-family: var(--font-sans);
    font-size: 28px;
    font-weight: 600;
    line-height: 1.2;
    color: var(--ink);
    margin: 0 0 20px;
  }
  .nc-doc-prose h2 {
    font-size: 20px;
    font-weight: 600;
    color: var(--ink);
    margin: 32px 0 12px;
  }
  .nc-doc-prose h3 {
    font-size: 16px;
    font-weight: 600;
    color: var(--ink);
    margin: 24px 0 8px;
  }
  .nc-doc-prose p { margin: 0 0 16px; }
  .nc-doc-prose ul, .nc-doc-prose ol { margin: 0 0 16px 20px; padding: 0; }
  .nc-doc-prose li { margin-bottom: 6px; }
  .nc-doc-prose code {
    font-family: var(--font-mono);
    font-size: 13px;
    background: #f1efea;
    padding: 1px 5px;
    border-radius: 3px;
  }
  .nc-doc-prose pre {
    background: #f1efea;
    padding: 14px 16px;
    border-radius: var(--radius);
    overflow-x: auto;
    margin: 0 0 16px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
  }
  .nc-doc-prose pre code {
    background: none;
    padding: 0;
    font-size: 13px;
  }
  .nc-doc-prose blockquote {
    border-left: 3px solid var(--border-strong);
    padding-left: 14px;
    margin: 16px 0;
    color: var(--ink-2);
  }
  .nc-doc-prose table {
    border-collapse: collapse;
    width: 100%;
    margin: 16px 0;
    font-size: 14px;
  }
  .nc-doc-prose th, .nc-doc-prose td {
    border: 1px solid var(--border);
    padding: 8px 12px;
    text-align: left;
    vertical-align: top;
  }
  .nc-doc-prose th { background: var(--surface); font-weight: 600; }
  .nc-doc-prose hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
  .nc-doc-prose strong { color: var(--ink); }
  .nc-doc-footer {
    margin-top: 56px;
    font-size: 13px;
    color: var(--muted-2);
    border-top: 1px solid var(--border);
    padding-top: 18px;
  }
`;

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function renderShell(args: { title: string; bodyHtml: string; slug: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtmlAttr(args.title)} — Neighborhood Commons</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>${DOCS_STYLES}</style>
</head>
<body>
  <main class="nc-doc-wrap">
    <div class="nc-doc-eyebrow">Neighborhood Commons · Docs</div>
    <article class="nc-doc-prose">${args.bodyHtml}</article>
    <footer class="nc-doc-footer">
      Source: <a href="https://github.com/joinfiber/neighborhood-commons/blob/master/docs/${escapeHtmlAttr(args.slug)}.md">docs/${escapeHtmlAttr(args.slug)}.md</a>
      · <a href="/">Home</a>
      · <a href="/spec">Spec</a>
      · <a href="/llms.txt">Guide</a>
    </footer>
  </main>
</body>
</html>`;
}

router.get('/:slug', docsLimiter, async (req, res, next) => {
  try {
    const slug = typeof req.params.slug === 'string' ? req.params.slug : '';
    // Strip a trailing .md if anyone hits the file extension version of the URL
    const normalizedSlug = slug.replace(/\.md$/, '');

    const docMeta = PUBLIC_DOCS[normalizedSlug];
    if (!docMeta) {
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderShell({
        title: 'Not found',
        slug: normalizedSlug,
        bodyHtml: `<h1>That doc isn't published.</h1>
          <p>The docs we publish at the moment:</p>
          <ul>${Object.entries(PUBLIC_DOCS)
            .map(([s, m]) => `<li><a href="/docs/${escapeHtmlAttr(s)}">${escapeHtmlAttr(m.title)}</a></li>`)
            .join('')}
          </ul>
          <p>If you came here from a link in the portal or an email and expected a doc to exist, let us know at <a href="mailto:hi@neighborhood-commons.org">hi@neighborhood-commons.org</a>.</p>`,
      }));
      return;
    }

    // Path-traversal guard. The allowlist already constrains the slug,
    // but belt-and-suspenders: resolve the final path and confirm it
    // sits inside DOCS_DIR.
    const filePath = path.resolve(DOCS_DIR, `${normalizedSlug}.md`);
    if (!filePath.startsWith(DOCS_DIR + path.sep) && filePath !== DOCS_DIR) {
      res.status(404).send('Not found.');
      return;
    }

    let markdown: string;
    try {
      markdown = await readFile(filePath, 'utf8');
    } catch (err) {
      console.error('[DOCS] Read failed for slug', normalizedSlug, err instanceof Error ? err.message : err);
      res.status(404).send('Not found.');
      return;
    }

    const bodyHtml = marked.parse(markdown, {
      // Trusted source — own docs, no user input. Default async=false.
      async: false,
    }) as string;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(renderShell({ title: docMeta.title, slug: normalizedSlug, bodyHtml }));
  } catch (err) {
    next(err);
  }
});

router.get('/', docsLimiter, (_req, res) => {
  const items = Object.entries(PUBLIC_DOCS)
    .map(([s, m]) => `<li><a href="/docs/${escapeHtmlAttr(s)}">${escapeHtmlAttr(m.title)}</a></li>`)
    .join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(renderShell({
    title: 'Docs',
    slug: '',
    bodyHtml: `<h1>Docs.</h1>
      <p>Reference material for developers building on the Commons. The Spec (machine-readable) and Guide (narrative) are the load-bearing surfaces; these are the design rationale + how-tos that sit alongside.</p>
      <ul>${items}</ul>`,
  }));
});

export default router;
