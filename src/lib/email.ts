/**
 * Email Client — Neighborhood Commons
 *
 * Sends transactional emails via Resend API.
 * https://resend.com/docs/api-reference/emails/send-email
 */

import { config } from '../config.js';

const RESEND_API = 'https://api.resend.com/emails';

/**
 * Send a transactional email via Resend.
 *
 * @param to - Recipient email address
 * @param subject - Email subject line
 * @param html - HTML body content
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  await sendEmailWithSender({ to, subject, html });
}

/**
 * Extract the bare email portion from a Resend "from" string. Accepts both
 * "Display Name <email@host>" and bare "email@host" forms, returns the email
 * portion. Used for free-tier brand_config: we honor the app's display name
 * but reuse the Commons-verified domain for the actual From address.
 */
function extractEmail(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1] : fromHeader.trim();
}

/**
 * Send a transactional email via Resend with optional sender override.
 *
 * Three valid configurations:
 *   1. Full brand: { fromEmail, fromName } → "Name <email@app-domain>"
 *      Requires the app's domain verified in Resend (paid tier).
 *   2. Display-only brand: { fromName } → "Name <email@commons-domain>"
 *      Free-tier friendly. App's display name + Commons-verified domain.
 *   3. Default: neither → uses config.email.from as-is.
 */
export async function sendEmailWithSender(opts: {
  to: string;
  subject: string;
  html: string;
  fromEmail?: string;
  fromName?: string;
}): Promise<void> {
  if (!config.email.apiKey) {
    console.warn('[EMAIL] Not configured, skipping email send');
    return;
  }

  let from: string;
  if (opts.fromEmail) {
    // Full brand: app supplied its own domain. Prefer fromName as display.
    from = opts.fromName ? `${opts.fromName} <${opts.fromEmail}>` : opts.fromEmail;
  } else if (opts.fromName) {
    // Display-only: app supplied a display name but no domain. Use the
    // Commons-verified domain (extracted from config) with the app's name.
    const commonsEmail = extractEmail(config.email.from);
    from = `${opts.fromName} <${commonsEmail}>`;
  } else {
    // No overrides: use the Commons default identity.
    from = config.email.from;
  }

  const response = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.email.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Resend error: ${response.status} - ${error}`);
  }
}
