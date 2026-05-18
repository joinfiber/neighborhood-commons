/**
 * CSRF protection for the developer-portal HTML forms.
 *
 * Pattern: double-submit cookie. On every GET that renders a form, the
 * server sets an `nc_dev_csrf` cookie with a random token and embeds the
 * same value as a hidden field in the form. On POST, the server compares
 * the cookie value to the submitted field; if they don't match, reject
 * with 403.
 *
 * Why double-submit and not a session-bound token: registration and
 * verify happen BEFORE the developer has a session. We need CSRF
 * protection without server-side state. Combined with SameSite=Lax on
 * the cookie, this is sufficient for the threat model — a cross-site
 * attacker can't read the cookie value (HttpOnly) and can't predict it
 * (256 bits of entropy), so they can't construct a matching form
 * submission.
 *
 * Once the developer has a session (post-verify), edit handlers should
 * additionally check the session is elevated (MFA step-up). CSRF stays
 * as a baseline.
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';

const COOKIE_NAME = 'nc_dev_csrf';
const FORM_FIELD = '_csrf';
const TOKEN_LENGTH_BYTES = 32; // 256 bits

/** Generate a fresh random CSRF token (hex-encoded). */
export function generateCsrfToken(): string {
  return randomBytes(TOKEN_LENGTH_BYTES).toString('hex');
}

/**
 * Issue a CSRF cookie on the response and return the token. Call this
 * from any GET that renders a form; embed the returned value as a hidden
 * field via the templates helper.
 */
export function issueCsrfCookie(res: Response): string {
  const token = generateCsrfToken();
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    // 1-hour expiry — form-fill flow should be done well within that
    `Max-Age=3600`,
  ];
  if (isProd) parts.push('Secure');

  // Use append so we don't trample any other Set-Cookie (e.g. session cookie)
  const existing = res.getHeader('Set-Cookie');
  if (existing) {
    const arr = Array.isArray(existing) ? existing : [String(existing)];
    res.setHeader('Set-Cookie', [...arr, parts.join('; ')]);
  } else {
    res.setHeader('Set-Cookie', parts.join('; '));
  }
  return token;
}

/** Read the CSRF cookie value from a request. Returns null if absent. */
export function getCsrfCookie(req: Request): string | null {
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

/**
 * Validate a POST request's CSRF protection. Compares the `_csrf` form
 * field to the `nc_dev_csrf` cookie. Returns true only if both exist,
 * have the expected length, and match via timing-safe comparison.
 */
export function validateCsrf(req: Request): boolean {
  const cookieToken = getCsrfCookie(req);
  const submittedToken = (req.body && typeof req.body === 'object' && req.body[FORM_FIELD]) as
    | string
    | undefined;

  if (!cookieToken || !submittedToken) return false;
  if (typeof submittedToken !== 'string') return false;
  if (cookieToken.length !== submittedToken.length) return false;
  if (cookieToken.length !== TOKEN_LENGTH_BYTES * 2) return false; // hex length

  try {
    return timingSafeEqual(Buffer.from(cookieToken), Buffer.from(submittedToken));
  } catch {
    return false;
  }
}

/** The form field name to use when embedding the token in HTML forms. */
export const CSRF_FIELD_NAME = FORM_FIELD;
