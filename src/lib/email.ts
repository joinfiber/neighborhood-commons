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
 * Send a transactional email via Resend with optional sender override.
 *
 * The `from` field accepts either a bare email or "Display Name <email>" form.
 * Used by the verification flow so each consumer app's verification email
 * comes from that app's brand_config sender identity (e.g. Holler) instead
 * of the Commons default. The per-app domain must be verified in the
 * shared Resend account.
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

  const from = opts.fromEmail
    ? opts.fromName
      ? `${opts.fromName} <${opts.fromEmail}>`
      : opts.fromEmail
    : config.email.from;

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
