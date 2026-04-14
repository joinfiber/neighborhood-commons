/**
 * Service API — Neighborhood Commons
 *
 * Full CRUD for accounts and events via service-tier API keys.
 * Enables external admin tools to manage the commons dataset
 * without Supabase JWT auth. Any trusted operator can build
 * their own admin tool against these endpoints.
 *
 * Auth: X-API-Key header with contributor_tier='service'
 * Base: /api/v1/service
 */

import { Router, json as expressJson } from 'express';
import { z } from 'zod';
import { EVENT_CATEGORY_KEYS } from '../lib/categories.js';
import { validateTags } from '../lib/tags.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, validateUuidParam, resolveEventImageUrl, sanitizeSearchInput } from '../lib/helpers.js';
import { requireServiceApiKey } from '../middleware/api-key.js';
import { dispatchWebhooks } from '../lib/webhook-delivery.js';
import { toNeighborhoodEvent, type PortalEventRow } from '../lib/event-transform.js';
import { serviceLimiter } from '../middleware/rate-limit.js';
import {
  PORTAL_SELECT, MANAGED_SOURCES, toPortalEvent, portalInputToInsert,
  fromTimestamptz, getAdminUserId,
} from '../lib/event-operations.js';
import { createEventSeries, deleteSeriesEvents, updateSeriesFutureInstances } from '../lib/event-series.js';
import { processAndUploadImage, downloadAndAttachImage } from '../lib/image-processing.js';
import { validateFeedUrl } from '../lib/url-validation.js';
import { invalidateApprovedDomainsCache } from '../lib/url-sanitizer.js';
import { nominatimGeocode } from '../lib/geocoding.js';
import { config } from '../config.js';

/** Per-route body limit override for image uploads (12MB vs global 5MB) */
const imageBodyLimit = expressJson({ limit: '12mb' });

const router: ReturnType<typeof Router> = Router();

// All service routes require a service-tier API key
router.use(requireServiceApiKey);

// =============================================================================
// SCOPED ACCESS — Service keys can only modify data for linked accounts
// =============================================================================

import type { Request } from 'express';

/**
 * Assert that the calling service key is linked to the target portal account.
 * Admin keys (is_admin=true) bypass this check — they have full access.
 * Read endpoints don't call this — public data is readable by any key.
 */
async function assertLinkedAccount(req: Request, accountId: string): Promise<void> {
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
 * Assert that the calling service key is linked to the account that owns the given event.
 */
async function assertLinkedEvent(req: Request, eventId: string): Promise<string> {
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

// =============================================================================
// ACCOUNTS
// =============================================================================

const createAccountSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
  business_name: z.string().min(1).max(200),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(500).optional().or(z.literal('')),
  default_venue_name: z.string().max(200).optional(),
  default_place_id: z.string().max(500).optional(),
  default_address: z.string().max(500).optional(),
  default_latitude: z.number().min(-90).max(90).optional(),
  default_longitude: z.number().min(-180).max(180).optional(),
  operating_hours: z.array(z.object({
    open: z.boolean(),
    ranges: z.array(z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    })),
  })).length(7).optional(),
});

const updateAccountSchema = z.object({
  business_name: z.string().min(1).max(200).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(500).optional().or(z.literal('')),
  default_venue_name: z.string().max(200).optional(),
  default_place_id: z.string().max(500).optional(),
  default_address: z.string().max(500).optional(),
  default_latitude: z.number().min(-90).max(90).optional(),
  default_longitude: z.number().min(-180).max(180).optional(),
  operating_hours: z.array(z.object({
    open: z.boolean(),
    ranges: z.array(z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    })),
  })).length(7).optional(),
  status: z.enum(['active', 'suspended', 'pending', 'rejected']).optional(),
  logo_url: z.string().url().max(2000).optional().or(z.literal('')).or(z.null()),
  cover_image_url: z.string().url().max(2000).optional().or(z.literal('')).or(z.null()),
  description: z.string().max(2000).optional().or(z.literal('')).or(z.null()),
});

// =============================================================================
// ACCOUNT LINKING — Consumer apps link their users to portal accounts
// =============================================================================

const linkAccountSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
  business_name: z.string().min(1).max(200),
  claimed_by: z.string().max(50).optional(),
});

/**
 * POST /service/accounts/link
 * Find-or-create a portal account by email and link it to the calling service key.
 * This is how consumer apps (Merrie, etc.) establish a relationship with a venue operator.
 */
router.post('/accounts/link', serviceLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(linkAccountSchema, req.body);
    const apiKeyId = req.apiKeyInfo!.id;
    let created = false;
    let linked = false;

    // 1. Look up existing account by email
    let { data: account } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, email, business_name, status, claimed_at, claimed_by, slug, created_at, updated_at')
      .ilike('email', data.email)
      .maybeSingle();

    // 2. Create if not found
    if (!account) {
      const { data: newAccount, error: createError_ } = await supabaseAdmin
        .from('portal_accounts')
        .insert({
          email: data.email,
          business_name: data.business_name,
          status: 'active',
        })
        .select('id, email, business_name, status, claimed_at, claimed_by, slug, created_at, updated_at')
        .single();

      if (createError_) {
        if (createError_.code === '23505') {
          // Race condition: account was created between our check and insert
          const { data: raceAccount } = await supabaseAdmin
            .from('portal_accounts')
            .select('id, email, business_name, status, claimed_at, claimed_by, slug, created_at, updated_at')
            .ilike('email', data.email)
            .single();
          account = raceAccount;
        } else {
          console.error('[SERVICE] Account link create error:', createError_.message);
          throw createError('Failed to create account', 500, 'SERVER_ERROR');
        }
      } else {
        account = newAccount;
        created = true;
      }
    }

    if (!account) throw createError('Failed to resolve account', 500, 'SERVER_ERROR');

    // 3. Link the service key to this account (upsert)
    const { error: linkError } = await supabaseAdmin
      .from('api_key_account_links')
      .upsert(
        { api_key_id: apiKeyId, portal_account_id: account.id },
        { onConflict: 'api_key_id,portal_account_id' },
      );

    if (linkError) {
      console.error('[SERVICE] Account link error:', linkError.message);
    } else {
      linked = true;
    }

    // 4. Mark as claimed if not already
    if (!account.claimed_at) {
      const claimedBy = data.claimed_by || 'api';
      await supabaseAdmin
        .from('portal_accounts')
        .update({ claimed_at: new Date().toISOString(), claimed_by: claimedBy })
        .eq('id', account.id);
      account = { ...account, claimed_at: new Date().toISOString(), claimed_by: claimedBy };
    }

    console.log(`[SERVICE] Account linked: ${account.email} → key ${apiKeyId.slice(0, 8)}... (created=${created})`);
    res.status(created ? 201 : 200).json({ account, created, linked });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// ACCOUNT CRUD
// =============================================================================

/** GET /service/accounts — List accounts with event counts, optional search + pagination */
const listAccountsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  email: z.string().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(500),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

router.get('/accounts', serviceLimiter, async (req, res, next) => {
  try {
    const { search, email, limit, offset } = validateRequest(listAccountsQuerySchema, req.query);

    let query = supabaseAdmin
      .from('portal_accounts')
      .select('id, email, business_name, auth_user_id, status, claimed_at, claimed_by, default_venue_name, default_place_id, default_address, default_latitude, default_longitude, website, phone, operating_hours, logo_url, cover_image_url, description, last_login_at, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false });

    // Exact email lookup (case-insensitive)
    if (email) {
      query = query.ilike('email', email.toLowerCase().trim());
    }

    if (search) {
      const sanitized = sanitizeSearchInput(search);
      if (sanitized) {
        query = query.or(`business_name.ilike.%${sanitized}%,default_address.ilike.%${sanitized}%`);
      }
    }

    query = query.range(offset, offset + limit - 1);

    const { data: accounts, error, count } = await query;

    if (error) throw createError('Failed to fetch accounts', 500, 'SERVER_ERROR');

    // Count unique events per account
    const accountIds = (accounts || []).map((a: { id: string }) => a.id);
    let eventCounts: Record<string, number> = {};
    if (accountIds.length > 0) {
      const { data: counts } = await supabaseAdmin
        .from('events')
        .select('creator_account_id, series_id, series_instance_number')
        .in('source', [...MANAGED_SOURCES])
        .in('creator_account_id', accountIds)
        .limit(10000);

      if (counts) {
        eventCounts = counts.reduce((acc: Record<string, number>, row: { creator_account_id: string; series_id: string | null; series_instance_number: number | null }) => {
          // Count one-offs (no series_id) and one representative per series.
          // Instance 0 = ongoing series, instance 1 = first of a bounded series,
          // null = older events (treat as representative). Skip instances 2+.
          if (row.series_id && row.series_instance_number != null && row.series_instance_number > 1) return acc;
          acc[row.creator_account_id] = (acc[row.creator_account_id] || 0) + 1;
          return acc;
        }, {});
      }
    }

    const result = (accounts || []).map((a: { id: string }) => ({
      ...a,
      event_count: eventCounts[a.id] || 0,
    }));

    res.json({ accounts: result, total: count ?? result.length });
  } catch (err) {
    next(err);
  }
});

/** GET /service/accounts/:id — Single account with events */
router.get('/accounts/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, email, business_name, auth_user_id, status, default_venue_name, default_place_id, default_address, default_latitude, default_longitude, website, phone, operating_hours, last_login_at, claimed_at, created_at, updated_at')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error || !account) throw createError('Account not found', 404, 'NOT_FOUND');

    // Fetch unique events only (one-offs + first instance of each series)
    // and limit to a reasonable page size. Past events are rarely needed in this view.
    const { data: events } = await supabaseAdmin
      .from('events')
      .select(PORTAL_SELECT)
      .eq('creator_account_id', account.id)
      .in('source', [...MANAGED_SOURCES])
      .or('series_id.is.null,series_instance_number.eq.0,series_instance_number.eq.1')
      .order('event_at', { ascending: false })
      .limit(200);

    res.json({ account, events: (events || []).map(toPortalEvent) });
  } catch (err) {
    next(err);
  }
});

/** POST /service/accounts — Create account */
router.post('/accounts', serviceLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(createAccountSchema, req.body);

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .insert({
        email: data.email,
        business_name: data.business_name,
        phone: data.phone || null,
        website: data.website || null,
        default_venue_name: data.default_venue_name || null,
        default_place_id: data.default_place_id || null,
        default_address: data.default_address || null,
        default_latitude: data.default_latitude ?? null,
        default_longitude: data.default_longitude ?? null,
        operating_hours: data.operating_hours ?? null,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') throw createError('Account with this email already exists', 409, 'CONFLICT');
      console.error('[SERVICE] Create account error:', error.message);
      throw createError('Failed to create account', 500, 'SERVER_ERROR');
    }

    console.log(`[SERVICE] Account created: ${account.business_name}`);
    res.status(201).json({ account });
  } catch (err) {
    next(err);
  }
});

/** PATCH /service/accounts/:id — Update account (scoped to linked accounts) */
router.patch('/accounts/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    await assertLinkedAccount(req, req.params.id);
    const data = validateRequest(updateAccountSchema, req.body);

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) update[key] = value ?? null;
    }

    if (Object.keys(update).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .update(update)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw createError('Failed to update account', 500, 'SERVER_ERROR');

    // Propagate coordinate changes to all events owned by this account
    const coordsChanged = update.default_latitude !== undefined || update.default_longitude !== undefined;
    let eventsUpdated = 0;
    if (coordsChanged) {
      const newLat = account.default_latitude as number | null;
      const newLng = account.default_longitude as number | null;
      console.log(`[SERVICE] Coord change detected for ${account.business_name}: lat=${newLat}, lng=${newLng}`);

      const eventUpdate: Record<string, unknown> = {
        latitude: newLat,
        longitude: newLng,
      };

      // Only set approximate_location if we have valid coordinates
      if (newLat != null && newLng != null) {
        eventUpdate.approximate_location = `POINT(${newLng} ${newLat})`;
      }

      // Re-resolve region from new coordinates
      if (newLat != null && newLng != null) {
        const { data: regionData, error: regionError } = await supabaseAdmin.rpc('find_user_region', {
          p_longitude: newLng,
          p_latitude: newLat,
        });
        if (regionError) {
          console.error(`[SERVICE] Region resolution failed:`, regionError.message);
        } else if (regionData && regionData.length > 0) {
          eventUpdate.region_id = regionData[0].region_id;
          console.log(`[SERVICE] Account region re-resolved: ${regionData[0].region_name}`);
        }
      }

      // Fetch affected event IDs (all events owned by this account)
      const { data: affectedEvents, error: fetchError } = await supabaseAdmin
        .from('events')
        .select('id')
        .eq('creator_account_id', req.params.id);

      if (fetchError) {
        console.error(`[SERVICE] Failed to fetch events for propagation:`, fetchError.message);
      }

      const affectedIds = (affectedEvents || []).map((e) => e.id);
      console.log(`[SERVICE] Found ${affectedIds.length} events to update for account ${req.params.id}`);

      if (affectedIds.length > 0) {
        console.log(`[SERVICE] Updating events with:`, JSON.stringify(eventUpdate));
        const { data: updated, error: updateError } = await supabaseAdmin
          .from('events')
          .update(eventUpdate)
          .in('id', affectedIds)
          .select('id');

        if (updateError) {
          console.error(`[SERVICE] Event coordinate propagation FAILED:`, updateError.message, updateError.details, updateError.hint);
        } else {
          eventsUpdated = updated?.length || 0;
          console.log(`[SERVICE] Propagated coordinates to ${eventsUpdated} events for account ${account.business_name}`);
        }

        // Fire event.updated webhooks (fire-and-forget)
        if (eventsUpdated > 0) {
          void (async () => {
            try {
              for (const eventId of affectedIds) {
                const { data: row } = await supabaseAdmin
                  .from('events')
                  .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
                  .eq('id', eventId)
                  .maybeSingle();
                if (row) void dispatchWebhooks('event.updated', eventId, toNeighborhoodEvent(row as unknown as PortalEventRow));
              }
            } catch (err) {
              console.error('[SERVICE] Webhook dispatch error during coord propagation:', err instanceof Error ? err.message : err);
            }
          })();
        }
      }
    }

    res.json({ account, ...(coordsChanged ? { events_updated: eventsUpdated } : {}) });
  } catch (err) {
    next(err);
  }
});

/** DELETE /service/accounts/:id — Delete account and all its events (scoped) */
router.delete('/accounts/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    await assertLinkedAccount(req, req.params.id);

    // Delete all events owned by this account first
    await supabaseAdmin
      .from('events')
      .delete()
      .eq('creator_account_id', req.params.id);

    // Delete the account
    const { error } = await supabaseAdmin
      .from('portal_accounts')
      .delete()
      .eq('id', req.params.id);

    if (error) throw createError('Failed to delete account', 500, 'SERVER_ERROR');

    console.log(`[SERVICE] Account deleted: ${req.params.id}`);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// EVENTS
// =============================================================================

// Friendly-shape Service API input — symmetric with the read schema.
// See public/openapi.json #/components/schemas/ServiceEventInput (authoritative).
// Internal DB columns are translated from this shape by friendlyToPortalInput().
const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

const locationSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  address: z.string().max(500).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  place_id: z.string().max(500).optional(),
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
  source_method: z.enum(['manual', 'auto']).optional(),
  source_publisher: z.string().max(100).optional(),
  first_party: z.boolean().optional(),
  venue_id: z.string().uuid().optional(),
  external_id: z.string().max(500).optional(),
});

const updateEventSchema = z.object({
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
  first_party: z.boolean().optional(),
  status: z.enum(['published', 'pending_review', 'suspended', 'unpublished']).optional(),
});

type CreateEventInput = z.infer<typeof createEventSchema>;

/**
 * Decompose a friendly-shape Service input into the portal-style fields
 * `portalInputToInsert` expects. DB columns are internal; wire shape is friendly.
 */
function friendlyToPortalInput(data: CreateEventInput): {
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
      source_method: data.source_method,
      source_publisher: data.source_publisher,
      first_party: data.first_party,
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
      .select('id, auth_user_id, default_address, default_latitude, default_longitude')
      .eq('id', data.account_id)
      .maybeSingle();

    if (!account) throw createError('Account not found', 404, 'NOT_FOUND');

    const adminUserId = account.auth_user_id || getAdminUserId();
    const validatedTags = data.tags ? validateTags(data.tags, data.category) : [];

    const { portal, event_date: eventDate, start_time: startTime, end_time: endTime }
      = friendlyToPortalInput(data);
    portal.tags = validatedTags;

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
      void (async () => {
        try {
          const { data: row } = await supabaseAdmin
            .from('events')
            .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
            .eq('id', event.id)
            .maybeSingle();
          if (row) void dispatchWebhooks('event.created', event.id, toNeighborhoodEvent(row as unknown as PortalEventRow));
        } catch (err) {
          console.error('[SERVICE] Webhook dispatch error:', err instanceof Error ? err.message : err);
        }
      })();

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
        first_party: z.boolean().optional(),
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

    // Fetch existing event
    const { data: existing } = await supabaseAdmin
      .from('events')
      .select('id, status, event_timezone, creator_account_id')
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
    if (data.timezone !== undefined) dbUpdate.event_timezone = data.timezone;
    if (data.wheelchair_accessible !== undefined) dbUpdate.wheelchair_accessible = data.wheelchair_accessible;
    if (data.capacity !== undefined) dbUpdate.capacity = data.capacity;
    if (data.rsvp !== undefined) dbUpdate.rsvp = data.rsvp;
    if (data.open_window !== undefined) dbUpdate.open_window = data.open_window;
    if (data.first_party !== undefined) dbUpdate.first_party = data.first_party;
    if (data.image_focal_y !== undefined) dbUpdate.event_image_focal_y = data.image_focal_y;

    if (data.tags !== undefined) {
      const cat = data.category || 'community';
      dbUpdate.tags = validateTags(data.tags, cat);
    }

    if (data.start !== undefined) {
      dbUpdate.event_at = new Date(data.start).toISOString();
    }
    if (data.end !== undefined) {
      dbUpdate.end_time = data.end ? new Date(data.end).toISOString() : null;
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
      (async () => {
        try {
          const { data: row } = await supabaseAdmin
            .from('events')
            .select(`*, portal_accounts!events_creator_account_id_fkey(business_name)`)
            .eq('id', updated.id)
            .maybeSingle();
          if (row) void dispatchWebhooks('event.created', updated.id, toNeighborhoodEvent(row as unknown as PortalEventRow));
        } catch (err) {
          console.error('[SERVICE] Webhook dispatch error:', err instanceof Error ? err.message : err);
        }
      })();
    }

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

/**
 * PATCH /service/events/series/:seriesId — Update all future instances of a series (scoped).
 *
 * Template-first: the edit is applied unconditionally to every future instance
 * AND to base_event_data so newly-materialized instances (from the auto-extend
 * cron) also inherit it. Past instances are preserved.
 */
router.patch('/events/series/:seriesId', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.seriesId, 'series ID');
    const data = validateRequest(updateEventSchema.extend({
      instance_count: z.number().int().min(0).max(52).optional(),
    }), req.body);

    // Ownership: non-admin keys must be linked to the creator_account_id of the series.
    const { data: sample } = await supabaseAdmin
      .from('events')
      .select('id, creator_account_id, event_timezone')
      .eq('series_id', req.params.seriesId)
      .limit(1)
      .maybeSingle();
    if (!sample) throw createError('Series not found', 404, 'NOT_FOUND');
    if (!req.apiKeyInfo?.isAdmin) {
      if (!sample.creator_account_id) throw createError('Series has no owner; admin access required', 403, 'FORBIDDEN');
      await assertLinkedAccount(req, sample.creator_account_id);
    }

    const tz = data.timezone || (sample.event_timezone as string) || 'America/New_York';

    const templateUpdate: Record<string, unknown> = {};
    if (data.name !== undefined) templateUpdate.content = data.name;
    if (data.location?.name !== undefined) templateUpdate.place_name = data.location.name;
    if (data.location?.address !== undefined) templateUpdate.venue_address = data.location.address;
    if (data.location?.place_id !== undefined) templateUpdate.place_id = data.location.place_id;
    if (data.location?.lat !== undefined) templateUpdate.latitude = data.location.lat;
    if (data.location?.lng !== undefined) templateUpdate.longitude = data.location.lng;
    if (data.location?.lat !== undefined || data.location?.lng !== undefined) {
      const lat = data.location?.lat ?? null;
      const lng = data.location?.lng ?? null;
      templateUpdate.approximate_location = lat != null && lng != null ? `POINT(${lng} ${lat})` : null;
    }
    if (data.description !== undefined) templateUpdate.description = data.description;
    if (data.cost !== undefined) templateUpdate.price = data.cost;
    if (data.url !== undefined) templateUpdate.link_url = data.url || null;
    if (data.category !== undefined) templateUpdate.category = data.category;
    if (data.custom_category !== undefined) templateUpdate.custom_category = data.custom_category;
    if (data.timezone !== undefined) templateUpdate.event_timezone = data.timezone;
    if (data.wheelchair_accessible !== undefined) templateUpdate.wheelchair_accessible = data.wheelchair_accessible;
    if (data.capacity !== undefined) templateUpdate.capacity = data.capacity;
    if (data.rsvp !== undefined) templateUpdate.rsvp = data.rsvp;
    if (data.open_window !== undefined) templateUpdate.open_window = data.open_window;
    if (data.image_focal_y !== undefined) templateUpdate.event_image_focal_y = data.image_focal_y;
    if (data.tags !== undefined) {
      const cat = data.category || 'community';
      templateUpdate.tags = validateTags(data.tags, cat);
    }

    // Decompose start/end (ISO 8601) into HH:MM in the series timezone for createEventSeries helpers.
    const newStartTime = data.start ? fromTimestamptz(data.start, tz).time : undefined;
    const newEndTime = data.end === null ? null
      : data.end ? fromTimestamptz(data.end, tz).time
      : undefined;
    const hasTimeChange = newStartTime !== undefined || newEndTime !== undefined;
    const timeChange = hasTimeChange
      ? { startTime: newStartTime, endTime: newEndTime ?? null }
      : undefined;
    const hasInstanceCountChange = data.instance_count !== undefined;

    if (Object.keys(templateUpdate).length === 0 && !hasTimeChange && !hasInstanceCountChange) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const result = await updateSeriesFutureInstances({
      seriesId: req.params.seriesId,
      updates: templateUpdate,
      timeChange,
      instanceCountChange: hasInstanceCountChange ? data.instance_count : undefined,
      timezone: tz,
    });

    void (async () => {
      try {
        for (const id of result.updatedIds) {
          const { data: row } = await supabaseAdmin
            .from('events')
            .select(`${PORTAL_SELECT}, portal_accounts!events_creator_account_id_fkey(business_name)`)
            .eq('id', id)
            .maybeSingle();
          if (row && (row as Record<string, unknown>).status === 'published') {
            void dispatchWebhooks('event.updated', id, toNeighborhoodEvent(row as unknown as PortalEventRow));
          }
        }
      } catch (err) {
        console.error('[SERVICE] Series webhook dispatch error:', err instanceof Error ? err.message : err);
      }
    })();

    console.log(`[SERVICE] Series ${req.params.seriesId} updated: ${result.updatedCount} future instances`);
    res.json({
      series_id: req.params.seriesId,
      updated: result.updatedCount,
      total: result.totalAfter,
      added: result.instancesAdded,
      removed: result.instancesRemoved,
    });
  } catch (err) {
    next(err);
  }
});

/** DELETE /service/events/series/:seriesId — Delete all events in a series (scoped) */
router.delete('/events/series/:seriesId', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.seriesId, 'series ID');
    // Verify ownership via any event in the series
    if (!req.apiKeyInfo?.isAdmin) {
      const { data: sample } = await supabaseAdmin
        .from('events')
        .select('id')
        .eq('series_id', req.params.seriesId)
        .limit(1)
        .maybeSingle();
      if (sample) await assertLinkedEvent(req, sample.id);
    }
    const deleted = await deleteSeriesEvents(req.params.seriesId);
    res.json({ deleted: true, series_id: req.params.seriesId, count: deleted });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /service/events/:id/image — Upload event image
 *
 * Accepts three formats:
 * 1. JSON: { "image": "<base64>" } — legacy, backward compatible
 * 2. JSON: { "image_url": "https://..." } — download from URL (preferred for scraped images)
 * 3. Multipart: form field "file" — standard file upload (preferred for user uploads)
 */
router.post('/events/:id/image', imageBodyLimit, serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    await assertLinkedEvent(req, req.params.id);
    const eventId = req.params.id;

    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
      // Multipart file upload — read raw body chunks with size limit
      const MAX_IMAGE_SIZE = 12 * 1024 * 1024; // 12MB, matching JSON body limit
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalSize += buf.length;
        if (totalSize > MAX_IMAGE_SIZE) {
          throw createError('Image too large (max 12MB)', 413, 'PAYLOAD_TOO_LARGE');
        }
        chunks.push(buf);
      }
      const body = Buffer.concat(chunks);

      // Parse multipart boundary
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) throw createError('Missing multipart boundary', 400, 'VALIDATION_ERROR');

      // Extract the file data between boundaries
      const boundary = boundaryMatch[1];
      const parts = body.toString('binary').split(`--${boundary}`);
      let fileBuffer: Buffer | null = null;

      for (const part of parts) {
        if (part.includes('filename=')) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd >= 0) {
            const fileData = part.slice(headerEnd + 4).replace(/\r\n$/, '');
            fileBuffer = Buffer.from(fileData, 'binary');
          }
        }
      }

      if (!fileBuffer || fileBuffer.length < 8) {
        throw createError('No valid file found in upload', 400, 'VALIDATION_ERROR');
      }

      const base64 = fileBuffer.toString('base64');
      const imageUrl = await processAndUploadImage(eventId, base64);

      await supabaseAdmin.from('events').update({ event_image_url: imageUrl }).eq('id', eventId);
      res.json({ image_url: resolveEventImageUrl(imageUrl, config.apiBaseUrl) });

    } else if (req.body?.image_url) {
      // URL-based: download, process, upload
      const { image_url } = req.body;
      if (typeof image_url !== 'string' || !image_url.startsWith('http')) {
        throw createError('image_url must be a valid HTTP URL', 400, 'VALIDATION_ERROR');
      }

      await downloadAndAttachImage(eventId, image_url);

      // Re-fetch to get the stored URL
      const { data: updated } = await supabaseAdmin
        .from('events')
        .select('event_image_url')
        .eq('id', eventId)
        .maybeSingle();

      res.json({ image_url: resolveEventImageUrl(updated?.event_image_url || '', config.apiBaseUrl) });

    } else if (req.body?.image) {
      // Legacy base64 JSON
      const image = req.body.image as string;
      if (typeof image !== 'string' || image.length < 1) {
        throw createError('image must be a non-empty base64 string', 400, 'VALIDATION_ERROR');
      }

      const imageUrl = await processAndUploadImage(eventId, image);
      await supabaseAdmin.from('events').update({ event_image_url: imageUrl }).eq('id', eventId);
      res.json({ image_url: resolveEventImageUrl(imageUrl, config.apiBaseUrl) });

    } else {
      throw createError('Provide "image" (base64), "image_url" (URL), or a multipart file upload', 400, 'VALIDATION_ERROR');
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /service/accounts/:id/cover-image — Upload account cover image
 * Accepts { "image": "<base64>" } or { "image_url": "https://..." }
 */
router.post('/accounts/:id/cover-image', imageBodyLimit, serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    await assertLinkedAccount(req, req.params.id);
    const accountId = req.params.id;

    if (req.body?.image_url) {
      const { image_url } = req.body;
      if (typeof image_url !== 'string' || !image_url.startsWith('http')) {
        throw createError('image_url must be a valid HTTP URL', 400, 'VALIDATION_ERROR');
      }

      // SSRF protection
      await validateFeedUrl(image_url);

      const response = await fetch(image_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeighborhoodCommons/1.0)' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw createError('Failed to download image', 400, 'VALIDATION_ERROR');

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');
      const imageUrl = await processAndUploadImage(`accounts/${accountId}/cover`, base64);

      await supabaseAdmin.from('portal_accounts').update({ cover_image_url: imageUrl }).eq('id', accountId);
      res.json({ cover_image_url: imageUrl });

    } else if (req.body?.image) {
      const image = req.body.image as string;
      if (typeof image !== 'string' || image.length < 1) {
        throw createError('image must be a non-empty base64 string', 400, 'VALIDATION_ERROR');
      }

      const imageUrl = await processAndUploadImage(`accounts/${accountId}/cover`, image);
      await supabaseAdmin.from('portal_accounts').update({ cover_image_url: imageUrl }).eq('id', accountId);
      res.json({ cover_image_url: imageUrl });

    } else {
      throw createError('Provide "image" (base64) or "image_url" (URL)', 400, 'VALIDATION_ERROR');
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /service/accounts/:id/logo — Upload account logo
 * Same pipeline as cover-image: accepts { "image": "<base64>" } or { "image_url": "https://..." }
 */
router.post('/accounts/:id/logo', imageBodyLimit, serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'account ID');
    await assertLinkedAccount(req, req.params.id);
    const accountId = req.params.id;

    if (req.body?.image_url) {
      const { image_url } = req.body;
      if (typeof image_url !== 'string' || !image_url.startsWith('http')) {
        throw createError('image_url must be a valid HTTP URL', 400, 'VALIDATION_ERROR');
      }

      // SSRF protection
      await validateFeedUrl(image_url);

      const response = await fetch(image_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeighborhoodCommons/1.0)' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw createError('Failed to download image', 400, 'VALIDATION_ERROR');

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');
      const imageUrl = await processAndUploadImage(`accounts/${accountId}/logo`, base64);

      await supabaseAdmin.from('portal_accounts').update({ logo_url: imageUrl }).eq('id', accountId);
      res.json({ logo_url: imageUrl });

    } else if (req.body?.image) {
      const image = req.body.image as string;
      const imageUrl = await processAndUploadImage(`accounts/${accountId}/logo`, image);

      await supabaseAdmin.from('portal_accounts').update({ logo_url: imageUrl }).eq('id', accountId);
      res.json({ logo_url: imageUrl });

    } else {
      throw createError('Provide "image" (base64) or "image_url" (URL)', 400, 'VALIDATION_ERROR');
    }
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// STATS
// =============================================================================

/** GET /service/stats — Platform statistics + category distribution */
router.get('/stats', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    // Run account and event counts in parallel
    const [accountCounts, oneOffCount, seriesCount, categoryRows] = await Promise.all([
      // Account counts: use head:true to avoid fetching rows
      supabaseAdmin.from('portal_accounts').select('id', { count: 'exact', head: true }),

      // One-off events
      supabaseAdmin.from('events')
        .select('id', { count: 'exact', head: true })
        .in('source', [...MANAGED_SOURCES])
        .is('series_id', null),

      // Series (representative instance: 0 = ongoing, 1 = first of bounded)
      supabaseAdmin.from('events')
        .select('id', { count: 'exact', head: true })
        .in('source', [...MANAGED_SOURCES])
        .not('series_id', 'is', null)
        .or('series_instance_number.eq.0,series_instance_number.eq.1'),

      // Category distribution — only fetch unique events (one-offs + first instances)
      // Use minimal select to reduce payload
      supabaseAdmin.from('events')
        .select('category')
        .in('source', [...MANAGED_SOURCES])
        .or('series_id.is.null,series_instance_number.eq.0,series_instance_number.eq.1')
        .limit(10000),
    ]);

    // Account breakdowns need status/claimed_at — separate lightweight query
    const { data: accountStatuses } = await supabaseAdmin
      .from('portal_accounts')
      .select('status, claimed_at')
      .limit(10000);

    const totalAccounts = accountCounts.count || 0;
    const claimedAccounts = accountStatuses?.filter((a) => a.claimed_at).length || 0;
    const pendingAccounts = accountStatuses?.filter((a) => a.status === 'pending').length || 0;

    const totalEvents = (oneOffCount.count || 0) + (seriesCount.count || 0);

    const category_distribution: Record<string, number> = {};
    if (categoryRows.data) {
      for (const row of categoryRows.data) {
        const cat = (row as Record<string, unknown>).category as string || 'uncategorized';
        category_distribution[cat] = (category_distribution[cat] || 0) + 1;
      }
    }

    res.json({
      stats: {
        total_accounts: totalAccounts,
        claimed_accounts: claimedAccounts,
        pending_accounts: pendingAccounts,
        total_events: totalEvents,
        category_distribution,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// API KEYS
// =============================================================================

/** GET /service/api-keys — List all API keys with event stats */
router.get('/api-keys', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    const { data: keys, error } = await supabaseAdmin
      .from('api_keys')
      .select('id, key_prefix, name, url, contact_email, rate_limit_per_hour, status, contributor_tier, last_used_at, created_at')
      .order('created_at', { ascending: false });

    if (error) throw createError('Failed to list API keys', 500, 'SERVER_ERROR');

    // Fetch event counts and last submission per API key
    const keyIds = (keys || []).map((k) => k.id);
    let eventStats: Record<string, { event_count: number; last_submitted_at: string | null; pending_count: number }> = {};

    if (keyIds.length > 0) {
      // Fetch counts per key — use minimal select, the new compound index handles this efficiently
      const sourceFeedUrls = keyIds.map((id) => `api-key:${id}`);
      const { data: stats } = await supabaseAdmin
        .from('events')
        .select('source_feed_url, status, created_at')
        .in('source_feed_url', sourceFeedUrls)
        .eq('source_method', 'api')
        .order('created_at', { ascending: false });

      if (stats) {
        for (const row of stats) {
          const keyId = row.source_feed_url?.replace('api-key:', '');
          if (!keyId) continue;
          if (!eventStats[keyId]) eventStats[keyId] = { event_count: 0, last_submitted_at: null, pending_count: 0 };
          eventStats[keyId].event_count++;
          if (row.status === 'pending_review') eventStats[keyId].pending_count++;
          if (!eventStats[keyId].last_submitted_at) {
            eventStats[keyId].last_submitted_at = row.created_at;
          }
        }
      }
    }

    const enrichedKeys = (keys || []).map((k) => ({
      ...k,
      event_count: eventStats[k.id]?.event_count ?? 0,
      pending_count: eventStats[k.id]?.pending_count ?? 0,
      last_submitted_at: eventStats[k.id]?.last_submitted_at ?? null,
    }));

    res.json({ api_keys: enrichedKeys });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /service/api-keys — Issue a new API key linked to a portal account.
 *
 * The new key is the credential; the linked account is the stable owner.
 * Rotation: call this with the same account_id as the existing key, then
 * revoke the old key (PATCH .../api-keys/:id with status='revoked') when
 * ready. Editorial control over the account's events follows the account,
 * not the key — both old and new keys can edit the same events while
 * both are active.
 *
 * Issuing a Contribute-tier key without account_id is forbidden: that
 * was the bug that made key rotation silently destroy ownership. Service
 * keys may be issued without account_id (admin keys span accounts).
 */
router.post('/api-keys', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    const schema = z.object({
      name: z.string().min(1).max(100),
      contact_email: z.string().email().max(200),
      contributor_tier: z.enum(['pending', 'verified', 'trusted', 'service']).default('verified'),
      account_id: z.string().uuid().optional(),
      url: z.string().url().max(500).optional(),
      rate_limit_per_hour: z.number().int().min(1).max(100000).default(1000),
      is_admin: z.boolean().default(false),
    });
    const data = validateRequest(schema, req.body);

    // Invariant: Contribute keys (any non-service tier) MUST be linked to an
    // account at issuance. Otherwise PATCH/DELETE return 403 KEY_NOT_LINKED
    // and we recreate the rotation bug we just fixed.
    const isServiceTier = data.contributor_tier === 'service';
    if (!isServiceTier && !data.account_id) {
      throw createError(
        'account_id is required for non-service API keys. Without a linked account, the key cannot edit or delete the events it creates.',
        400,
        'ACCOUNT_REQUIRED',
      );
    }

    // Verify the account exists if provided
    if (data.account_id) {
      const { data: account } = await supabaseAdmin
        .from('portal_accounts')
        .select('id, status')
        .eq('id', data.account_id)
        .maybeSingle();
      if (!account) throw createError('Account not found', 404, 'NOT_FOUND');
    }

    // Generate the raw key + hash. The raw key is returned ONCE in this
    // response and never recoverable — caller must store it immediately.
    const { randomBytes, createHash } = await import('crypto');
    const rawKey = 'nc_' + randomBytes(16).toString('hex');
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.substring(0, 12);

    const { data: newKey, error: insertError } = await supabaseAdmin
      .from('api_keys')
      .insert({
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name: data.name,
        contact_email: data.contact_email,
        contributor_tier: data.contributor_tier,
        url: data.url || null,
        rate_limit_per_hour: data.rate_limit_per_hour,
        status: 'active',
        is_admin: data.is_admin,
      })
      .select('id, key_prefix, name, contributor_tier, is_admin, created_at')
      .single();

    if (insertError || !newKey) throw createError('Failed to create API key', 500, 'SERVER_ERROR');

    if (data.account_id) {
      const { error: linkError } = await supabaseAdmin
        .from('api_key_account_links')
        .insert({ api_key_id: newKey.id, portal_account_id: data.account_id });
      if (linkError) {
        // Roll back the key — partial state is worse than failure
        await supabaseAdmin.from('api_keys').delete().eq('id', newKey.id);
        throw createError('Failed to link API key to account', 500, 'SERVER_ERROR');
      }
    }

    console.log(`[SERVICE] API key ${newKey.id} created (${newKey.contributor_tier}) linked to account ${data.account_id || '<none>'}`);
    res.status(201).json({
      api_key: { ...newKey, account_id: data.account_id || null },
      key: rawKey,
      warning: 'Store this key immediately — it is not recoverable.',
    });
  } catch (err) { next(err); }
});

/** PATCH /service/api-keys/:id — Update API key tier, name, status, or contact email */
router.patch('/api-keys/:id', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    validateUuidParam(req.params.id, 'API key ID');
    const schema = z.object({
      name: z.string().min(1).max(100).optional(),
      url: z.string().url().max(500).optional().nullable(),
      status: z.enum(['active', 'revoked']).optional(),
      contributor_tier: z.enum(['pending', 'verified', 'trusted']).optional(),
      contact_email: z.string().email().max(200).optional(),
    });
    const updates = validateRequest(schema, req.body);

    if (Object.keys(updates).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    const { data: apiKey, error } = await supabaseAdmin
      .from('api_keys')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, key_prefix, name, url, contact_email, rate_limit_per_hour, status, contributor_tier, last_used_at, created_at')
      .single();

    if (error) throw createError('Failed to update API key', 500, 'SERVER_ERROR');

    console.log(`[SERVICE] API key ${req.params.id} updated: ${Object.keys(updates).join(', ')}`);
    res.json({ api_key: apiKey });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GROUPS
// =============================================================================

const GROUP_SELECT = `
  id, name, slug, description, type,
  category_tags, neighborhood, city, address, latitude, longitude,
  avatar_url, hero_image_url, links, phone, website,
  operating_hours, status, claimed,
  source_publisher, source_method, portal_account_id,
  created_at, updated_at
`;

const createGroupSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().max(2000).optional(),
  type: z.enum(['business', 'community_group', 'nonprofit', 'collective', 'curator']).default('community_group'),
  category_tags: z.array(z.string().max(50)).max(20).optional(),
  neighborhood: z.string().max(200).optional(),
  city: z.string().max(200).default('Philadelphia'),
  address: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  avatar_url: z.string().url().max(2000).optional(),
  hero_image_url: z.string().url().max(2000).optional(),
  links: z.record(z.string()).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(2000).optional(),
  operating_hours: z.array(z.object({
    open: z.boolean(),
    ranges: z.array(z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    })),
  })).length(7).optional(),
  portal_account_id: z.string().uuid().optional(),
});

const updateGroupSchema = createGroupSchema.partial().omit({ slug: true });

const groupVenueSchema = z.object({
  place_id: z.string().max(500).optional(),
  venue_name: z.string().min(1).max(200),
  venue_address: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  is_primary: z.boolean().default(false),
});

const listGroupsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  search: z.string().max(200).optional(),
});

/** GET /service/groups — List all groups */
router.get('/groups', serviceLimiter, async (req, res, next) => {
  try {
    const { limit, offset, search } = validateRequest(listGroupsQuerySchema, req.query);

    let query = supabaseAdmin
      .from('groups')
      .select(`${GROUP_SELECT}, group_venues(id, place_id, venue_name, venue_address, latitude, longitude, is_primary)`, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      const sanitized = sanitizeSearchInput(search);
      if (sanitized) query = query.or(`name.ilike.%${sanitized}%,neighborhood.ilike.%${sanitized}%`);
    }

    const typeFilter = req.query.type as string | undefined;
    if (typeFilter) {
      query = query.eq('type', typeFilter);
    }

    const { data: groups, count, error } = await query;
    if (error) throw createError('Failed to fetch groups', 500, 'SERVER_ERROR');

    res.json({ groups: groups || [], total: count || 0 });
  } catch (err) {
    next(err);
  }
});

/** GET /service/groups/:id — Single group with venues */
router.get('/groups/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'group ID');

    const { data: group, error } = await supabaseAdmin
      .from('groups')
      .select(`${GROUP_SELECT}, group_venues(id, place_id, venue_name, venue_address, latitude, longitude, is_primary)`)
      .eq('id', req.params.id)
      .maybeSingle();

    if (error || !group) throw createError('Group not found', 404, 'NOT_FOUND');

    res.json({ group });
  } catch (err) {
    next(err);
  }
});

/** POST /service/groups — Create a group */
router.post('/groups', serviceLimiter, async (req, res, next) => {
  try {
    const data = validateRequest(createGroupSchema, req.body);

    const { data: group, error } = await supabaseAdmin
      .from('groups')
      .insert({
        name: data.name,
        slug: data.slug,
        description: data.description || null,
        type: data.type,
        category_tags: data.category_tags || [],
        neighborhood: data.neighborhood || null,
        city: data.city,
        address: data.address || null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        avatar_url: data.avatar_url || null,
        hero_image_url: data.hero_image_url || null,
        links: data.links || {},
        phone: data.phone || null,
        website: data.website || null,
        operating_hours: data.operating_hours ?? null,
        portal_account_id: data.portal_account_id || null,
        source_method: 'merrie',
        status: 'active',
      })
      .select(GROUP_SELECT)
      .single();

    if (error) {
      if (error.code === '23505') throw createError('Group with this slug already exists', 409, 'CONFLICT');
      console.error('[SERVICE] Create group error:', error.message);
      throw createError('Failed to create group', 500, 'SERVER_ERROR');
    }

    console.log(`[SERVICE] Group created: "${data.name}" (${group.id})`);
    res.status(201).json({ group });
  } catch (err) {
    next(err);
  }
});

/** PATCH /service/groups/:id — Update a group */
router.patch('/groups/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'group ID');
    const data = validateRequest(updateGroupSchema, req.body);

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) update[key] = value ?? null;
    }

    if (Object.keys(update).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    const { data: group, error } = await supabaseAdmin
      .from('groups')
      .update(update)
      .eq('id', req.params.id)
      .select(GROUP_SELECT)
      .single();

    if (error) throw createError('Failed to update group', 500, 'SERVER_ERROR');

    res.json({ group });
  } catch (err) {
    next(err);
  }
});

/** DELETE /service/groups/:id — Delete a group */
router.delete('/groups/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'group ID');

    // Unlink events from this group first
    await supabaseAdmin
      .from('events')
      .update({ group_id: null })
      .eq('group_id', req.params.id);

    const { error } = await supabaseAdmin
      .from('groups')
      .delete()
      .eq('id', req.params.id);

    if (error) throw createError('Failed to delete group', 500, 'SERVER_ERROR');

    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GROUP VENUES
// =============================================================================

/** POST /service/groups/:id/venues — Add a venue to a group */
router.post('/groups/:id/venues', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'group ID');
    const data = validateRequest(groupVenueSchema, req.body);

    const { data: venue, error } = await supabaseAdmin
      .from('group_venues')
      .insert({
        group_id: req.params.id,
        place_id: data.place_id || null,
        venue_name: data.venue_name,
        venue_address: data.venue_address || null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        is_primary: data.is_primary,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') throw createError('Venue already linked to this group', 409, 'CONFLICT');
      throw createError('Failed to add venue', 500, 'SERVER_ERROR');
    }

    res.status(201).json({ venue });
  } catch (err) {
    next(err);
  }
});

/** DELETE /service/groups/:groupId/venues/:venueId — Remove a venue from a group */
router.delete('/groups/:groupId/venues/:venueId', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.groupId, 'group ID');
    validateUuidParam(req.params.venueId, 'venue ID');

    const { error } = await supabaseAdmin
      .from('group_venues')
      .delete()
      .eq('id', req.params.venueId)
      .eq('group_id', req.params.groupId);

    if (error) throw createError('Failed to remove venue', 500, 'SERVER_ERROR');

    res.json({ deleted: true, id: req.params.venueId });
  } catch (err) {
    next(err);
  }
});

/** PATCH /service/events/:id/group — Link an event to a group */
router.patch('/events/:id/group', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    await assertLinkedEvent(req, req.params.id);
    const schema = z.object({
      group_id: z.string().uuid().nullable(),
    });
    const { group_id } = validateRequest(schema, req.body);

    // Verify group exists if linking
    if (group_id) {
      const { data: group } = await supabaseAdmin
        .from('groups')
        .select('id')
        .eq('id', group_id)
        .maybeSingle();
      if (!group) throw createError('Group not found', 404, 'NOT_FOUND');
    }

    const { error } = await supabaseAdmin
      .from('events')
      .update({ group_id })
      .eq('id', req.params.id);

    if (error) throw createError('Failed to update event group', 500, 'SERVER_ERROR');

    res.json({ updated: true, event_id: req.params.id, group_id });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// IMAGE URL MIGRATION
// =============================================================================

/**
 * POST /service/migrate-image-urls — Rewrite all image URLs to direct R2 public URLs.
 * Converts portal proxy URLs and re-hosts external URLs (Google, gstatic, etc.)
 * One-time migration endpoint. Requires R2_PUBLIC_URL to be configured.
 */
router.post('/migrate-image-urls', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    if (!config.r2.publicUrl) {
      throw createError('R2_PUBLIC_URL not configured', 400, 'VALIDATION_ERROR');
    }

    const r2Base = config.r2.publicUrl;
    const results = { accounts: { logo: 0, cover: 0, rehosted: 0 }, events: 0, errors: [] as string[] };

    // --- Migrate portal_accounts ---
    const { data: accounts } = await supabaseAdmin
      .from('portal_accounts')
      .select('id, logo_url, cover_image_url')
      .or('logo_url.not.is.null,cover_image_url.not.is.null');

    for (const account of accounts || []) {
      const update: Record<string, string | null> = {};

      for (const [field, r2Type] of [['logo_url', 'logo'], ['cover_image_url', 'cover']] as const) {
        const url = account[field] as string | null;
        if (!url) continue;

        // Already an R2 public URL — skip
        if (url.startsWith(r2Base)) continue;

        // Portal proxy URL — rewrite to direct R2 URL
        const portalMatch = url.match(/\/api\/portal\/accounts\/([^/]+)\/(logo|cover)$/);
        if (portalMatch) {
          // The R2 key is portal-events/accounts/{id}/{type}/image
          update[field] = `${r2Base}/portal-events/accounts/${portalMatch[1]}/${portalMatch[2]}/image`;
          if (r2Type === 'logo') results.accounts.logo++;
          else results.accounts.cover++;
          continue;
        }

        // External URL (Google, gstatic, etc.) — download, re-encode, upload to R2
        if (url.startsWith('http')) {
          try {
            const response = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeighborhoodCommons/1.0)' },
              signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) {
              results.errors.push(`${account.id}/${r2Type}: download failed (${response.status})`);
              continue;
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            const base64 = buffer.toString('base64');
            const newUrl = await processAndUploadImage(`accounts/${account.id}/${r2Type}`, base64);
            update[field] = newUrl;
            results.accounts.rehosted++;
            console.log(`[SERVICE] Re-hosted ${r2Type} for account ${account.id}: ${url} → ${newUrl}`);
          } catch (err) {
            results.errors.push(`${account.id}/${r2Type}: ${err instanceof Error ? err.message : 'unknown'}`);
          }
          continue;
        }
      }

      if (Object.keys(update).length > 0) {
        await supabaseAdmin.from('portal_accounts').update(update).eq('id', account.id);
      }
    }

    // --- Migrate events ---
    const { data: events } = await supabaseAdmin
      .from('events')
      .select('id, event_image_url')
      .not('event_image_url', 'is', null);

    for (const event of events || []) {
      const url = event.event_image_url as string;
      if (!url || url.startsWith(r2Base)) continue;

      // Portal proxy URL — rewrite to direct R2 URL
      const eventMatch = url.match(/\/api\/portal\/events\/([^/]+)\/image$/);
      if (eventMatch) {
        const newUrl = `${r2Base}/portal-events/${eventMatch[1]}/image`;
        await supabaseAdmin.from('events').update({ event_image_url: newUrl }).eq('id', event.id);
        results.events++;
        continue;
      }

      // Raw R2 key stored directly
      if (url.startsWith('portal-events/')) {
        const newUrl = `${r2Base}/${url}`;
        await supabaseAdmin.from('events').update({ event_image_url: newUrl }).eq('id', event.id);
        results.events++;
      }
    }

    console.log(`[SERVICE] Image URL migration complete:`, JSON.stringify(results));
    res.json({ migration: results });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// APPROVED DOMAINS — operator-managed allowlist for Contribute API URLs
// =============================================================================
//
// Admin-only. Curator-submitted URLs whose domain isn't on this list are
// queued in domain_approval_requests and rejected with DOMAIN_PENDING_REVIEW.
// Operators review the queue and approve domains here.

const domainParam = z.string().min(1).max(253).regex(
  /^[a-z0-9.-]+$/i,
  'Domain must be a hostname (no scheme, path, or port).',
).transform((d) => d.toLowerCase());

const createApprovedDomainSchema = z.object({
  domain: domainParam,
  reason: z.string().max(500).optional(),
});

const reviewRequestSchema = z.object({
  reason: z.string().max(500).optional(),
});

router.get('/approved-domains', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    const { data, error } = await supabaseAdmin
      .from('approved_domains')
      .select('domain, added_by, reason, added_at')
      .order('added_at', { ascending: false });
    if (error) throw createError('Failed to load approved domains', 500, 'SERVER_ERROR');
    res.json({ approved_domains: data || [] });
  } catch (err) { next(err); }
});

router.post('/approved-domains', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    const { domain, reason } = validateRequest(createApprovedDomainSchema, req.body);
    const addedBy = `service:${req.apiKeyInfo.id}`;

    const { error } = await supabaseAdmin
      .from('approved_domains')
      .insert({ domain, reason: reason || null, added_by: addedBy });
    if (error && error.code !== '23505') {
      throw createError('Failed to add approved domain', 500, 'SERVER_ERROR');
    }

    // Mark any pending request for this domain as approved.
    await supabaseAdmin
      .from('domain_approval_requests')
      .update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: addedBy })
      .eq('domain', domain)
      .eq('status', 'pending');

    invalidateApprovedDomainsCache();
    console.log(`[SERVICE] Approved domain added: ${domain} by ${addedBy}`);
    res.status(201).json({ approved_domain: { domain, reason: reason || null, added_by: addedBy } });
  } catch (err) { next(err); }
});

router.delete('/approved-domains/:domain', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    const domain = domainParam.parse(req.params.domain);

    const { error } = await supabaseAdmin
      .from('approved_domains')
      .delete()
      .eq('domain', domain);
    if (error) throw createError('Failed to remove approved domain', 500, 'SERVER_ERROR');

    invalidateApprovedDomainsCache();
    console.log(`[SERVICE] Approved domain removed: ${domain} by service:${req.apiKeyInfo.id}`);
    res.status(204).end();
  } catch (err) { next(err); }
});

router.get('/domain-approval-requests', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    const status = (typeof req.query.status === 'string' && ['pending', 'approved', 'rejected'].includes(req.query.status))
      ? req.query.status as string
      : 'pending';

    const { data, error } = await supabaseAdmin
      .from('domain_approval_requests')
      .select('id, domain, requested_via_api_key, requested_url, event_context, status, requested_at, reviewed_at, reviewed_by')
      .eq('status', status)
      .order('requested_at', { ascending: false })
      .limit(200);
    if (error) throw createError('Failed to load approval requests', 500, 'SERVER_ERROR');
    res.json({ requests: data || [] });
  } catch (err) { next(err); }
});

router.post('/domain-approval-requests/:id/approve', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    validateUuidParam(req.params.id, 'request ID');
    const { reason } = validateRequest(reviewRequestSchema, req.body || {});
    const reviewedBy = `service:${req.apiKeyInfo.id}`;

    const { data: request, error: fetchError } = await supabaseAdmin
      .from('domain_approval_requests')
      .select('id, domain, status')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError || !request) throw createError('Request not found', 404, 'NOT_FOUND');
    if (request.status !== 'pending') throw createError(`Request already ${request.status}`, 409, 'CONFLICT');

    const domain = request.domain as string;
    const { error: insertError } = await supabaseAdmin
      .from('approved_domains')
      .insert({ domain, reason: reason || null, added_by: reviewedBy });
    if (insertError && insertError.code !== '23505') {
      throw createError('Failed to add approved domain', 500, 'SERVER_ERROR');
    }

    await supabaseAdmin
      .from('domain_approval_requests')
      .update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: reviewedBy })
      .eq('id', req.params.id);

    invalidateApprovedDomainsCache();
    console.log(`[SERVICE] Approval request approved: ${domain} (${req.params.id}) by ${reviewedBy}`);
    res.json({ request: { id: req.params.id, domain, status: 'approved' } });
  } catch (err) { next(err); }
});

router.post('/domain-approval-requests/:id/reject', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    validateUuidParam(req.params.id, 'request ID');
    const reviewedBy = `service:${req.apiKeyInfo.id}`;

    const { data: request, error: fetchError } = await supabaseAdmin
      .from('domain_approval_requests')
      .select('id, domain, status')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError || !request) throw createError('Request not found', 404, 'NOT_FOUND');
    if (request.status !== 'pending') throw createError(`Request already ${request.status}`, 409, 'CONFLICT');

    const { error: updateError } = await supabaseAdmin
      .from('domain_approval_requests')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString(), reviewed_by: reviewedBy })
      .eq('id', req.params.id);
    if (updateError) throw createError('Failed to reject request', 500, 'SERVER_ERROR');

    console.log(`[SERVICE] Approval request rejected: ${request.domain} (${req.params.id}) by ${reviewedBy}`);
    res.json({ request: { id: req.params.id, domain: request.domain, status: 'rejected' } });
  } catch (err) { next(err); }
});

export default router;
