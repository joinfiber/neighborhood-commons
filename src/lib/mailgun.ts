/**
 * Mailgun Client — Neighborhood Commons
 *
 * Sends transactional emails via Mailgun API.
 * Simplified from the social API — only the core sendEmail function.
 */

import { config } from '../config.js';

const MAILGUN_API_BASE = 'https://api.mailgun.net/v3';

/**
 * Send a transactional email via Mailgun.
 *
 * @param to - Recipient email address
 * @param subject - Email subject line
 * @param html - HTML body content
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!config.mailgun.apiKey || !config.mailgun.domain) {
    console.warn('[MAILGUN] Not configured, skipping email send');
    return;
  }

  const form = new URLSearchParams();
  form.append('from', config.mailgun.from);
  form.append('to', to);
  form.append('subject', subject);
  form.append('html', html);

  const response = await fetch(
    `${MAILGUN_API_BASE}/${config.mailgun.domain}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${config.mailgun.apiKey}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Mailgun error: ${response.status} - ${error}`);
  }
}
