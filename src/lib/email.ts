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
  if (!config.email.apiKey) {
    console.warn('[EMAIL] Not configured, skipping email send');
    return;
  }

  const response = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.email.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.email.from,
      to,
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Resend error: ${response.status} - ${error}`);
  }
}
