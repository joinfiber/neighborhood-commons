/**
 * Public Publishers API — Neighborhood Commons v2
 *
 * Read-only API for organizations that publish into the Commons —
 * specifically, organizations that have at least one event or broadcast
 * attributed to them. A focused slice of /v1/organizations for consumer
 * apps that want to discover active publishers (e.g., to render a "venues
 * with upcoming events" feed).
 *
 * v2 replaces the legacy /v1/accounts route which conflated publisher
 * identity (a public-facts concept) with user accounts (an operational,
 * PII-bearing concept). Publishers are organizations; user accounts live
 * in the operational layer and are never exposed via the public API.
 *
 * Response shape is identical to /v1/organizations; the difference is the
 * "has published" filter applied at the query layer.
 *
 * No authentication required. Optional API key for dedicated rate limit.
 *
 * Base: /api/v1/publishers
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, sanitizeSearchInput } from '../lib/helpers.js';
import { optionalApiKey } from '../middleware/api-key.js';
import { hydrateVerificationsFor, resolveVerificationIdFilter } from '../lib/verification-hydrate.js';
import {
  ORG_SELECT,
  PLACE_SELECT_INLINE,
  orgListSchema,
  formatOrganization,
  buildMeta,
} from './v1-organizations.js';

const router: ReturnType<typeof Router> = Router();
router.use(optionalApiKey);

export const publishersLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.apiKeyInfo?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded (1000/hr).' } },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Build a set of organization ids that have published at least one event
 * or broadcast. The query is two separate IN-membership checks against
 * events.organizer_org_id and broadcasts.organization_id, then unioned.
 *
 * For performance at scale, this should become a materialized view or a
 * separate publishers table. At current scale, two GROUP BY queries are
 * fast enough.
 */
async function getPublisherOrgIds(): Promise<Set<string>> {
  const ids = new Set<string>();

  // Orgs with at least one event
  const { data: eventOrgs } = await supabaseAdmin
    .from('events')
    .select('organizer_org_id')
    .eq('status', 'published')
    .not('organizer_org_id', 'is', null);
  for (const row of eventOrgs || []) {
    const id = (row as { organizer_org_id: string }).organizer_org_id;
    if (id) ids.add(id);
  }

  // Orgs with at least one active broadcast
  const { data: broadcastOrgs } = await supabaseAdmin
    .from('broadcasts')
    .select('organization_id')
    .eq('status', 'active');
  for (const row of broadcastOrgs || []) {
    const id = (row as { organization_id: string }).organization_id;
    if (id) ids.add(id);
  }

  return ids;
}

// ---------------------------------------------------------------------------
// GET /api/v1/publishers
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(orgListSchema, req.query);
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    // Pre-resolve verification filters (same shape as /v1/organizations).
    const verifFilter = await resolveVerificationIdFilter({
      verified: params.verified,
      verified_by: params.verified_by,
      not_verified_by: params.not_verified_by,
    });
    if ('empty' in verifFilter && verifFilter.empty) {
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ meta: buildMeta(0, limit, offset), publishers: [] });
      return;
    }

    // The publisher constraint: org must have at least one event or broadcast.
    const publisherIds = await getPublisherOrgIds();
    if (publisherIds.size === 0) {
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ meta: buildMeta(0, limit, offset), publishers: [] });
      return;
    }

    let query = supabaseAdmin
      .from('organizations')
      .select(ORG_SELECT, { count: 'exact' })
      .in('id', Array.from(publisherIds))
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if ('includeIds' in verifFilter) query = query.in('id', verifFilter.includeIds);
    if ('excludeIds' in verifFilter) {
      query = query.not('id', 'in', `(${verifFilter.excludeIds.join(',')})`);
    }

    // Tag, commercial, place_category filters — same as /v1/organizations.
    if (params.tag) {
      const tags = Array.isArray(params.tag) ? params.tag : [params.tag];
      if (tags.length > 0) query = query.contains('tags', tags);
    }
    if (params.commercial === 'true') query = query.eq('commercial', true);
    else if (params.commercial === 'false') query = query.eq('commercial', false);
    if (params.place_category) {
      const { data: matchingPlaces } = await supabaseAdmin
        .from('places')
        .select('id')
        .contains('place_categories', [params.place_category]);
      const matchingPlaceIds = (matchingPlaces || []).map(p => p.id as string);
      if (matchingPlaceIds.length === 0) {
        res.set('Cache-Control', 'public, max-age=60');
        res.json({ meta: buildMeta(0, limit, offset), publishers: [] });
        return;
      }
      query = query.in('primary_place_id', matchingPlaceIds);
    }

    if (params.q) {
      const sanitized = sanitizeSearchInput(params.q);
      if (sanitized) {
        query = query.or(`name.ilike.%${sanitized}%,description.ilike.%${sanitized}%`);
      }
    }

    const { data: orgs, error, count } = await query;
    if (error) {
      console.error('[V1:PUBLISHERS] Query error:', error.message);
      throw createError('Failed to fetch publishers', 500, 'SERVER_ERROR');
    }

    // Hydrate primary places
    const placeIds = Array.from(
      new Set((orgs || []).map(o => o.primary_place_id as string | null).filter(Boolean) as string[])
    );
    const placesById = new Map<string, Record<string, unknown>>();
    if (placeIds.length > 0) {
      const { data: places } = await supabaseAdmin
        .from('places')
        .select(PLACE_SELECT_INLINE)
        .in('id', placeIds);
      for (const p of places || []) placesById.set(p.id as string, p);
    }

    // Hydrate verifications
    const orgIds = (orgs || []).map(o => o.id as string);
    const verifications = await hydrateVerificationsFor(orgIds);

    let formatted = (orgs || []).map(o => formatOrganization(o, placesById, verifications));

    // Geo filter post-fetch (same as /v1/organizations)
    if (params.near && params.radius_km) {
      const [lat, lng] = params.near.split(',').map(Number);
      if (!isNaN(lat) && !isNaN(lng)) {
        formatted = formatted.filter(o => {
          if (!o.location) return false;
          const oLat = o.location.geo?.latitude;
          const oLng = o.location.geo?.longitude;
          if (typeof oLat !== 'number' || typeof oLng !== 'number') return false;
          const latDelta = (params.radius_km as number) / 111;
          const lngDelta = (params.radius_km as number) / (111 * Math.cos((lat * Math.PI) / 180));
          return (
            oLat >= lat - latDelta && oLat <= lat + latDelta &&
            oLng >= lng - lngDelta && oLng <= lng + lngDelta
          );
        });
      }
    }

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      meta: buildMeta(count || 0, limit, offset),
      publishers: formatted,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/publishers/:idOrSlug
// ---------------------------------------------------------------------------

router.get('/:idOrSlug', async (req, res, next) => {
  try {
    const param = req.params.idOrSlug;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);

    const lookup = isUuid
      ? supabaseAdmin.from('organizations').select(ORG_SELECT).eq('id', param)
      : supabaseAdmin.from('organizations').select(ORG_SELECT).eq('slug', param.toLowerCase());

    const { data: org, error } = await lookup.maybeSingle();
    if (error) {
      console.error('[V1:PUBLISHERS] Query error:', error.message);
      throw createError('Failed to fetch publisher', 500, 'SERVER_ERROR');
    }
    if (!org) {
      throw createError('Publisher not found', 404, 'NOT_FOUND');
    }

    // Confirm the org is actually a publisher (has at least one event or broadcast).
    // If not, return 404 — they exist as an organization but not as a publisher.
    const publisherIds = await getPublisherOrgIds();
    if (!publisherIds.has(org.id as string)) {
      throw createError('Publisher not found', 404, 'NOT_FOUND');
    }

    const placesById = new Map<string, Record<string, unknown>>();
    if (org.primary_place_id) {
      const { data: place } = await supabaseAdmin
        .from('places')
        .select(PLACE_SELECT_INLINE)
        .eq('id', org.primary_place_id)
        .maybeSingle();
      if (place) placesById.set(place.id as string, place);
    }

    const verifications = await hydrateVerificationsFor([org.id as string]);

    res.set('Cache-Control', 'public, max-age=60');
    res.json({ publisher: formatOrganization(org, placesById, verifications) });
  } catch (err) {
    next(err);
  }
});

export default router;
