/**
 * Service-tier Broadcasts API — Neighborhood Commons 1.0.0
 *
 * Endpoints:
 *   POST  /service/broadcasts            — create (max 24h expiry)
 *   POST  /service/broadcasts/:id/retract — flip status to 'retracted'
 *
 * Verification gate: broadcast creation does NOT require the org to be
 * verified. Verification is a consumer-app filter on visibility, not a
 * Commons-side write check. Apps editorialize.
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest, validateUuidParam } from '../../lib/helpers.js';
import { formatPlace } from '../v1-places.js';
import { formatOrganization } from '../v1-organizations.js';
import { hydrateVerificationsFor } from '../../lib/verification-hydrate.js';
import { assertLinkedOrganization } from './helpers-v1.js';

const router: ReturnType<typeof Router> = Router();

const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

const broadcastInputSchema = z.object({
  organizationId: z.string().uuid(),
  placeId: z.string().uuid(),
  message: z.string().min(1).max(280),
  expires: z.string().datetime(),
});

const BROADCAST_SELECT = `
  id, organization_id, place_id, message, expires_at, status, retracted_at, source, method, created_at,
  organizations!broadcasts_organization_id_fkey(
    id, slug, name, legal_name, tags, commercial, description, url, logo_url, image_url,
    telephone, email, same_as, keywords, opening_hours_specification,
    primary_place_id, owner_account_id, method, created_at, updated_at
  ),
  places!broadcasts_place_id_fkey(
    id, google_place_id, name,
    street_address, address_locality, address_region, postal_code, address_country,
    latitude, longitude, region_id, created_at, updated_at
  )
`;

async function formatBroadcastWithExtras(row: Record<string, unknown>) {
  const orgRow = row.organizations as Record<string, unknown> | null;
  const placeRow = row.places as Record<string, unknown> | null;

  const verifications = orgRow
    ? await hydrateVerificationsFor([orgRow.id as string])
    : new Map();

  return {
    id: row.id,
    message: row.message,
    datePosted: row.created_at,
    expires: row.expires_at,
    status: row.status,
    organization: orgRow ? formatOrganization(orgRow, new Map(), verifications) : null,
    location: placeRow ? formatPlace(placeRow) : null,
    source: row.source,
  };
}

// ---------------------------------------------------------------------------
// POST /service/broadcasts
// ---------------------------------------------------------------------------

router.post('/broadcasts', async (req, res, next) => {
  try {
    const body = validateRequest(broadcastInputSchema, req.body);

    const expiresMs = Date.parse(body.expires);
    const now = Date.now();
    if (isNaN(expiresMs)) {
      throw createError('expires must be ISO 8601', 400, 'VALIDATION_ERROR');
    }
    if (expiresMs <= now) {
      throw createError('expires must be in the future', 400, 'VALIDATION_ERROR');
    }
    if (expiresMs - now > MAX_LIFETIME_MS) {
      throw createError('Broadcast lifetime cannot exceed 24h', 400, 'VALIDATION_ERROR');
    }

    await assertLinkedOrganization(req, body.organizationId);

    // Verify place exists (FK would catch this but error message is clearer).
    const { data: place } = await supabaseAdmin
      .from('places')
      .select('id')
      .eq('id', body.placeId)
      .maybeSingle();
    if (!place) throw createError('Place not found', 404, 'NOT_FOUND');

    const source = {
      publisher: req.apiKeyInfo?.brandConfig?.app_name || 'unknown',
      method: 'service',
      contributor: req.apiKeyInfo?.brandConfig?.app_name || null,
      collected_at: new Date().toISOString(),
      license: 'CC BY 4.0',
    };

    const { data: created, error } = await supabaseAdmin
      .from('broadcasts')
      .insert({
        organization_id: body.organizationId,
        place_id: body.placeId,
        message: body.message,
        expires_at: body.expires,
        source,
      })
      .select(BROADCAST_SELECT)
      .single();

    if (error || !created) {
      console.error('[SERVICE:BROADCASTS] Insert error:', error?.message);
      throw createError('Failed to create broadcast', 500, 'SERVER_ERROR');
    }

    const formatted = await formatBroadcastWithExtras(created as unknown as Record<string, unknown>);
    res.status(201).json({ broadcast: formatted });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /service/broadcasts/:id/retract
// ---------------------------------------------------------------------------

router.post('/broadcasts/:id/retract', async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');

    const { data: existing } = await supabaseAdmin
      .from('broadcasts')
      .select('id, organization_id, status')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!existing) throw createError('Broadcast not found', 404, 'NOT_FOUND');

    await assertLinkedOrganization(req, existing.organization_id as string);

    if (existing.status !== 'active') {
      // Idempotent: already retracted or expired. Return current state.
      const { data: current } = await supabaseAdmin
        .from('broadcasts')
        .select(BROADCAST_SELECT)
        .eq('id', req.params.id)
        .maybeSingle();
      if (current) {
        const formatted = await formatBroadcastWithExtras(current as unknown as Record<string, unknown>);
        res.json({ broadcast: formatted });
        return;
      }
    }

    const { error } = await supabaseAdmin
      .from('broadcasts')
      .update({ status: 'retracted', retracted_at: new Date().toISOString() })
      .eq('id', req.params.id);

    if (error) {
      console.error('[SERVICE:BROADCASTS] Retract error:', error.message);
      throw createError('Failed to retract broadcast', 500, 'SERVER_ERROR');
    }

    const { data: updated } = await supabaseAdmin
      .from('broadcasts')
      .select(BROADCAST_SELECT)
      .eq('id', req.params.id)
      .single();

    const formatted = await formatBroadcastWithExtras(updated as unknown as Record<string, unknown>);
    res.json({ broadcast: formatted });
  } catch (err) {
    next(err);
  }
});

export default router;
