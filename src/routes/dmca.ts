/**
 * DMCA — Neighborhood Commons
 *
 * Public endpoint exposing the designated DMCA agent. The Commons stores
 * facts AND, today, hosts some user-submitted content (event descriptions,
 * uploaded photos for claimed accounts). 17 U.S.C. § 512(c) safe-harbor
 * requires a designated agent registered with the U.S. Copyright Office
 * AND prominently posted.
 *
 * Two surfaces:
 *   GET /dmca          — human-readable HTML page
 *   GET /api/v1/dmca   — JSON for clients / SDK / automated discovery
 *
 * When the agent fields are unset in config (`registered: false`), both
 * surfaces report `status: 'pending_registration'` and direct users to
 * the operator email for interim takedown contact. The audit doc
 * (docs/legal-risk-audit.md) tracks the registration as a Phase 1
 * roadmap item.
 *
 * Filing a takedown via this surface should route to the agent's email.
 * The /api/v1/report endpoint provides a structured submission path that
 * notifies the operator + records an audit_log entry.
 */

import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';

const router: ReturnType<typeof Router> = Router();

interface DmcaInfo {
  status: 'registered' | 'pending_registration';
  agent: {
    name: string;
    email: string;
    phone: string;
    address: string;
  } | null;
  interim_contact_email: string;
  takedown_endpoint: string;
  counter_notice_endpoint: string | null;
  registry_url: string;
  notes: string;
}

function getInfo(): DmcaInfo {
  if (config.dmca.registered) {
    return {
      status: 'registered',
      agent: {
        name: config.dmca.agentName,
        email: config.dmca.agentEmail,
        phone: config.dmca.agentPhone,
        address: config.dmca.agentAddress,
      },
      interim_contact_email: config.operator.email || 'hi@neighborhood-commons.org',
      takedown_endpoint: '/api/v1/report',
      counter_notice_endpoint: null,
      registry_url: 'https://www.copyright.gov/dmca-directory/',
      notes: 'To file a DMCA takedown, send a written notice that satisfies 17 U.S.C. § 512(c)(3) to the designated agent above, or use the structured /api/v1/report endpoint.',
    };
  }

  return {
    status: 'pending_registration',
    agent: null,
    interim_contact_email: config.operator.email || 'hi@neighborhood-commons.org',
    takedown_endpoint: '/api/v1/report',
    counter_notice_endpoint: null,
    registry_url: 'https://www.copyright.gov/dmca-directory/',
    notes: 'DMCA designated agent registration is pending. For interim takedown requests, email the address above or POST to /api/v1/report. The Commons commits to acting on legitimate takedown notices regardless of registration status.',
  };
}

/** JSON endpoint at /api/v1/dmca */
router.get('/', (_req: Request, res: Response) => {
  res.json(getInfo());
});

export default router;

/**
 * Standalone HTML handler — mounted directly at /dmca by app.ts (not via
 * this router) so it lives at the apex of the site, not under /api/v1.
 */
export function dmcaHtmlHandler(_req: Request, res: Response): void {
  const info = getInfo();

  const agentBlock = info.agent
    ? `
      <h2>Designated agent</h2>
      <p>
        <strong>${escapeHtml(info.agent.name)}</strong><br/>
        Email: <a href="mailto:${escapeHtml(info.agent.email)}">${escapeHtml(info.agent.email)}</a><br/>
        Phone: ${escapeHtml(info.agent.phone)}<br/>
        Address: ${escapeHtml(info.agent.address).replace(/\n/g, '<br/>')}
      </p>
    `
    : `
      <h2>Status: registration pending</h2>
      <p>The DMCA designated-agent registration with the U.S. Copyright Office is in progress.</p>
      <p>For takedown requests in the meantime, please email
      <a href="mailto:${escapeHtml(info.interim_contact_email)}">${escapeHtml(info.interim_contact_email)}</a>
      or submit a structured report via <code>POST /api/v1/report</code>.</p>
      <p>We commit to acting on legitimate takedown notices regardless of registration status.</p>
    `;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>DMCA — Neighborhood Commons</title>
<link rel="stylesheet" href="/pages.css"/>
<style>
  body { max-width: 720px; margin: 2rem auto; padding: 0 1.25rem; line-height: 1.55; font-family: system-ui, -apple-system, sans-serif; color: #222; }
  h1 { margin-top: 0; }
  h2 { margin-top: 2rem; }
  code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.9em; }
  blockquote { border-left: 3px solid #ccc; padding-left: 1rem; margin-left: 0; color: #555; }
  a { color: #0a58ca; }
  .meta { color: #777; font-size: 0.9rem; }
</style>
</head>
<body>
<h1>DMCA notice and takedown</h1>
<p>The Neighborhood Commons is a thin data layer for neighborhood event facts. Some content (event descriptions, photos uploaded by claimed accounts) is user-submitted and may, despite our policies, include material that infringes copyright. This page describes how to file a takedown notice under 17 U.S.C. § 512(c).</p>

${agentBlock}

<h2>How to file a takedown</h2>
<p>Send a written notice that satisfies the requirements of 17 U.S.C. § 512(c)(3). At minimum:</p>
<ul>
  <li>Your physical or electronic signature.</li>
  <li>Identification of the copyrighted work claimed to be infringed.</li>
  <li>Identification of the allegedly infringing material and where it appears on the Commons (an event ID, organization ID, or URL).</li>
  <li>Your contact information (address, phone, email).</li>
  <li>A statement of good-faith belief that use of the material is not authorized.</li>
  <li>A statement, under penalty of perjury, that the information in the notice is accurate and that you are authorized to act on behalf of the rights-holder.</li>
</ul>

<h2>Programmatic submission</h2>
<p>For tooling, you may also submit a structured report via <code>POST /api/v1/report</code>. See the <a href="/api/v1/dmca">JSON variant of this page</a> or the <a href="/spec">OpenAPI spec</a> for the endpoint shape.</p>

<h2>Counter notices</h2>
<p>If you believe your content was removed in error, you may file a counter notice using the same contact channel. We will restore the content per § 512(g) if the counter notice meets the statutory requirements and the original complainant does not seek a court order within the statutory window.</p>

<h2>Repeat-infringer policy</h2>
<p>API keys associated with repeat infringement are subject to suspension or termination at the operator's discretion.</p>

<p class="meta">Last updated: ${new Date().toISOString().slice(0, 10)}.</p>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
