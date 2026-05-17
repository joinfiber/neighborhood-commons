/**
 * Public Organizations API — Neighborhood Commons v2
 *
 * Read-only public API for Schema.org Organization records — the unified
 * entity primitive. Anything that publishes or organizes is an organization,
 * regardless of how many humans operate it.
 *
 * v2 changes from v1:
 *   - No `kind` discriminator. Classification emerges from `tags` (descriptive)
 *     + `commercial` (binary) + structural signals (place_categories, events).
 *   - `additionalType` is derived from structural data: LocalBusiness if the
 *     org has a primary_place_id, plain Organization otherwise.
 *
 * No authentication required. Optional API key for dedicated rate limit.
 *
 * Base: /api/v1/organizations
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, sanitizeSearchInput } from '../lib/helpers.js';
import { optionalApiKey } from '../middleware/api-key.js';
import { hydrateVerificationsFor, resolveVerificationIdFilter, type VerificationByTarget } from '../lib/verification-hydrate.js';
import { formatPlace } from './v1-places.js';

const router: ReturnType<typeof Router> = Router();
router.use(optionalApiKey);

export const organizationsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.apiKeyInfo?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded (1000/hr).' } },
  standardHeaders: true,
  legacyHeaders: false,
});

export const ORG_SELECT = `
  id, slug, name, legal_name,
  description, url, logo_url, image_url, telephone, email,
  same_as, keywords, opening_hours_specification,
  tags, commercial,
  primary_place_id,
  created_at, updated_at
`;

const PLACE_SELECT_INLINE = `
  id, google_place_id, name,
  street_address, address_locality, address_region, postal_code, address_country,
  latitude, longitude, region_id,
  place_categories, category_source,
  created_at, updated_at
`;

const listSchema = z.object({
  // v2: kind filter gone. Use tag + commercial + place_category for classification.
  tag: z.union([z.string().max(50), z.array(z.string().max(50))]).optional(),
  commercial: z.enum(['true', 'false']).optional(),
  place_category: z.string().max(50).optional(),
  verified: z.enum(['true', 'false']).optional(),
  verified_by: z.string().max(500).optional(),
  not_verified_by: z.string().max(500).optional(),
  created_by_contributor: z.string().max(200).optional(),
  near: z.string().regex(/^-?\d+\.?\d*,-?\d+\.?\d*$/).optional(),
  radius_km: z.coerce.number().min(0.1).max(100).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  offset: z.coerce.number().min(0).optional(),
});

export type OrgListParams = z.infer<typeof listSchema>;
export { listSchema as orgListSchema };

// ---------------------------------------------------------------------------
// GET /api/v1/organizations
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(listSchema, req.query);
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    // Pre-resolve verification filters into an include/exclude id set so SQL
    // can apply them. This is what makes meta.total reflect the FILTERED
    // count — the older post-fetch approach reported the unfiltered total
    // and confused paginating consumers.
    const verifFilter = await resolveVerificationIdFilter({
      verified: params.verified,
      verified_by: params.verified_by,
      not_verified_by: params.not_verified_by,
    });
    if ('empty' in verifFilter && verifFilter.empty) {
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ meta: buildMeta(0, limit, offset), organizations: [] });
      return;
    }

    let query = supabaseAdmin
      .from('organizations')
      .select(ORG_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if ('includeIds' in verifFilter) query = query.in('id', verifFilter.includeIds);
    if ('excludeIds' in verifFilter) {
      // Supabase JS .not('id', 'in', '(uuid1,uuid2,...)') format
      query = query.not('id', 'in', `(${verifFilter.excludeIds.join(',')})`);
    }

    // v2 filters: tag, commercial, place_category (replaces kind)
    if (params.tag) {
      const tags = Array.isArray(params.tag) ? params.tag : [params.tag];
      if (tags.length > 0) query = query.contains('tags', tags);
    }

    if (params.commercial === 'true') query = query.eq('commercial', true);
    else if (params.commercial === 'false') query = query.eq('commercial', false);

    if (params.place_category) {
      // Filter to orgs whose primary_place has the given category.
      // Two-step: find matching places, then filter orgs by primary_place_id.
      const { data: matchingPlaces } = await supabaseAdmin
        .from('places')
        .select('id')
        .contains('place_categories', [params.place_category]);
      const matchingPlaceIds = (matchingPlaces || []).map(p => p.id as string);
      if (matchingPlaceIds.length === 0) {
        // No matching places; result must be empty.
        res.set('Cache-Control', 'public, max-age=60');
        res.json({ meta: buildMeta(0, limit, offset), organizations: [] });
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

    // Geo filtering on the org's primary_place — requires JOIN.
    // For v1 we filter post-fetch since the place is referenced not nested in the row.
    // (Performance is fine until tables grow large; revisit with a real spatial index.)

    const { data: orgs, error, count } = await query;
    if (error) {
      console.error('[V1:ORGANIZATIONS] Query error:', error.message);
      throw createError('Failed to fetch organizations', 500, 'SERVER_ERROR');
    }

    // Hydrate primary places for orgs that have one
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

    // Hydrate verifications (still needed for the `verification` block on each org)
    const orgIds = (orgs || []).map(o => o.id as string);
    const verifications = await hydrateVerificationsFor(orgIds);

    let formatted = (orgs || []).map(o => formatOrganization(o, placesById, verifications));

    // Geo filter post-fetch
    if (params.near && params.radius_km) {
      const [lat, lng] = params.near.split(',').map(Number);
      if (!isNaN(lat) && !isNaN(lng)) {
        formatted = formatted.filter(o => {
          if (!o.location) return false;
          const oLat = o.location.geo?.latitude;
          const oLng = o.location.geo?.longitude;
          if (typeof oLat !== 'number' || typeof oLng !== 'number') return false;
          // Approximate bounding-box check for speed
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
      organizations: formatted,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/organizations/:idOrSlug
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
      console.error('[V1:ORGANIZATIONS] Query error:', error.message);
      throw createError('Failed to fetch organization', 500, 'SERVER_ERROR');
    }
    if (!org) {
      throw createError('Organization not found', 404, 'NOT_FOUND');
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
    res.json({ organization: formatOrganization(org, placesById, verifications) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Format Organization for API response
// ---------------------------------------------------------------------------

/**
 * v2: derive additionalType from structural data instead of a kind enum.
 * Has primary_place_id → LocalBusiness. Otherwise → Organization.
 * Apps that want richer Schema.org subtyping can derive from tags or
 * place_categories on their side.
 */
function deriveAdditionalType(hasPrimaryPlace: boolean): string {
  return hasPrimaryPlace
    ? 'https://schema.org/LocalBusiness'
    : 'https://schema.org/Organization';
}

export function formatOrganization(
  row: Record<string, unknown>,
  placesById: Map<string, Record<string, unknown>>,
  verifications: VerificationByTarget
) {
  const id = row.id as string;
  const v = verifications.get(id);
  const placeRow = row.primary_place_id
    ? placesById.get(row.primary_place_id as string)
    : null;

  return {
    id,
    slug: row.slug,
    name: row.name,
    legalName: row.legal_name || null,
    additionalType: deriveAdditionalType(!!placeRow),
    description: row.description || null,
    url: row.url || null,
    logo: row.logo_url || null,
    image: row.image_url || null,
    telephone: row.telephone || null,
    email: row.email || null,
    sameAs: row.same_as || [],
    keywords: row.keywords || [],
    tags: row.tags || [],
    commercial: row.commercial ?? null,
    openingHoursSpecification: row.opening_hours_specification || null,
    location: placeRow ? formatPlace(placeRow) : null,
    verified: !!v,
    verification: v || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function buildMeta(total: number, limit: number, offset: number) {
  return {
    total,
    limit,
    offset,
    spec: 'neighborhood-api-v0.2',
    license: 'CC-BY-4.0',
  };
}

export { PLACE_SELECT_INLINE };
export default router;
