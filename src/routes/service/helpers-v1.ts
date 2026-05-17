/**
 * Service API helpers (1.0.0+) — organization-scoped access checks
 *
 * Service-tier API keys can only modify data for organizations they're
 * explicitly linked to via `api_key_organization_links`. Admin keys
 * (is_admin=true) bypass the link check for platform-wide operations.
 *
 * Companion to the legacy `helpers.ts` (account-scoped). Both coexist
 * during the transition while consumer apps migrate.
 */

import type { Request } from 'express';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';

/**
 * Assert that the calling service key is linked to the target organization.
 * Admin keys (is_admin=true) bypass this check.
 *
 * Throws 403 NOT_LINKED if the key isn't authorized for this org.
 */
export async function assertLinkedOrganization(
  req: Request,
  organizationId: string,
): Promise<void> {
  if (req.apiKeyInfo?.isAdmin) return;

  const { data } = await supabaseAdmin
    .from('api_key_organization_links')
    .select('organization_id')
    .eq('api_key_id', req.apiKeyInfo!.id)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (!data) {
    throw createError(
      'This API key is not linked to the target organization. Use POST /service/organizations/link first.',
      403,
      'NOT_LINKED',
    );
  }
}

/**
 * Assert that the calling service key is linked to the organization that
 * curates a given list. Admin keys bypass.
 *
 * v2 (migration 082): lists are always curated by an organization
 * (curator_org_id NOT NULL). The Person primitive is gone.
 */
export async function assertLinkedListCurator(
  req: Request,
  listId: string,
): Promise<void> {
  if (req.apiKeyInfo?.isAdmin) return;

  const { data: list } = await supabaseAdmin
    .from('lists')
    .select('curator_org_id')
    .eq('id', listId)
    .maybeSingle();

  if (!list) throw createError('List not found', 404, 'NOT_FOUND');
  if (!list.curator_org_id) {
    throw createError('List has no curator organization', 403, 'NO_OWNER');
  }

  await assertLinkedOrganization(req, list.curator_org_id as string);
}
