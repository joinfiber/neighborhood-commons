/**
 * Public Lists API — Neighborhood Commons 1.0.0
 *
 * Read-only public API for Schema.org ItemList — curatorial selections by
 * an Organization or Person. List items are polymorphic: each references
 * exactly one of an event, organization, or place.
 *
 * Base: /api/v1/lists
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, sanitizeSearchInput } from '../lib/helpers.js';
import { optionalApiKey } from '../middleware/api-key.js';
import { hydrateVerificationsFor } from '../lib/verification-hydrate.js';
import { formatPlace } from './v1-places.js';
import { formatOrganization } from './v1-organizations.js';
// v2: formatPerson import removed — persons primitive dropped, curator is always an organization
import { toNeighborhoodEvent, type PortalEventRow } from '../lib/event-transform.js';

const router: ReturnType<typeof Router> = Router();
router.use(optionalApiKey);

export const listsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.apiKeyInfo?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded (1000/hr).' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const LIST_SELECT = `
  id, slug, name, description,
  curator_org_id, curator_person_id,
  created_at, updated_at
`;

const ORG_SELECT_INLINE = `
  id, slug, name, legal_name, description, url, logo_url, image_url,
  telephone, email, same_as, keywords, opening_hours_specification,
  tags, commercial, primary_place_id, created_at, updated_at
`;

// v2: PERSON_SELECT_INLINE removed (persons primitive dropped).

const PLACE_SELECT_INLINE = `
  id, google_place_id, name,
  street_address, address_locality, address_region, postal_code, address_country,
  latitude, longitude, region_id, created_at, updated_at
`;

const EVENT_SELECT_INLINE = 'id, content, description, place_name, venue_address, place_id, latitude, longitude, event_at, end_time, event_timezone, category, custom_category, recurrence, price, link_url, event_image_url, event_image_focal_y, created_at, creator_account_id, organizer_org_id, series_id, series_instance_number, open_window, capacity, rsvp, tags, wheelchair_accessible, source_method, source_publisher, source_contributor_name, source_contributor_url, organizations!events_organizer_org_id_fkey(id, slug, name)';

const listSchema = z.object({
  curator_id: z.string().uuid().optional(),
  curator_type: z.enum(['organization', 'person']).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/v1/lists
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(listSchema, req.query);
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    let query = supabaseAdmin
      .from('lists')
      .select(LIST_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // v2: lists are always curated by an organization (curator_org_id NOT NULL).
    // The legacy `curator_type=person` filter is a no-op now.
    if (params.curator_id) {
      query = query.eq('curator_org_id', params.curator_id);
    }

    if (params.q) {
      const sanitized = sanitizeSearchInput(params.q);
      if (sanitized) {
        query = query.or(`name.ilike.%${sanitized}%,description.ilike.%${sanitized}%`);
      }
    }

    const { data: lists, error, count } = await query;
    if (error) {
      console.error('[V1:LISTS] Query error:', error.message);
      throw createError('Failed to fetch lists', 500, 'SERVER_ERROR');
    }

    const formatted = await Promise.all(
      (lists || []).map(async l => formatList(l as Record<string, unknown>, { hydrateItems: false }))
    );

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      meta: buildMeta(count || 0, limit, offset),
      lists: formatted,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/lists/:idOrSlug
// ---------------------------------------------------------------------------

router.get('/:idOrSlug', async (req, res, next) => {
  try {
    const param = req.params.idOrSlug;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);

    const lookup = isUuid
      ? supabaseAdmin.from('lists').select(LIST_SELECT).eq('id', param)
      : supabaseAdmin.from('lists').select(LIST_SELECT).eq('slug', param.toLowerCase());

    const { data: list, error } = await lookup.maybeSingle();
    if (error) {
      console.error('[V1:LISTS] Query error:', error.message);
      throw createError('Failed to fetch list', 500, 'SERVER_ERROR');
    }
    if (!list) {
      throw createError('List not found', 404, 'NOT_FOUND');
    }

    const formatted = await formatList(list as Record<string, unknown>, { hydrateItems: true });

    res.set('Cache-Control', 'public, max-age=60');
    res.json({ list: formatted });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Format List for API response
// ---------------------------------------------------------------------------

async function formatList(row: Record<string, unknown>, opts: { hydrateItems: boolean }) {
  const id = row.id as string;

  // v2: curator is always an organization. The curator_person_id branch
  // is dead code (column dropped in migration 082); kept here only until
  // the v1-lists route is fully refactored.
  let curator: Record<string, unknown> | null = null;
  if (row.curator_org_id) {
    const { data: orgRow } = await supabaseAdmin
      .from('organizations')
      .select(ORG_SELECT_INLINE)
      .eq('id', row.curator_org_id)
      .maybeSingle();
    if (orgRow) {
      const verifs = await hydrateVerificationsFor([orgRow.id as string]);
      curator = formatOrganization(orgRow, new Map(), verifs);
    }
  }

  let itemListElement: Array<Record<string, unknown>> = [];
  let numberOfItems = 0;

  // Items pull
  const { data: items, count } = await supabaseAdmin
    .from('list_items')
    .select('id, position, event_id, organization_id, place_id, curator_note', { count: 'exact' })
    .eq('list_id', id)
    .order('position', { ascending: true });
  numberOfItems = count || 0;

  if (opts.hydrateItems && items && items.length > 0) {
    // Bulk-fetch each referenced type to avoid N+1
    const eventIds = items.filter(i => i.event_id).map(i => i.event_id as string);
    const orgIds = items.filter(i => i.organization_id).map(i => i.organization_id as string);
    const placeIds = items.filter(i => i.place_id).map(i => i.place_id as string);

    const [eventsRes, orgsRes, placesRes] = await Promise.all([
      eventIds.length > 0
        ? supabaseAdmin.from('events').select(EVENT_SELECT_INLINE).in('id', eventIds)
        : Promise.resolve({ data: [], error: null }),
      orgIds.length > 0
        ? supabaseAdmin.from('organizations').select(ORG_SELECT_INLINE).in('id', orgIds)
        : Promise.resolve({ data: [], error: null }),
      placeIds.length > 0
        ? supabaseAdmin.from('places').select(PLACE_SELECT_INLINE).in('id', placeIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const eventsById = new Map((eventsRes.data || []).map(e => [e.id as string, e]));
    const orgsById = new Map((orgsRes.data || []).map(o => [o.id as string, o]));
    const placesById = new Map((placesRes.data || []).map(p => [p.id as string, p]));

    const orgVerifs = await hydrateVerificationsFor(orgIds);

    itemListElement = items.map(it => {
      let item: Record<string, unknown> | null = null;
      if (it.event_id && eventsById.has(it.event_id as string)) {
        item = toNeighborhoodEvent(eventsById.get(it.event_id as string) as unknown as PortalEventRow) as unknown as Record<string, unknown>;
      } else if (it.organization_id && orgsById.has(it.organization_id as string)) {
        item = formatOrganization(orgsById.get(it.organization_id as string)!, placesById, orgVerifs);
      } else if (it.place_id && placesById.has(it.place_id as string)) {
        item = formatPlace(placesById.get(it.place_id as string)!);
      }
      return {
        position: it.position,
        item,
        curatorNote: it.curator_note || null,
      };
    });
  }

  return {
    id,
    slug: row.slug,
    name: row.name,
    description: row.description || null,
    curator,
    itemListOrder: 'Ascending',
    numberOfItems,
    itemListElement,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildMeta(total: number, limit: number, offset: number) {
  return {
    total,
    limit,
    offset,
    spec: 'neighborhood-api-v0.2',
    license: 'CC-BY-4.0',
  };
}

export default router;
