/**
 * Developer-portal sessions — DB-backed, revocable.
 *
 * The cookie carries a 256-bit random token; the database stores only the
 * SHA-256 hash in `developer_sessions.token_hash`. To validate, we hash the
 * cookie value and look it up — the raw token never leaves the client side
 * after issue. To revoke a session, delete the row; the next request fails
 * validation regardless of whether the cookie still exists client-side.
 *
 * Hard 24-hour expiry, no sliding window. Step-up (MFA-verified) state is
 * tracked separately via `mfa_verified_at` — set to now() when the
 * developer completes a fresh TOTP challenge, treated as "elevated" for
 * 15 minutes after that timestamp.
 *
 * Per docs/onboarding-redesign.md §3.3.
 */

import { randomBytes, createHash } from 'crypto';
import type { Request, Response } from 'express';
import { supabaseAdmin } from '../supabase.js';

const COOKIE_NAME = 'nc_dev_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MFA_ELEVATION_WINDOW_MS = 15 * 60 * 1000;

export interface DeveloperSession {
  id: string;
  api_key_id: string;
  mfa_verified_at: string | null;
  expires_at: string;
}

/** Generate a cryptographically random session token (256 bits, hex-encoded). */
function generateRawToken(): string {
  return randomBytes(32).toString('hex');
}

/** SHA-256 hash a session token for storage. */
function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Create a new session for an api_key. Inserts a `developer_sessions` row
 * and returns the raw token (the value to put in the cookie) plus the
 * expiry timestamp. The hash is what lives in the DB.
 */
export async function createSession(apiKeyId: string): Promise<{
  rawToken: string;
  expiresAt: Date;
}> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const { error } = await supabaseAdmin
    .from('developer_sessions')
    .insert({
      api_key_id: apiKeyId,
      token_hash: tokenHash,
      expires_at: expiresAt.toISOString(),
    });

  if (error) {
    console.error('[DEV_PORTAL] Session create failed:', error.message);
    throw new Error('Failed to create developer session');
  }

  return { rawToken, expiresAt };
}

/**
 * Look up a session by its raw token. Returns null if the token is unknown,
 * expired, or invalid in any way. Bumps `last_seen_at` on success.
 */
export async function validateSession(rawToken: string): Promise<DeveloperSession | null> {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length !== 64) {
    return null;
  }

  const tokenHash = hashToken(rawToken);

  const { data: session } = await supabaseAdmin
    .from('developer_sessions')
    .select('id, api_key_id, mfa_verified_at, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (!session) return null;
  if (new Date(session.expires_at as string) < new Date()) {
    // Expired — clean up and reject
    await supabaseAdmin.from('developer_sessions').delete().eq('id', session.id);
    return null;
  }

  // Fire-and-forget last_seen_at bump
  void supabaseAdmin
    .from('developer_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', session.id);

  return {
    id: session.id as string,
    api_key_id: session.api_key_id as string,
    mfa_verified_at: (session.mfa_verified_at as string | null) ?? null,
    expires_at: session.expires_at as string,
  };
}

/**
 * Whether the session has been MFA-verified within the elevation window.
 * Used by edit handlers to decide whether to allow the write or require
 * a fresh TOTP step-up.
 */
export function isSessionElevated(session: DeveloperSession): boolean {
  if (!session.mfa_verified_at) return false;
  const verifiedAt = new Date(session.mfa_verified_at).getTime();
  return Date.now() - verifiedAt <= MFA_ELEVATION_WINDOW_MS;
}

/** Delete a session row by its raw token. No-op if unknown. */
export async function destroySession(rawToken: string): Promise<void> {
  if (!rawToken) return;
  const tokenHash = hashToken(rawToken);
  await supabaseAdmin
    .from('developer_sessions')
    .delete()
    .eq('token_hash', tokenHash);
}

/**
 * Set the session cookie on a response. The cookie carries the raw token;
 * the value is HttpOnly to keep it out of JS, Secure in production, and
 * SameSite=Lax so it survives top-level navigations but not cross-site
 * embeds.
 */
export function setSessionCookie(res: Response, rawToken: string, expiresAt: Date): void {
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [
    `${COOKIE_NAME}=${rawToken}`,
    'HttpOnly',
    `Expires=${expiresAt.toUTCString()}`,
    'Path=/',
    'SameSite=Lax',
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** Clear the session cookie. */
export function clearSessionCookie(res: Response): void {
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Path=/',
    'SameSite=Lax',
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/**
 * Read the session token from the cookie header. Returns null if not
 * present or unparseable.
 */
export function getRawTokenFromRequest(req: Request): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME && rest.length > 0) {
      return rest.join('=');
    }
  }
  return null;
}
