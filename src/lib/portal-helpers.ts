/**
 * Portal Request Helpers — Neighborhood Commons
 *
 * Request-context helpers for portal routes: admin detection, impersonation,
 * RLS client selection, account lookup, and creation rate limiting.
 *
 * These are NOT route handlers — they support the portal auth/impersonation
 * model and are shared across all portal route sub-modules. Future user types
 * (curators, event apps) may use similar patterns with different auth logic.
 */

import { supabaseAdmin } from './supabase.js';
import { config } from '../config.js';
import { createError } from '../middleware/error-handler.js';
import { validateUuidParam } from './helpers.js';
import { auditPortalAction } from './audit.js';

/**
 * Check if the authenticated user is a portal admin (by user ID).
 * Commons uses COMMONS_ADMIN_USER_IDS instead of email-based detection.
 */
export function isPortalAdmin(req: import('express').Request): boolean {
  const userId = req.user?.id;
  return !!userId && config.admin.userIds.includes(userId);
}

/**
 * Check if this request is an admin impersonation ("act as" mode).
 * Returns the target account ID if valid, null otherwise.
 */
export function getActAsAccountId(req: import('express').Request): string | null {
  const actAs = req.headers['x-act-as-account'] as string | undefined;
  if (!actAs) return null;
  if (!isPortalAdmin(req)) {
    throw createError('Forbidden', 403, 'FORBIDDEN');
  }
  validateUuidParam(actAs, 'act-as account ID');

  // Audit trail: record which admin is impersonating which account.
  // Without this, impersonated actions are unattributable.
  auditPortalAction(
    'admin_impersonation',
    req.user!.id,
    actAs,
    { endpoint: req.method + ' ' + req.originalUrl },
  );

  return actAs;
}

/**
 * Get the user-context Supabase client from the request.
 * Set by requirePortalAuth middleware. Throws if missing.
 * When admin is impersonating, returns supabaseAdmin (bypasses RLS)
 * since the admin's JWT doesn't own the target account's rows.
 */
export function getUserClient(req: import('express').Request) {
  if (getActAsAccountId(req)) {
    return supabaseAdmin;
  }
  if (!req.supabaseClient) {
    throw createError('Authentication required', 401, 'UNAUTHORIZED');
  }
  return req.supabaseClient;
}

/**
 * Look up the portal account for the current request.
 * Handles admin impersonation: looks up by account ID instead of auth_user_id.
 */
export async function getPortalAccount(req: import('express').Request): Promise<{ id: string; status: string }> {
  // Admin impersonation: look up by account ID (not auth_user_id)
  const actAs = getActAsAccountId(req);
  if (actAs) {
    const { data } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, status')
      .eq('id', actAs)
      .in('status', ['active', 'pending'])
      .maybeSingle();

    if (!data) throw createError('Target account not found', 404, 'NOT_FOUND');
    return data;
  }

  const userId = req.user?.id;
  if (!userId) throw createError('Authentication required', 401, 'UNAUTHORIZED');

  const { data } = await supabaseAdmin
    .from('portal_accounts')
    .select('id, status')
    .eq('auth_user_id', userId)
    .in('status', ['active', 'pending'])
    .maybeSingle();

  if (!data) throw createError('No portal account found', 404, 'NOT_FOUND');
  return data;
}

/** Backward-compat wrapper — returns just the account ID */
export async function getPortalAccountId(req: import('express').Request): Promise<string> {
  const account = await getPortalAccount(req);
  return account.id;
}

/**
 * Get the effective audit actor for the current request.
 * During admin impersonation, the real admin user ID is the actor — not the
 * impersonated account. This ensures the audit trail is attributable to the
 * human who actually performed the action.
 */
export function getAuditActor(req: import('express').Request, accountId: string): {
  actor: string;
  impersonationMeta?: Record<string, string>;
} {
  const actAs = req.headers['x-act-as-account'] as string | undefined;
  if (actAs && req.user?.id) {
    return {
      actor: req.user.id,
      impersonationMeta: { impersonating_account: accountId },
    };
  }
  return { actor: accountId };
}

/**
 * Check if a portal account has exceeded event creation rate limits.
 * Counts creation actions (not individual instances — a series = 1 action).
 * Throws 429 if exceeded.
 */
export async function checkPortalCreationRateLimit(accountId: string): Promise<void> {
  const CREATION_LIMITS = { hourly: 20, daily: 40 };
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Count creation actions in past hour
  // series_instance_number IS NULL = single event, = 1 = first in series
  const { count: hourlyCount } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('creator_account_id', accountId)
    .eq('source', 'portal')
    .gte('created_at', oneHourAgo)
    .or('series_instance_number.is.null,series_instance_number.eq.1');

  if ((hourlyCount || 0) >= CREATION_LIMITS.hourly) {
    auditPortalAction('portal_creation_rate_limited', accountId, accountId,
      { window: 'hourly', count: hourlyCount || 0 }, '/api/portal/events');
    throw createError(
      `Creation limit reached (${CREATION_LIMITS.hourly}/hour). Try again later.`,
      429, 'RATE_LIMIT',
    );
  }

  // Count creation actions in past 24 hours
  const { count: dailyCount } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('creator_account_id', accountId)
    .eq('source', 'portal')
    .gte('created_at', oneDayAgo)
    .or('series_instance_number.is.null,series_instance_number.eq.1');

  if ((dailyCount || 0) >= CREATION_LIMITS.daily) {
    auditPortalAction('portal_creation_rate_limited', accountId, accountId,
      { window: 'daily', count: dailyCount || 0 }, '/api/portal/events');
    throw createError(
      `Creation limit reached (${CREATION_LIMITS.daily}/day). Try again later.`,
      429, 'RATE_LIMIT',
    );
  }
}
