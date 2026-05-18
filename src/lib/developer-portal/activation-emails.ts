/**
 * Activation + rejection emails for the developer portal.
 *
 * Sent by the operator-review route when an application is approved or
 * rejected. Tone: human, direct, no marketing. The activation email is
 * useful (here's your dashboard, here's how to write your first event);
 * the rejection email is respectful and leaves a clear path back if the
 * applicant wants to discuss.
 *
 * Both go through `sendEmail` (Resend). Failures are surfaced to the
 * caller — the operator-review handler decides how to surface them.
 */

import { sendEmail } from '../email.js';
import { config } from '../../config.js';

interface ActivationEmailArgs {
  email: string;
  appName: string;
  profileSlug: string;
}

interface RejectionEmailArgs {
  email: string;
  appName: string;
  /** Operator's free-text reason. Optional — if absent, the email contains a
   *  generic "we can't activate this right now" and points at the contact. */
  reason: string | null;
}

const PORTAL_HELP_EMAIL = 'hi@neighborhood-commons.org';

function baseUrl(): string {
  return (config.apiBaseUrl || 'https://neighborhood-commons.org').replace(/\/$/, '');
}

/** Escape user-supplied content (app name, reason) for safe HTML body interpolation. */
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Send the activation email. Triggered when the operator approves an
 * application. The dashboard link is the launching point — the dev's
 * service key already exists; they grab it from the dashboard.
 */
export async function sendActivationEmail(args: ActivationEmailArgs): Promise<void> {
  const dashboardUrl = `${baseUrl()}/developers/dashboard`;
  const quickstartUrl = `${baseUrl()}/docs/quickstart`;
  const profileUrl = `${baseUrl()}/v1/contributors/${encodeURIComponent(args.profileSlug)}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px; color: #37352f; line-height: 1.6;">
      <div style="font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: #7a7670; margin-bottom: 24px;">
        Neighborhood Commons
      </div>
      <div style="font-size: 18px; color: #1a1917; font-weight: 600; margin-bottom: 16px;">
        ${escapeHtml(args.appName)} is approved.
      </div>
      <p style="margin: 0 0 16px;">
        Your service key is live. You can start writing events, organizations, places,
        and broadcasts via the Service API.
      </p>
      <p style="margin: 0 0 24px;">
        Your public contributor profile is live too — readers attribution-tap on
        events you contribute and see your card. You can edit it any time from the
        dashboard.
      </p>
      <div style="margin: 0 0 24px;">
        <a href="${dashboardUrl}" style="display: inline-block; padding: 12px 20px; background: #2b4d2b; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
          Open dashboard
        </a>
      </div>
      <p style="margin: 0 0 8px; font-size: 14px;">A few jumping-off points:</p>
      <ul style="margin: 0 0 24px 18px; padding: 0; font-size: 14px; color: #37352f;">
        <li style="margin-bottom: 6px;"><a href="${quickstartUrl}" style="color: #2b4d2b;">Quickstart guide</a> — write your first event end-to-end.</li>
        <li style="margin-bottom: 6px;">Your contributor profile: <a href="${profileUrl}" style="color: #2b4d2b;">${profileUrl}</a></li>
        <li>Reply to this email if you hit anything weird — we read every one.</li>
      </ul>
      <p style="font-size: 13px; color: #6b6660; margin: 32px 0 0;">
        Welcome aboard. The Commons is better off with ${escapeHtml(args.appName)} in it.
      </p>
    </div>
  `;
  await sendEmail(args.email, `${args.appName} is live on the Commons`, html);
}

/**
 * Send the rejection email. Triggered when the operator rejects an
 * application. Includes the operator's reason if one was provided.
 * Always invites a reply — most rejections are recoverable through a
 * short back-and-forth.
 */
export async function sendRejectionEmail(args: RejectionEmailArgs): Promise<void> {
  const reasonBlock = args.reason
    ? `
      <div style="margin: 0 0 24px; padding: 14px 16px; background: #faf9f7; border: 1px solid #e8e5e0; border-radius: 6px; font-size: 14px;">
        <div style="font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #7a7670; margin-bottom: 6px;">Note from the operator</div>
        <div style="white-space: pre-wrap; color: #37352f;">${escapeHtml(args.reason)}</div>
      </div>
    `
    : '';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px; color: #37352f; line-height: 1.6;">
      <div style="font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: #7a7670; margin-bottom: 24px;">
        Neighborhood Commons
      </div>
      <div style="font-size: 18px; color: #1a1917; font-weight: 600; margin-bottom: 16px;">
        We can't activate ${escapeHtml(args.appName)} right now.
      </div>
      <p style="margin: 0 0 16px;">
        Thank you for applying. We reviewed your registration and weren't able to
        approve it as submitted.
      </p>
      ${reasonBlock}
      <p style="margin: 0 0 16px;">
        This isn't a permanent no. Most of the time a short reply with a bit more
        context — what you're collecting, how publishers in your flow have
        authority over their content — is enough to get unstuck. Reply directly
        to this email or write to
        <a href="mailto:${PORTAL_HELP_EMAIL}" style="color: #2b4d2b;">${PORTAL_HELP_EMAIL}</a>.
      </p>
      <p style="font-size: 13px; color: #6b6660; margin: 32px 0 0;">
        The bar is on substance, not polish — happy to talk it through.
      </p>
    </div>
  `;
  await sendEmail(args.email, `About your ${args.appName} registration`, html);
}
