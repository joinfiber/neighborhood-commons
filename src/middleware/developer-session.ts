/**
 * Developer-session middleware.
 *
 * Reads the session cookie, validates against `developer_sessions`,
 * attaches the resolved session to `req.developerSession` for downstream
 * handlers.
 *
 * Two variants:
 *
 *   - optionalDeveloperSession — attaches the session if present; passes
 *     through otherwise. Use on shared chrome / public-ish pages that
 *     adapt to login state.
 *
 *   - requireDeveloperSession — redirects to /developers/login (or
 *     /developers/sign-up if we can't tell which) when no valid session.
 *     Use on the dashboard and any post-registration page.
 */

import type { Request, Response, NextFunction } from 'express';
import { getRawTokenFromRequest, validateSession, type DeveloperSession } from '../lib/developer-portal/sessions.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { config } from '../config.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      developerSession?: DeveloperSession;
      operatorEmail?: string;
    }
  }
}

/** Attach the developer session to req if present and valid. Never blocks. */
export async function optionalDeveloperSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const rawToken = getRawTokenFromRequest(req);
  if (!rawToken) {
    next();
    return;
  }
  try {
    const session = await validateSession(rawToken);
    if (session) req.developerSession = session;
  } catch {
    // Validation failure is non-fatal — just pass through unauthenticated.
  }
  next();
}

/**
 * Require an active developer session. Redirects to the sign-up page if
 * no valid session is present. (Future PR 3 will introduce a magic-link
 * /developers/login page; until then, sign-up is the only entry.)
 */
export async function requireDeveloperSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const rawToken = getRawTokenFromRequest(req);
  if (!rawToken) {
    res.redirect(302, '/developers/sign-up');
    return;
  }
  try {
    const session = await validateSession(rawToken);
    if (!session) {
      res.redirect(302, '/developers/sign-up');
      return;
    }
    req.developerSession = session;
    next();
  } catch (err) {
    console.error('[DEV_PORTAL] Session validation error:', err instanceof Error ? err.message : err);
    res.redirect(302, '/developers/sign-up');
  }
}

/**
 * Operator gate. Requires a valid developer session AND that the session's
 * api_key contact_email matches one of the addresses in COMMONS_OPERATOR_EMAIL.
 *
 * Returns 404 (not 403) on any miss — unauthenticated, wrong-email, no
 * operator list configured — so the route's existence isn't leaked to
 * anyone who shouldn't have access. Attaches `req.operatorEmail` on success
 * for downstream handlers / audit records.
 *
 * Operator status is not stored in the DB in PR 4a; it's purely env-var
 * driven. Adding a DB-backed `is_operator` flag later is additive and
 * doesn't require changing this contract.
 */
export async function requireOperator(req: Request, res: Response, next: NextFunction): Promise<void> {
  const allowlist = config.operator.emails;
  if (allowlist.length === 0) {
    res.status(404).send('Not Found');
    return;
  }

  const rawToken = getRawTokenFromRequest(req);
  if (!rawToken) {
    res.status(404).send('Not Found');
    return;
  }

  try {
    const session = await validateSession(rawToken);
    if (!session) {
      res.status(404).send('Not Found');
      return;
    }

    const { data: keyRow } = await supabaseAdmin
      .from('api_keys')
      .select('contact_email')
      .eq('id', session.api_key_id)
      .maybeSingle();

    const email = (keyRow?.contact_email as string | undefined)?.toLowerCase() || '';
    if (!email || !allowlist.includes(email)) {
      res.status(404).send('Not Found');
      return;
    }

    req.developerSession = session;
    req.operatorEmail = email;
    next();
  } catch (err) {
    console.error('[OPERATOR] Gate check failed:', err instanceof Error ? err.message : err);
    res.status(404).send('Not Found');
  }
}
