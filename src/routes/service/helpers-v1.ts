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
 */
export async function assertLinkedListCurator(
  req: Request,
  listId: string,
): Promise<void> {
  if (req.apiKeyInfo?.isAdmin) return;

  const { data: list } = await supabaseAdmin
    .from('lists')
    .select('curator_org_id, curator_person_id')
    .eq('id', listId)
    .maybeSingle();

  if (!list) throw createError('List not found', 404, 'NOT_FOUND');

  // Person-curated lists: scoping is by Person.owner_account_id linked to a key
  // (an indirect path). For now, only org-curated lists are scope-checked here;
  // person-curated list editing falls to admin until a clean owner-link path lands.
  if (list.curator_org_id) {
    await assertLinkedOrganization(req, list.curator_org_id as string);
    return;
  }

  // Person-curated list: only admin can edit until person-link semantics ship.
  throw createError(
    'Person-curated lists can only be edited by admin keys in 1.0.0.',
    403,
    'INSUFFICIENT_TIER',
  );
}
