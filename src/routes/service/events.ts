/**
 * Service API — Events (v2)
 *
 * Single-event CRUD (list, get, create, patch, delete) and batch update.
 * Series operations (patch/delete across all future instances) live in
 * service/series.ts.
 *
 * Auth: all routes inherit requireServiceApiKey from service/index.ts.
 *
 * Scoping (v2 constrained-publishing): every event write either has a
 * service key linked to the organizer organization via
 * api_key_organization_links, OR uses source_method='witnessed' from a
 * key with witness_authority=true. Admin keys bypass.
 */

import { Router } from 'express';
import { z } from 'zod';
import { EVENT_CATEGORY_KEYS } from '../../lib/categories.js';
import { validateTags } from '../../lib/tags.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest, validateUuidParam, sanitizeSearchInput } from '../../lib/helpers.js';
import { dispatchEventWebhookById } from '../../lib/webhook-delivery.js';
import { serviceLimiter } from '../../middleware/rate-limit.js';
import {
  PORTAL_SELECT, MANAGED_SOURCES, toPortalEvent, portalInputToInsert,
  fromTimestamptz, toTimestamptz, getAdminUserId,
} from '../../lib/event-operations.js';
import { createEventSeries } from '../../lib/event-series.js';
import { downloadAndAttachImage } from '../../lib/image-processing.js';
import { nominatimGeocode } from '../../lib/geocoding.js';
import { isFirstPartyByOrganizer } from '../../lib/verification-hydrate.js';
import { config } from '../../config.js';
import { assertLinkedEvent } from './helpers.js';
import { assertLinkedOrganization } from './helpers-v1.js';

/**
 * Resolve the publishing organization to (a) its name (source_publisher
 * fallback), (b) its owner_account_id (carries the operational claim
 * state for the legacy creator_account_id column and photo eligibility),
 * and (c) coordinates from its primary_place if available.
 *
 * Throws 404 NOT_FOUND if the organization doesn't exist.
 */
async function resolveOrganizerContext(organizationId: string): Promise<{
  name: string;
  ownerAccountId: string | null;
  primaryPlaceCoords: { lat: number | null; lng: number | null; address: string | null };
}> {
  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('id, name, owner_account_id, primary_place_id')
    .eq('id', organizationId)
    .maybeSingle();

  if (!org) throw createError('Organization not found', 404, 'NOT_FOUND');

  let coords: { lat: number | null; lng: number | null; address: string | null } = {
    lat: null, lng: null, address: null,
  };
  if (org.primary_place_id) {
    const { data: place } = await supabaseAdmin
      .from('places')
      .select('latitude, longitude, street_address')
      .eq('id', org.primary_place_id)
      .maybeSingle();
    if (place) {
      coords = {
        lat: place.latitude as number | null,
        lng: place.longitude as number | null,
        address: place.street_address as string | null,
      };
    }
  }

  return {
    name: org.name as string,
    ownerAccountId: (org.owner_account_id as string | null) ?? null,
    primaryPlaceCoords: coords,
  };
}

const router: ReturnType<typeof Router> = Router();

// Friendly-shape Service API input — symmetric with the read schema.
// See public/openapi.json #/components/schemas/ServiceEventInput (authoritative).
// Internal DB columns are translated from this shape by friendlyToPortalInput().
const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

export const locationSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  address: z.string().max(500).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  place_id: z.string().max(500).optional(),
});

// Per-event contributor override (migration 062). Decoupled from
// source_publisher so a Service-API caller can attribute an event to an
// app/tool (e.g. "Go There") without moving the subscribable publisher
// off the organizer's name. Omitted → contributor falls back to the
// legacy source_publisher-on-api derivation in event-transform.ts.
const contributorSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  url: z.preprocess(
    (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    z.string().url().max(2000).optional().or(z.literal('')),
  ),
});

// v2: source_method is constrained on input. 'portal' and 'import' are
// not caller-set (legacy / pipeline use). Callers choose 'api' (default)
// or 'witnessed' (collective-evidence path — requires witness_authority).
const callerSourceMethod = z.enum(['api', 'witnessed']).default('api');

export const createEventSchema = z.object({
  organizerOrganizationId: z.string().uuid(),
  source_method: callerSourceMethod.optional(),
  name: z.string().min(1).max(200),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().max(50).refine(
    (tz) => VALID_TIMEZONES.has(tz),
    { message: 'Invalid timezone. Use IANA format (e.g., America/New_York)' },
  ),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]),
  custom_category: z.string().max(50).optional(),
  location: locationSchema,
  description: z.string().max(2000).optional(),
  cost: z.string().max(100).optional(),
  url: z.preprocess(
    (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    z.string().url().max(2000).optional().or(z.literal('')),
  ),
  image_url: z.string().url().max(2000).optional(),
  recurrence: z.string()
    .regex(/^(none|daily|weekly|biweekly|monthly|ordinal_weekday:[1-5]:(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|weekly_days:(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*)$/)
    .optional(),
  instance_count: z.number().int().min(0).max(260).optional(),
  tags: z.array(z.string().max(50)).max(15).optional(),
  wheelchair_accessible: z.boolean().nullable().default(null),
  capacity: z.number().int().min(1).max(10000).nullable().default(null),
  rsvp: z.enum(['recommended', 'required']).nullable().default(null),
  open_window: z.boolean().default(false),
  image_focal_y: z.number().min(0).max(1).optional(),
  // source_publisher is NOT caller-overridable — derived from the organizer organization name.
  // first_party is NOT caller-overridable — computed server-side at insert time
  // from the organizer's verification state.
  // contributor IS caller-overridable (migration 062) — per-event "who ran this"
  // attribution, distinct from the subscribable publisher. Optional.
  contributor: contributorSchema.optional(),
  external_id: z.string().max(500).optional(),
  tmdb_id: z.string().max(50).optional(),
});

export const updateEventSchema = z.object({
  organizerOrganizationId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional().nullable(),
  timezone: z.string().max(50).refine(
    (tz) => VALID_TIMEZONES.has(tz),
    { message: 'Invalid timezone. Use IANA format (e.g., America/New_York)' },
  ).optional(),
  category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
  custom_category: z.string().max(50).optional().nullable(),
  location: locationSchema.partial().optional(),
  description: z.string().max(2000).optional().nullable(),
  cost: z.string().max(100).optional().nullable(),
  url: z.preprocess(
    (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    z.string().url().max(2000).optional().or(z.literal('')).nullable(),
  ),
  tags: z.array(z.string().max(50)).max(15).optional(),
  wheelchair_accessible: z.boolean().nullable().optional(),
  capacity: z.number().int().min(1).max(10000).nullable().optional(),
  rsvp: z.enum(['recommended', 'required']).nullable().optional(),
  open_window: z.boolean().optional(),
  image_focal_y: z.number().min(0).max(1).optional(),
  // Pass `contributor: null` to clear an existing override.
  contributor: contributorSchema.nullable().optional(),
  status: z.enum(['published', 'pending_review', 'suspended', 'unpublished']).optional(),
  tmdb_id: z.string().max(50).nullable().optional(),
});

type CreateEventInput = z.infer<typeof createEventSchema>;

/**
 * Decompose a friendly-shape Service input into the portal-style fields
 * `portalInputToInsert` expects. DB columns are internal; wire shape is friendly.
 */
export function friendlyToPortalInput(
  data: CreateEventInput,
  sourcePublisher: string | null,
): {
  portal: Parameters<typeof portalInputToInsert>[0];
  event_date: string;
  start_time: string;
  end_time?: string;
} {
  const { date: eventDate, time: startTime } = fromTimestamptz(data.start, data.timezone);
  const endTime = data.end ? fromTimestamptz(data.end, data.timezone).time : undefined;
  return {
    portal: {
      title: data.name,
      venue_name: data.location.name,
      address: data.location.address ?? null,
      place_id: data.location.place_id ?? null,
      latitude: data.location.lat ?? null,
      longitude: data.location.lng ?? null,
      event_date: eventDate,
      start_time: startTime,
      end_time: endTime ?? null,
      event_timezone: data.timezone,
      category: data.category,
      custom_category: data.custom_category ?? null,
      recurrence: data.recurrence ?? 'none',
      description: data.description ?? null,
      price: data.cost ?? null,
      ticket_url: typeof data.url === 'string' && data.url ? data.url : null,
      open_window: data.open_window,
      tags: data.tags,
      wheelchair_accessible: data.wheelchair_accessible,
      capacity: data.capacity,
      rsvp: data.rsvp,
      image_focal_y: data.image_focal_y,
      source_method: (data.source_method ?? 'api') as 'api' | 'portal' | 'feed' | 'admin' | 'merrie',
      source_publisher: sourcePublisher ?? undefined,
      source_contributor_name: data.contributor?.name ?? null,
      source_contributor_url:
        data.contributor && typeof data.contributor.url === 'string' && data.contributor.url
          ? data.contributor.url
          : null,
      // first_party intentionally omitted — set by the route handler after
      // computing from the organizer's verification state.
      tmdb_id: data.tmdb_id ?? null,
    },
    event_date: eventDate,
    start_time: startTime,
    end_time: endTime,
  };
}

/** GET /service/events — Events with pagination, search, and filters */
const listEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  search: z.string().max(200).optional(),
  time: z.enum(['upcoming', 'past', 'all']).optional(),
  status: z.enum(['published', 'pending_review', 'suspended', 'draft']).optional(),
});

router.get('/events', serviceLimiter, async (req, res, next) => {
  try {
    const { limit, offset, search, time, status } = validateRequest(listEventsQuerySchema, req.query);

    let query = supabaseAdmin
      .from('events')
      .select(
        `${PORTAL_SELECT}, organizations!events_organizer_org_id_fkey(id, slug, name)`,
        { count: 'exact' },
      )
      .in('source', [...MANAGED_SOURCES]);

    // Status filter (validated by schema)
    if (status) {
      query = query.eq('status', status);
    }

    // Source method filter (e.g. 'api' for contributed events)
    const sourceMethod = req.query.source_method as string | undefined;
    if (sourceMethod) {
      query = query.eq('source_method', sourceMethod);
    }

    // Category filter
    const category = req.query.category as string | undefined;
    if (category) {
      query = query.eq('category', category);
    }

    // Text search on title, venue name, and address (covers zip code searches)
    if (search) {
      const sanitized = sanitizeSearchInput(search);
      if (sanitized) query = query.or(`content.ilike.%${sanitized}%,place_name.ilike.%${sanitized}%,venue_address.ilike.%${sanitized}%`);
    }

    // Time filter
    const now = new Date().toISOString();
    if (time === 'upcoming' || !time) {
      query = query.gte('event_at', now);
      query = query.order('event_at', { ascending: true });
    } else if (time === 'past') {
      query = query.lt('event_at', now);
      query = query.order('event_at', { ascending: false });
    } else {
      // 'all' — order by creation date
      query = query.order('created_at', { ascending: false });
    }

    // By default, show only one-offs + first instance of each series (for listing UI).
    // Pass ?all_instances=true to include every series instance (for reconciliation).
    const allInstances = req.query.all_instances === 'true';
    if (!allInstances) {
      query = query.or('series_id.is.null,series_instance_number.eq.0,series_instance_number.eq.1');
    }
    query = query.range(offset, offset + limit - 1);

    const { data: rawEvents, error, count } = await query;

    if (error) throw createError('Failed to fetch events', 500, 'SERVER_ERROR');

    const paged = rawEvents || [];

    const result = paged.map((e) => {
      const pe = toPortalEvent(e);
      pe.organizer = (e as Record<string, unknown>).organizations;
      return pe;
    });

    res.json({ events: result, total: count || 0 });
  } catch (err) {
    next(err);
  }
});

/** GET /service/events/:id — Single event with organizer */
router.get('/events/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');

    const { data: event, error } = await supabaseAdmin
      .from('events')
      .select(`${PORTAL_SELECT}, organizations!events_organizer_org_id_fkey(id, slug, name)`)
      .eq('id', req.params.id)
      .maybeSingle();

    if (error || !event) throw createError('Event not found', 404, 'NOT_FOUND');
    res.json({
      event: toPortalEvent(event),
      organizer: (event as Record<string, unknown>).organizations || null,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /service/events — Create event (organizer-scoped) */
router.post('/events', serviceLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(createEventSchema, req.body);
    const sourceMethod = data.source_method ?? 'api';
    const witnessed = sourceMethod === 'witnessed';

    // Authority gate. Witnessed-evidence keys bypass the org-link check
    // (publisher is the collective; the witness has the receipts). All
    // other paths require an api_key_organization_links row.
    if (witnessed) {
      if (!req.apiKeyInfo?.isAdmin && !req.apiKeyInfo?.witnessAuthority) {
        throw createError(
          'source_method=witnessed requires a key with witness_authority granted at activation.',
          403,
          'INSUFFICIENT_TIER',
        );
      }
    } else {
      await assertLinkedOrganization(req, data.organizerOrganizationId);
    }

    // Resolve organizer name + owner account + default coords from
    // primary_place (post-082 these no longer live on portal_accounts).
    const orgCtx = await resolveOrganizerContext(data.organizerOrganizationId);

    // Photo eligibility — only events whose organizer has a claimed owner
    // account may contribute media bytes. Witnessed evidence bypasses
    // (the collective is the warrantor). "Claimed" means either
    // (a) Supabase Auth claim (`auth_user_id`) or (b) service-key claim
    // via /accounts/link / atomic activation (`claimed_at` is set).
    if (data.image_url && !witnessed) {
      if (!orgCtx.ownerAccountId) {
        throw createError(
          'Photos may only be contributed by organizations with a claimed owner account.',
          403,
          'IMAGE_NOT_PERMITTED',
        );
      }
      const { data: ownerAccount } = await supabaseAdmin
        .from('portal_accounts')
        .select('auth_user_id, claimed_at')
        .eq('id', orgCtx.ownerAccountId)
        .maybeSingle();
      if (!ownerAccount || (!ownerAccount.auth_user_id && !ownerAccount.claimed_at)) {
        throw createError(
          'Photos may only be contributed by claimed accounts',
          403,
          'IMAGE_NOT_PERMITTED',
        );
      }
    }

    // adminUserId: prefer the org owner's auth_user_id (preserves legacy
    // creator-attribution invariants) and fall back to the platform admin.
    let adminUserId = getAdminUserId();
    if (orgCtx.ownerAccountId) {
      const { data: owner } = await supabaseAdmin
        .from('portal_accounts')
        .select('auth_user_id')
        .eq('id', orgCtx.ownerAccountId)
        .maybeSingle();
      if (owner?.auth_user_id) adminUserId = owner.auth_user_id as string;
    }
    const validatedTags = data.tags ? validateTags(data.tags, data.category) : [];

    // Auto-derive source.contributor from the calling key's brand identity
    // when the caller didn't supply one. The publisher is the organization
    // (orgCtx.name); the contributor is the app that pushed the data in —
    // distinct concepts. This makes ecosystem attribution work without
    // requiring every consumer to remember the field on every POST. Admin
    // keys (Studio, operator tools) skip — they act on behalf of, they
    // aren't ecosystem contributors. Callers can still set contributor
    // explicitly to override, or omit brand_config.app_name on the key to
    // suppress.
    if (
      !data.contributor
      && !req.apiKeyInfo?.isAdmin
      && req.apiKeyInfo?.brandConfig?.app_name
    ) {
      data.contributor = { name: req.apiKeyInfo.brandConfig.app_name };
    }

    const { portal, event_date: eventDate, start_time: startTime, end_time: endTime }
      = friendlyToPortalInput(data, orgCtx.name);
    portal.tags = validatedTags;
    portal.first_party = await isFirstPartyByOrganizer(data.organizerOrganizationId);

    const insert = portalInputToInsert(portal, orgCtx.ownerAccountId, adminUserId);
    // Stamp the organizer FK directly — it's the load-bearing authority anchor.
    insert.organizer_org_id = data.organizerOrganizationId;

    // Resolve coordinates: explicit > organizer's primary_place > geocode
    let lat = data.location.lat ?? null;
    let lng = data.location.lng ?? null;
    const address = data.location.address;

    // If no explicit coordinates, inherit from organizer's primary_place
    // when the event address matches (or is absent).
    if (
      lat == null && lng == null
      && orgCtx.primaryPlaceCoords.lat != null
      && orgCtx.primaryPlaceCoords.lng != null
    ) {
      const eventAddr = (address || '').toLowerCase().trim();
      const placeAddr = (orgCtx.primaryPlaceCoords.address || '').toLowerCase().trim();
      if (!eventAddr || !placeAddr || eventAddr === placeAddr) {
        lat = orgCtx.primaryPlaceCoords.lat;
        lng = orgCtx.primaryPlaceCoords.lng;
        insert.latitude = lat;
        insert.longitude = lng;
        insert.approximate_location = `POINT(${lng} ${lat})`;
        console.log(`[SERVICE] Using organizer primary_place coordinates for "${data.name}": ${lat}, ${lng}`);
      }
    }

    // Geocode only as a last resort — event has an address but no coords from above
    if (lat == null && lng == null && address) {
      try {
        const coords = await nominatimGeocode(address);
        if (coords) {
          lat = coords.lat;
          lng = coords.lng;
          insert.latitude = lat;
          insert.longitude = lng;
          insert.approximate_location = `POINT(${lng} ${lat})`;
          console.log(`[SERVICE] Geocoded "${address}" → ${lat}, ${lng}`);
        }
      } catch (err) {
        console.error('[SERVICE] Geocode failed:', err instanceof Error ? err.message : err);
      }
    }

    // Resolve region from coordinates
    if (lat != null && lng != null) {
      const { data: regionData } = await supabaseAdmin.rpc('find_user_region', {
        p_longitude: lng,
        p_latitude: lat,
      });
      if (regionData && regionData.length > 0) {
        insert.region_id = regionData[0].region_id;
        console.log(`[SERVICE] Region resolved: ${regionData[0].region_name}`);
      }
    }

    // Ensure region_id is never null — fall back to default
    if (!insert.region_id && config.defaultRegionId) {
      insert.region_id = config.defaultRegionId;
    }

    const recurrence = data.recurrence ?? 'none';
    if (recurrence !== 'none') {
      // Recurring: create series
      const instances = await createEventSeries(
        insert,
        recurrence,
        eventDate,
        startTime,
        endTime,
        data.timezone,
        data.instance_count,
      );

      console.log(`[SERVICE] Series created: ${data.name} (${instances.length} instances)`);

      // Attach image to every instance (fire-and-forget — image failure must not fail publish)
      if (data.image_url) {
        const imageUrl = data.image_url;
        for (const inst of instances) {
          void downloadAndAttachImage(inst.id, imageUrl)
            .then(() => console.log(`[SERVICE] Image attached to ${inst.id}`))
            .catch((err) => console.error(`[SERVICE] Image attach failed for ${inst.id}:`, err instanceof Error ? err.message : err));
        }
      }

      res.status(201).json({
        series_count: instances.length,
        series_id: instances[0] ? (await supabaseAdmin.from('events').select('series_id').eq('id', instances[0].id).maybeSingle()).data?.series_id : null,
        instance_ids: instances.map(i => i.id),
      });
    } else {
      // One-off event
      const { data: event, error } = await supabaseAdmin
        .from('events')
        .insert(insert)
        .select(PORTAL_SELECT)
        .single();

      if (error) {
        console.error('[SERVICE] Create event error:', error.message);
        throw createError('Failed to create event', 500, 'SERVER_ERROR');
      }

      // Dispatch webhook (fire-and-forget)
      dispatchEventWebhookById('event.created', event.id);

      // Attach image (fire-and-forget — image failure must not fail publish)
      if (data.image_url) {
        const imageUrl = data.image_url;
        void downloadAndAttachImage(event.id, imageUrl)
          .then(() => console.log(`[SERVICE] Image attached to ${event.id}`))
          .catch((err) => console.error(`[SERVICE] Image attach failed for ${event.id}:`, err instanceof Error ? err.message : err));
      }

      console.log(`[SERVICE] Event created: ${data.name}`);
      res.status(201).json({ event: toPortalEvent(event) });
    }
  } catch (err) {
    next(err);
  }
});

/** PATCH /service/events/batch — Bulk update events (scoped) */
router.patch('/events/batch', serviceLimiter, async (req, res, next) => {
  try {
    // Scoping: verify all events belong to organizations linked to this key
    if (!req.apiKeyInfo?.isAdmin) {
      const body = req.body as { ids?: string[] };
      if (body.ids) {
        for (const id of body.ids) {
          await assertLinkedEvent(req, id);
        }
      }
    }

    const schema = z.object({
      ids: z.array(z.string().uuid()).min(1).max(200),
      updates: z.object({
        category: z.enum(EVENT_CATEGORY_KEYS as [string, ...string[]]).optional(),
        tags: z.array(z.string().max(100)).max(15).optional(),
        description: z.string().max(2000).optional().nullable(),
        price: z.string().max(100).optional().nullable(),
        wheelchair_accessible: z.boolean().nullable().optional(),
        open_window: z.boolean().optional(),
        capacity: z.number().int().min(1).max(10000).nullable().optional(),
        rsvp: z.enum(['recommended', 'required']).nullable().optional(),
        // first_party is server-computed at insert; not editable via batch
        // update. Recreate events if the organizer's verification state
        // changes and you want to re-tier them.
      }).refine((u) => Object.keys(u).length > 0, { message: 'No fields to update' }),
    });

    const data = validateRequest(schema, req.body);
    const dbUpdate: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data.updates)) {
      if (key === 'tags') {
        dbUpdate.tags = validateTags(value as string[], data.updates.category || '');
      } else {
        dbUpdate[key] = value;
      }
    }

    const { data: updated, error } = await supabaseAdmin
      .from('events')
      .update(dbUpdate)
      .in('id', data.ids)
      .select('id');

    if (error) throw createError('Failed to batch update', 500, 'SERVER_ERROR');
    res.json({ updated: updated?.length || 0, ids: (updated || []).map((r) => r.id) });
  } catch (err) {
    next(err);
  }
});

/** PATCH /service/events/:id — Update single event (organizer-scoped) */
router.patch('/events/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    await assertLinkedEvent(req, req.params.id);
    const data = validateRequest(updateEventSchema, req.body);

    // Fetch existing event — include event_at/end_time so we can preserve
    // wall-clock semantics on a timezone-only PATCH (S6).
    const { data: existing } = await supabaseAdmin
      .from('events')
      .select('id, status, event_timezone, event_at, end_time, organizer_org_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!existing) throw createError('Event not found', 404, 'NOT_FOUND');

    const wasPublished = existing.status === 'published';
    const dbUpdate: Record<string, unknown> = {};

    // Reassign event to a different organizer (for merging duplicates / cleanup).
    // Caller must be linked to the TARGET org as well — re-attribution can't
    // hand the event off to an org the caller doesn't control.
    if (data.organizerOrganizationId !== undefined) {
      await assertLinkedOrganization(req, data.organizerOrganizationId);
      const orgCtx = await resolveOrganizerContext(data.organizerOrganizationId);
      dbUpdate.organizer_org_id = data.organizerOrganizationId;
      // Keep creator_account_id consistent with the new organizer's owner.
      dbUpdate.creator_account_id = orgCtx.ownerAccountId;
    }

    if (data.status !== undefined) dbUpdate.status = data.status;
    if (data.name !== undefined) dbUpdate.content = data.name;
    if (data.location?.name !== undefined) dbUpdate.place_name = data.location.name;
    if (data.location?.address !== undefined) dbUpdate.venue_address = data.location.address;
    if (data.location?.place_id !== undefined) dbUpdate.place_id = data.location.place_id;
    if (data.location?.lat !== undefined) dbUpdate.latitude = data.location.lat;
    if (data.location?.lng !== undefined) dbUpdate.longitude = data.location.lng;
    if (data.description !== undefined) dbUpdate.description = data.description;
    if (data.cost !== undefined) dbUpdate.price = data.cost;
    if (data.url !== undefined) dbUpdate.link_url = data.url || null;
    if (data.category !== undefined) dbUpdate.category = data.category;
    if (data.custom_category !== undefined) dbUpdate.custom_category = data.custom_category;
    if (data.wheelchair_accessible !== undefined) dbUpdate.wheelchair_accessible = data.wheelchair_accessible;
    if (data.capacity !== undefined) dbUpdate.capacity = data.capacity;
    if (data.rsvp !== undefined) dbUpdate.rsvp = data.rsvp;
    if (data.open_window !== undefined) dbUpdate.open_window = data.open_window;
    if (data.image_focal_y !== undefined) dbUpdate.event_image_focal_y = data.image_focal_y;
    if (data.contributor !== undefined) {
      // null clears the override and falls back to the legacy derivation.
      dbUpdate.source_contributor_name = data.contributor?.name ?? null;
      dbUpdate.source_contributor_url =
        data.contributor && typeof data.contributor.url === 'string' && data.contributor.url
          ? data.contributor.url
          : null;
    }
    if (data.tmdb_id !== undefined) dbUpdate.tmdb_id = data.tmdb_id;

    if (data.tags !== undefined) {
      const cat = data.category || 'community';
      dbUpdate.tags = validateTags(data.tags, cat);
    }

    // S6: timezone + time coherence. When `start`/`end` are provided, the
    // caller supplies an ISO-8601 datetime with offset — trust the offset,
    // store as UTC. When only `timezone` changes, preserve the wall-clock
    // time (7pm NY → 7pm Chicago, not the UTC instant) by decomposing in
    // the OLD tz and recomposing in the NEW tz.
    if (data.start !== undefined || data.end !== undefined || data.timezone !== undefined) {
      const oldTz = (existing.event_timezone as string) || 'America/New_York';
      const newTz = data.timezone || oldTz;
      if (data.timezone !== undefined) dbUpdate.event_timezone = newTz;

      if (data.start !== undefined) {
        dbUpdate.event_at = new Date(data.start).toISOString();
      } else if (data.timezone !== undefined && existing.event_at) {
        const { date, time } = fromTimestamptz(existing.event_at as string, oldTz);
        dbUpdate.event_at = toTimestamptz(date, time, newTz);
      }

      if (data.end !== undefined) {
        dbUpdate.end_time = data.end ? new Date(data.end).toISOString() : null;
      } else if (data.timezone !== undefined && existing.end_time) {
        const { date, time } = fromTimestamptz(existing.end_time as string, oldTz);
        dbUpdate.end_time = toTimestamptz(date, time, newTz);
      }
    }

    if (Object.keys(dbUpdate).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    const { data: updated, error } = await supabaseAdmin
      .from('events')
      .update(dbUpdate)
      .eq('id', req.params.id)
      .select(PORTAL_SELECT)
      .single();

    if (error) throw createError('Failed to update event', 500, 'SERVER_ERROR');

    // Dispatch webhook when event transitions to published (e.g. approved from pending_review)
    if (data.status === 'published' && !wasPublished) {
      dispatchEventWebhookById('event.created', updated.id);
    }

    res.json({ event: toPortalEvent(updated) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /service/events/:id/organizer
//
// Re-attribute an event to a different organization. Under v2's
// constrained-publishing model, only organizations may organize events
// (the Person primitive is gone). Auth: caller must be linked to the
// event's current organizer (or admin). The target org must exist and be
// linked to the caller (so handoff can't conjure events for orgs you
// don't control).
// ---------------------------------------------------------------------------

export const assignOrganizerSchema = z.object({
  organizerOrganizationId: z.string().uuid(),
});

router.patch('/events/:id/organizer', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const body = validateRequest(assignOrganizerSchema, req.body);

    const { data: event } = await supabaseAdmin
      .from('events')
      .select('id, organizer_org_id, source_method')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!event) throw createError('Event not found', 404, 'NOT_FOUND');

    // Auth: caller must be linked to the CURRENT organizer (or admin /
    // witness-authority on witnessed events). assertLinkedEvent enforces
    // this disjunction.
    await assertLinkedEvent(req, req.params.id);

    // Verify the target organization exists.
    const { data: org } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('id', body.organizerOrganizationId)
      .maybeSingle();
    if (!org) throw createError('Organization not found', 404, 'NOT_FOUND');

    // Caller must also be linked to the target organization. Re-attribution
    // can't conjure events for an org the caller doesn't control. Admin
    // bypass applies via assertLinkedOrganization.
    await assertLinkedOrganization(req, body.organizerOrganizationId);

    const { data: updated, error } = await supabaseAdmin
      .from('events')
      .update({ organizer_org_id: body.organizerOrganizationId })
      .eq('id', req.params.id)
      .select(PORTAL_SELECT)
      .single();

    if (error) {
      console.error('[SERVICE] Assign organizer error:', error.message);
      throw createError('Failed to assign organizer', 500, 'SERVER_ERROR');
    }

    // Organizer change is a meaningful metadata update — notify subscribers.
    dispatchEventWebhookById('event.updated', updated.id);

    res.json({ event: toPortalEvent(updated) });
  } catch (err) {
    next(err);
  }
});

/** DELETE /service/events/:id — Delete event (organizer-scoped) */
router.delete('/events/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    await assertLinkedEvent(req, req.params.id);

    const { error } = await supabaseAdmin
      .from('events')
      .delete()
      .eq('id', req.params.id);

    if (error) throw createError('Failed to delete event', 500, 'SERVER_ERROR');
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

export default router;
