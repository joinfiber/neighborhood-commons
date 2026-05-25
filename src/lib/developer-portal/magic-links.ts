/**
 * Magic-link login for the developer portal.
 *
 * Distinct from `developer_otps` (which handles registration). The
 * registration OTP is a short numeric code the user types; this is a
 * single-use URL token clicked from email. Different UX, different
 * threat model, different table — magic_login_tokens.
 *
 * Token: 256-bit random hex, stored as SHA-256 hash in
 * `magic_login_tokens.token_hash`. Single-use (consumed_at set on
 * successful redemption). 15-minute expiry per docs/onboarding-redesign.md
 * §3.4.
 */

import { randomBytes, createHash } from 'crypto';
import { supabaseAdmin } from '../supabase.js';
import { sendEmail } from '../email.js';
import { config } from '../../config.js';

const TOKEN_TTL_MINUTES = 15;
const TOKEN_LENGTH_BYTES = 32;

function generateRawToken(): string {
  return randomBytes(TOKEN_LENGTH_BYTES).toString('hex');
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Issue a magic-link token for `email`. Stores the hash + email + expiry,
 * returns the raw token (which the caller embeds in the URL the user
 * clicks from email).
 *
 * Multiple outstanding tokens per email is allowed — a fresh request
 * (e.g. user clicked "resend") doesn't invalidate prior unconsumed
 * tokens; both are valid until expiry. Each is single-use independently.
 */
export async function issueMagicLink(email: string): Promise<string> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000).toISOString();

  const { error } = await supabaseAdmin
    .from('magic_login_tokens')
    .insert({
      email: email.toLowerCase(),
      token_hash: tokenHash,
      expires_at: expiresAt,
    });

  if (error) {
    console.error('[DEV_PORTAL] Magic-link issue failed:', error.message);
    throw new Error('Failed to issue magic link');
  }

  return rawToken;
}

/**
 * Validate + consume a magic-link token. Returns the associated email on
 * success, null on any failure (unknown token, expired, already consumed,
 * malformed). Marks the row consumed on success — the token cannot be
 * used twice.
 */
export async function consumeMagicLink(rawToken: string): Promise<string | null> {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length !== TOKEN_LENGTH_BYTES * 2) {
    return null;
  }

  const tokenHash = hashToken(rawToken);

  const { data: row } = await supabaseAdmin
    .from('magic_login_tokens')
    .select('id, email, expires_at, consumed_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (!row) return null;
  if (row.consumed_at) return null;
  if (new Date(row.expires_at as string) < new Date()) {
    await supabaseAdmin.from('magic_login_tokens').delete().eq('id', row.id);
    return null;
  }

  // Atomic single-use: only the request that flips consumed_at from NULL wins.
  // Two concurrent redemptions of the same token (a forwarded link, a link
  // prefetcher) would both pass the consumed_at check above; the conditional
  // update with RETURNING ensures exactly one gets a row back — the rest null.
  const { data: claimed } = await supabaseAdmin
    .from('magic_login_tokens')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('consumed_at', null)
    .select('email');

  if (!claimed || claimed.length === 0) return null;
  return (claimed[0]!.email as string) || null;
}

/**
 * Send the magic-link email. The token is appended to the verify URL;
 * clicking it lands on /developers/login/verify which consumes the
 * token and establishes a session.
 */
export async function sendMagicLinkEmail(email: string, rawToken: string): Promise<void> {
  const baseUrl = config.apiBaseUrl || 'https://neighborhood-commons.org';
  const link = `${baseUrl.replace(/\/$/, '')}/developers/login/verify?token=${encodeURIComponent(rawToken)}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <div style="font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: #7a7670; margin-bottom: 24px;">
        Neighborhood Commons
      </div>
      <div style="font-size: 16px; color: #37352f; line-height: 1.6; margin-bottom: 24px;">
        Click the link below to sign in to your developer dashboard:
      </div>
      <div style="margin-bottom: 24px;">
        <a href="${link}" style="display: inline-block; padding: 12px 20px; background: #2b4d2b; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
          Sign in to the dashboard
        </a>
      </div>
      <div style="font-size: 13px; color: #6b6660; line-height: 1.6; margin-bottom: 16px;">
        Or copy this URL into your browser:
      </div>
      <div style="font-family: monospace; font-size: 12px; color: #6b6660; word-break: break-all; padding: 10px 12px; background: #f1efea; border-radius: 4px; margin-bottom: 24px;">
        ${link}
      </div>
      <div style="font-size: 14px; color: #6b6660; line-height: 1.6;">
        This link expires in ${TOKEN_TTL_MINUTES} minutes and can be used once.
      </div>
      <div style="font-size: 13px; color: #9c9791; margin-top: 32px;">
        If you didn't request this, you can ignore this email. Your account stays as it was.
      </div>
    </div>
  `;
  await sendEmail(email, 'Sign in to your Neighborhood Commons dashboard', html);
}

export const MAGIC_LINK_TTL_MINUTES = TOKEN_TTL_MINUTES;
