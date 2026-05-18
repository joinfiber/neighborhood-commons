/**
 * Service API — Scoped-access helpers
 *
 * Service-tier API keys can only modify data for organizations they're
 * explicitly linked to via `api_key_organization_links`. Admin keys
 * (is_admin=true) bypass the link check for platform-wide operations.
 *
 * Scope is anchored on organizations (constrained-publishing model).
 * Operational scope on `portal_accounts` traverses
 * `organizations.owner_account_id`.
 *
 * Read endpoints don't call these — public data is readable by any key.
 */

import type { Request } from 'express';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { assertLinkedOrganization } from './helpers-v1.js';

/**
 * Assert that the calling service key is linked to *some* organization
 * owned by the target portal account. Admin keys bypass.
 *
 * Used by the operational `/accounts/:id` PATCH/DELETE handlers — the
 * portal_account itself is the operational shell; authority flows through
 * the organizations it owns.
 *
 * Throws 403 NOT_LINKED when no owned organization is linked to the key.
 */
export async function assertLinkedAccount(req: Request, accountId: string): Promise<void> {
  if (req.apiKeyInfo?.isAdmin) return;

  const { data: orgs } = await supabaseAdmin
    .from('organizations')
    .select('id')
    .eq('owner_account_id', accountId);

  const orgIds = (orgs || []).map((o) => o.id as string);
  if (orgIds.length === 0) {
    throw createError(
      'Target account has no owning organization linked to this key.',
      403,
      'NOT_LINKED',
    );
  }

  const { data } = await supabaseAdmin
    .from('api_key_organization_links')
    .select('organization_id')
    .eq('api_key_id', req.apiKeyInfo!.id)
    .in('organization_id', orgIds)
    .maybeSingle();

  if (!data) {
    throw createError(
      'This API key is not linked to any organization owning the target account.',
      403,
      'NOT_LINKED',
    );
  }
}

/**
 * Assert that the calling service key is linked to the organization that
 * organizes a given event. Returns the organizer_org_id on success.
 *
 * Scope check is on `events.organizer_org_id`. The witnessed-evidence
 * authority path (source_method='witnessed' + api_keys.witness_authority)
 * bypasses the link check.
 */
export async function assertLinkedEvent(req: Request, eventId: string): Promise<string> {
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('organizer_org_id, source_method')
    .eq('id', eventId)
    .maybeSingle();

  if (!event) throw createError('Event not found', 404, 'NOT_FOUND');
  if (!event.organizer_org_id) {
    // Post-migration 081 every event has an organizer; this branch is
    // defensive for the brief pre-082 window.
    throw createError('Event has no organizer; admin access required', 403, 'NO_OWNER');
  }

  // Witnessed events with witness-authority keys bypass org-link scope.
  if (
    event.source_method === 'witnessed'
    && req.apiKeyInfo?.witnessAuthority
  ) {
    return event.organizer_org_id as string;
  }

  await assertLinkedOrganization(req, event.organizer_org_id as string);
  return event.organizer_org_id as string;
}
