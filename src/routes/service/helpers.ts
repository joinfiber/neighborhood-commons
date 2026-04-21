/**
 * Service API — Scoped-access helpers
 *
 * Service-tier API keys can only modify data for portal accounts they're
 * explicitly linked to via `api_key_account_links`. Admin keys
 * (is_admin=true) bypass the link check for platform-wide operations.
 *
 * Read endpoints don't call these — public data is readable by any key.
 */

import type { Request } from 'express';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';

/**
 * Assert that the calling service key is linked to the target portal account.
 * Admin keys bypass this check — they have full access.
 */
export async function assertLinkedAccount(req: Request, accountId: string): Promise<void> {
  if (req.apiKeyInfo?.isAdmin) return;

  const { data } = await supabaseAdmin
    .from('api_key_account_links')
    .select('portal_account_id')
    .eq('api_key_id', req.apiKeyInfo!.id)
    .eq('portal_account_id', accountId)
    .maybeSingle();

  if (!data) {
    throw createError(
      'This API key is not linked to the target account. Use POST /accounts/link first.',
      403,
      'NOT_LINKED',
    );
  }
}

/**
 * Assert that the calling service key is linked to the account that owns
 * the given event. Returns the account ID on success.
 */
export async function assertLinkedEvent(req: Request, eventId: string): Promise<string> {
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('creator_account_id')
    .eq('id', eventId)
    .maybeSingle();

  if (!event) throw createError('Event not found', 404, 'NOT_FOUND');
  if (!event.creator_account_id) throw createError('Event has no owner account', 400, 'NO_OWNER');

  await assertLinkedAccount(req, event.creator_account_id);
  return event.creator_account_id;
}
