/**
 * Service API — Events
 *
 * Single-event CRUD (list, get, create, patch, delete) and batch update.
 * Series operations (patch/delete across all future instances) live in
 * service/series.ts; event↔group linking lives in service/groups.ts.
 *
 * Auth: all routes inherit requireServiceApiKey from service/index.ts.
 * Scoping: mutations require the calling key to be linked to the event's
 * owner account (via assertLinkedEvent). Admin keys bypass this check.
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
import { assertLinkedAccount, assertLinkedEvent } from './helpers.js';

/**
 * Compute first_party for a service-created event. The flag is true iff
 * the event's organizer (the org owned by the linked portal account) has
 * an active verified identifier at insert time. Until verifications start
 * landing, every service-created event is public-facts.
 */
async function computeServiceEventFirstParty(portalAccountId: string): Promise<boolean> {
  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('id')
    .eq('owner_account_id', portalAccountId)
    .maybeSingle();
  if (!org) return false;
  return isFirstPartyByOrganizer(org.id as string);
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
// off the linked account's business_name. Omitted → contributor falls
// back to the legacy source_publisher-on-api derivation in
// event-transform.ts.
const contributorSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  url: z.preprocess(
    (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    z.string().url().max(2000).optional().or(z.literal('')),
  ),
});

export const createEventSchema = z.object({
  account_id: z.string().uuid(),
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
  // source_method is NOT caller-overridable — hardcoded to 'api' on the Service path.
  // source_publisher is NOT caller-overridable — derived from the linked account's business_name.
  // first_party is NOT caller-overridable — computed server-side at insert time
  // from the organizer's verification state (the flag means "posted by a
  // verified business," and that's a fact about the system, not a claim
  // the caller can self-issue).
  // contributor IS caller-overridable (migration 062) — per-event "who ran this"
  // attribution, distinct from the subscribable publisher. Optional.
  contributor: contributorSchema.optional(),
  venue_id: z.string().uuid().optional(),
  external_id: z.string().max(500).optional(),
  tmdb_id: z.string().max(50).optional(),
});

export const updateEventSchema = z.object({
  account_id: z.string().uuid().optional(),
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
  // Pass `contributor: null` to clear an existing override and fall back to
  // the legacy source_publisher-on-api derivation.
  contributor: contributorSchema.nullable().optional(),
  // first_party is computed server-side at insert from the organizer's
  // verification state. Not a writable PATCH input — the only legitimate
  // way to change it post-insert is to recompute (which a future endpoint
  // can expose if needed; for now, recreate the event).
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
      source_method: 'api',
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
      .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name, email)`, { count: 'exact' })
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
      pe.portal_accounts = e.portal_accounts;
      return pe;
    });

    res.json({ events: result, total: count || 0 });
  } catch (err) {
    next(err);
  }
});

/** GET /service/events/:id — Single event with account */
router.get('/events/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');

    const { data: event, error } = await supabaseAdmin
      .from('events')
      .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(id, email, business_name, status)`)
      .eq('id', req.params.id)
      .maybeSingle();

    if (error || !event) throw createError('Event not found', 404, 'NOT_FOUND');
    res.json({ event: toPortalEvent(event), account: event.portal_accounts || null });
  } catch (err) {
    next(err);
  }
});

/** POST /service/events — Create event (scoped to linked accounts) */
router.post('/events', serviceLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(createEventSchema, req.body);
    await assertLinkedAccount(req, data.account_id);

    // Verify account exists and fetch its venue coordinates
    const { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, auth_user_id, claimed_at, business_name, default_address, default_latitude, default_longitude')
      .eq('id', data.account_id)
      .maybeSingle();

    if (!account) throw createError('Account not found', 404, 'NOT_FOUND');

    // Photo eligibility — only claimed accounts may contribute media bytes,
    // where "claimed" means either (a) Supabase Auth claim (`auth_user_id`)
    // or (b) service-key claim via /accounts/link or atomic activation
    // (`claimed_at` is set). Synthetic/scraper-created accounts — neither
    // signal present — cannot contribute images by design. Phase 2 may
    // tighten this further to require verified-business accounts for events
    // whose organizer is a business. See docs/consumer-guide.md "Copyright
    // and image rights" for the contributor-warranty model that backs this.
    if (data.image_url && !account.auth_user_id && !account.claimed_at) {
      throw createError(
        'Photos may only be contributed by claimed accounts',
        403,
        'IMAGE_NOT_PERMITTED',
      );
    }

    const adminUserId = account.auth_user_id || getAdminUserId();
    const validatedTags = data.tags ? validateTags(data.tags, data.category) : [];

    const { portal, event_date: eventDate, start_time: startTime, end_time: endTime }
      = friendlyToPortalInput(data, (account.business_name as string | null) ?? null);
    portal.tags = validatedTags;
    // first_party is server-computed at insert from the organizer's
    // verification state. Today this is false for every account (no orgs
    // verified yet); once an org's verified identifier lands, future
    // events from that account flip to true automatically.
    portal.first_party = await computeServiceEventFirstParty(data.account_id);

    const insert = portalInputToInsert(portal, data.account_id, adminUserId);

    // Resolve coordinates: explicit > venue account > geocode
    let lat = data.location.lat ?? null;
    let lng = data.location.lng ?? null;
    const address = data.location.address;

    // If no explicit coordinates, inherit from venue account when address matches
    if (lat == null && lng == null && account.default_latitude != null && account.default_longitude != null) {
      const eventAddr = (address || '').toLowerCase().trim();
      const venueAddr = (account.default_address || '').toLowerCase().trim();
      // Use venue coords if: no event address, or event address matches venue address
      if (!eventAddr || !venueAddr || eventAddr === venueAddr) {
        lat = account.default_latitude;
        lng = account.default_longitude;
        insert.latitude = lat;
        insert.longitude = lng;
        insert.approximate_location = `POINT(${lng} ${lat})`;
        console.log(`[SERVICE] Using venue account coordinates for "${data.name}": ${lat}, ${lng}`);
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
    // Scoping: verify all events belong to linked accounts
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

/** PATCH /service/events/:id — Update single event (scoped) */
router.patch('/events/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    await assertLinkedEvent(req, req.params.id);
    const data = validateRequest(updateEventSchema, req.body);

    // Fetch existing event — include event_at/end_time so we can preserve
    // wall-clock semantics on a timezone-only PATCH (S6).
    const { data: existing } = await supabaseAdmin
      .from('events')
      .select('id, status, event_timezone, event_at, end_time, creator_account_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!existing) throw createError('Event not found', 404, 'NOT_FOUND');

    const wasPublished = existing.status === 'published';
    const dbUpdate: Record<string, unknown> = {};

    // Reassign event to a different account (for merging duplicates)
    if (data.account_id !== undefined) {
      const { data: newAccount } = await supabaseAdmin
        .from('portal_accounts')
        .select('id')
        .eq('id', data.account_id)
        .maybeSingle();
      if (!newAccount) throw createError('Target account not found', 404, 'NOT_FOUND');
      dbUpdate.creator_account_id = data.account_id;
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
// Assign or clear the organizer of an event. Organizer is exactly one of an
// Organization or a Person; mutual exclusivity is enforced at the route.
//
// Auth disjunction (non-admin keys):
//   1. Caller's key is linked to event.creator_account_id, OR
//   2. Event currently has organizer_org_id and caller's key is linked to it.
//
// The first arm covers the first-set case (event just created, organizer is
// NULL — only the creator can assign the initial organizer). The second arm
// covers re-attribution by the current organizer. When the current organizer
// is a Person, only admin keys can re-assign until person-link semantics ship.
// ---------------------------------------------------------------------------

export const assignOrganizerSchema = z
  .object({
    organizerOrganizationId: z.string().uuid().nullable().optional(),
    organizerPersonId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (d) => !(d.organizerOrganizationId != null && d.organizerPersonId != null),
    {
      message: 'organizerOrganizationId and organizerPersonId are mutually exclusive — provide at most one non-null value',
      path: ['organizerOrganizationId'],
    },
  );

router.patch('/events/:id/organizer', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const body = validateRequest(assignOrganizerSchema, req.body);

    const { data: event } = await supabaseAdmin
      .from('events')
      .select('id, creator_account_id, organizer_org_id, organizer_person_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!event) throw createError('Event not found', 404, 'NOT_FOUND');

    // Auth disjunction. Admin keys bypass entirely.
    if (!req.apiKeyInfo?.isAdmin) {
      const keyId = req.apiKeyInfo!.id;
      let authorized = false;

      // Arm 1: caller linked to event's creator account.
      if (event.creator_account_id) {
        const { data: accLink } = await supabaseAdmin
          .from('api_key_account_links')
          .select('portal_account_id')
          .eq('api_key_id', keyId)
          .eq('portal_account_id', event.creator_account_id)
          .maybeSingle();
        if (accLink) authorized = true;
      }

      // Arm 2: caller linked to event's current organizer org.
      if (!authorized && event.organizer_org_id) {
        const { data: orgLink } = await supabaseAdmin
          .from('api_key_organization_links')
          .select('organization_id')
          .eq('api_key_id', keyId)
          .eq('organization_id', event.organizer_org_id)
          .maybeSingle();
        if (orgLink) authorized = true;
      }

      // Person organizers: no person-link semantics yet, admin-only re-assign.
      if (!authorized) {
        throw createError(
          'This API key is not linked to the event\'s creator account or current organizer. Use POST /accounts/link or POST /organizations/link first.',
          403,
          'NOT_LINKED',
        );
      }
    }

    // Verify target organization exists if non-null.
    if (body.organizerOrganizationId) {
      const { data: org } = await supabaseAdmin
        .from('organizations')
        .select('id')
        .eq('id', body.organizerOrganizationId)
        .maybeSingle();
      if (!org) throw createError('Organization not found', 404, 'NOT_FOUND');
    }

    // Verify target person exists if non-null.
    if (body.organizerPersonId) {
      const { data: person } = await supabaseAdmin
        .from('persons')
        .select('id')
        .eq('id', body.organizerPersonId)
        .maybeSingle();
      if (!person) throw createError('Person not found', 404, 'NOT_FOUND');
    }

    // Build update — only touch fields explicitly present in the body, so a
    // caller that sends only organizerOrganizationId doesn't accidentally clear
    // organizer_person_id (and vice versa). Mutual-exclusivity guarantees we
    // can't end up with both non-null after this.
    const dbUpdate: Record<string, unknown> = {};
    if (body.organizerOrganizationId !== undefined) {
      dbUpdate.organizer_org_id = body.organizerOrganizationId;
      // Clear the other side when setting this one to satisfy app-layer XOR.
      if (body.organizerOrganizationId !== null) dbUpdate.organizer_person_id = null;
    }
    if (body.organizerPersonId !== undefined) {
      dbUpdate.organizer_person_id = body.organizerPersonId;
      if (body.organizerPersonId !== null) dbUpdate.organizer_org_id = null;
    }

    if (Object.keys(dbUpdate).length === 0) {
      throw createError('No organizer fields provided', 400, 'VALIDATION_ERROR');
    }

    const { data: updated, error } = await supabaseAdmin
      .from('events')
      .update(dbUpdate)
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

/** DELETE /service/events/:id — Delete event (scoped) */
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
