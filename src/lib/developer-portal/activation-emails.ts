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
  /**
   * Set when the operator approved this app via the witnessing path —
   * a collective Organization was provisioned and the api_key now has
   * witness_authority. The email surfaces the collective's UUID and a
   * concrete usage example so the developer doesn't have to dig.
   */
  collectiveOrg?: {
    id: string;
    name: string;
    slug: string;
  };
}

interface RejectionEmailArgs {
  email: string;
  appName: string;
  /** Operator's free-text reason. Optional — if absent, the email contains a
   *  generic "we can't activate this right now" and points at the contact. */
  reason: string | null;
}

interface WitnessingEnabledEmailArgs {
  email: string;
  appName: string;
  collectiveOrg: { id: string; name: string; slug: string } | null;
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

  // When the operator approved as a witnessing app, surface the collective
  // Organization's UUID + a usage example so the developer doesn't have to
  // dig in the docs to wire their writes correctly.
  const witnessingBlock = args.collectiveOrg
    ? `
      <div style="margin: 0 0 24px; padding: 16px 18px; background: #eaf2ea; border-radius: 6px; font-size: 14px;">
        <div style="font-weight: 600; color: #1a1917; margin-bottom: 6px;">Witnessing collective is set up</div>
        <p style="margin: 0 0 12px;">
          Your app was approved as a witnessing publisher. A collective Organization,
          <strong>${escapeHtml(args.collectiveOrg.name)}</strong>, was provisioned for you
          and your service key is linked to it. Use this UUID as the <code>organizer_org_id</code>
          on witnessed events you submit:
        </p>
        <div style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; padding: 10px 12px; background: #fff; border: 1px solid #e8e5e0; border-radius: 4px; word-break: break-all; margin-bottom: 12px;">
          ${escapeHtml(args.collectiveOrg.id)}
        </div>
        <p style="margin: 0 0 6px; font-size: 13px; color: #37352f;">Example event payload:</p>
        <pre style="margin: 0; padding: 10px 12px; background: #fff; border: 1px solid #e8e5e0; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-x: auto; line-height: 1.5;">{
  "name": "Poetry night",
  "start": "2026-06-12T19:00:00-04:00",
  "place_id": "ChIJ...",
  "organizer_org_id": "${escapeHtml(args.collectiveOrg.id)}",
  "source": { "method": "witnessed" }
}</pre>
        <p style="margin: 12px 0 0; font-size: 13px; color: #6b6660;">
          Slug: <code>${escapeHtml(args.collectiveOrg.slug)}</code> · The collective is editable from your dashboard.
        </p>
      </div>
    `
    : '';

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
      ${witnessingBlock}
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

/**
 * Notify the developer that witnessing capability has been granted on
 * their key (after they requested it from the dashboard). Includes the
 * collective Organization UUID + a usage example — the same payload
 * shape the standard activation email includes.
 */
export async function sendWitnessingEnabledEmail(args: WitnessingEnabledEmailArgs): Promise<void> {
  const dashboardUrl = `${baseUrl()}/developers/dashboard`;
  const collective = args.collectiveOrg;

  const usageBlock = collective
    ? `
      <p style="margin: 0 0 12px;">
        Your collective Organization, <strong>${escapeHtml(collective.name)}</strong>, is what you'll set as
        <code>organizer_org_id</code> on witnessed events. The UUID:
      </p>
      <div style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; padding: 10px 12px; background: #f1efea; border: 1px solid #e8e5e0; border-radius: 4px; word-break: break-all; margin-bottom: 12px;">
        ${escapeHtml(collective.id)}
      </div>
      <p style="margin: 0 0 6px; font-size: 13px; color: #37352f;">Example event payload:</p>
      <pre style="margin: 0; padding: 10px 12px; background: #f1efea; border: 1px solid #e8e5e0; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-x: auto; line-height: 1.5;">{
  "name": "Poetry night",
  "start": "2026-06-12T19:00:00-04:00",
  "place_id": "ChIJ...",
  "organizer_org_id": "${escapeHtml(collective.id)}",
  "source": { "method": "witnessed" }
}</pre>
    `
    : `
      <p style="margin: 0 0 12px; color: #6b6660;">
        Your key now has witness_authority. (We couldn't auto-resolve your collective Organization for this email — visit the dashboard to see it.)
      </p>
    `;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px; color: #37352f; line-height: 1.6;">
      <div style="font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: #7a7670; margin-bottom: 24px;">
        Neighborhood Commons
      </div>
      <div style="font-size: 18px; color: #1a1917; font-weight: 600; margin-bottom: 16px;">
        Witnessing is enabled for ${escapeHtml(args.appName)}.
      </div>
      <p style="margin: 0 0 16px;">
        Your request for the witness_authority capability has been approved. You can now write events with
        <code>source_method = "witnessed"</code> attributed to your collective.
      </p>
      ${usageBlock}
      <div style="margin: 24px 0;">
        <a href="${dashboardUrl}" style="display: inline-block; padding: 12px 20px; background: #2b4d2b; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
          Open dashboard
        </a>
      </div>
      <p style="font-size: 13px; color: #6b6660; margin: 32px 0 0;">
        The doctrine: witnessed events attribute to your collective (never to individual users). The flyer / photo / OCR is the documentary evidence. Reply with questions any time.
      </p>
    </div>
  `;
  await sendEmail(args.email, `Witnessing enabled for ${args.appName}`, html);
}
