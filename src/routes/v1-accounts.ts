/**
 * Public Accounts API — Neighborhood API v0.2
 *
 * Read-only public API for venue/business accounts.
 * These are the portal_accounts imported via Studio — venues, bars,
 * music halls, restaurants, etc.
 *
 * No authentication required. Optional API key for dedicated rate limit.
 *
 * Base: /api/v1/accounts
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, sanitizeSearchInput } from '../lib/helpers.js';
import { optionalApiKey } from '../middleware/api-key.js';

const router: ReturnType<typeof Router> = Router();

// Extract API key if present (for rate limit keying), but don't require it
router.use(optionalApiKey);

// 1000 requests/hr — keyed by API key if present, otherwise by IP.
// Matches the events endpoint. Generous enough for full catalog sync.
export const accountsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.apiKeyInfo?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded (1000/hr). Register for an API key at /api/v1/developers for a dedicated limit bucket.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const ACCOUNT_SELECT = `
  id, business_name, slug, phone, website, logo_url, cover_image_url, description,
  default_venue_name, default_place_id, default_address,
  default_latitude, default_longitude,
  operating_hours, status, claimed_at, created_at, updated_at
`;

const listSchema = z.object({
  q: z.string().max(200).optional(),
  include: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Shared: fetch events for an account (regular programming + upcoming)
// ---------------------------------------------------------------------------

async function getAccountEvents(accountId: string) {
  const { data: futureEvents } = await supabaseAdmin
    .from('events')
    .select('id, content, event_at, end_time, place_name, category, recurrence, series_id, description, event_image_url, price, link_url')
    .eq('creator_account_id', accountId)
    .eq('status', 'published')
    .gte('event_at', new Date().toISOString())
    .order('event_at', { ascending: true })
    .limit(50);

  const allEvents = (futureEvents || []).map(e => ({
    id: e.id,
    name: e.content,
    start: e.event_at,
    end: e.end_time,
    location: { name: e.place_name },
    category: e.category ? [e.category] : [],
    recurrence: e.recurrence || null,
    series_id: e.series_id || null,
    description: e.description || null,
    image_url: e.event_image_url || null,
    price: e.price || null,
    link_url: e.link_url || null,
  }));

  // Split into regular programming (recurring) vs upcoming (one-off)
  const regularProgramming = allEvents.filter(e => e.recurrence || e.series_id);
  const upcoming = allEvents.filter(e => !e.recurrence && !e.series_id);

  // Deduplicate regular programming by series — show only the next instance
  const seenSeries = new Set<string>();
  const dedupedProgramming = regularProgramming.filter(e => {
    const key = e.series_id || e.name;
    if (seenSeries.has(key)) return false;
    seenSeries.add(key);
    return true;
  });

  return { regular_programming: dedupedProgramming, upcoming_events: upcoming };
}

/** Format a raw event row into the API response shape */
function formatEvent(e: Record<string, unknown>) {
  return {
    id: e.id,
    name: e.content,
    start: e.event_at,
    end: e.end_time,
    location: { name: e.place_name },
    category: e.category ? [e.category] : [],
    recurrence: e.recurrence || null,
    series_id: e.series_id || null,
    description: e.description || null,
    image_url: e.event_image_url || null,
    price: e.price || null,
    link_url: e.link_url || null,
  };
}

/** Batch-load events for multiple accounts in a single query (avoids N+1) */
async function getEventsForAccounts(accountIds: string[]) {
  if (accountIds.length === 0) return new Map<string, { regular_programming: ReturnType<typeof formatEvent>[]; upcoming_events: ReturnType<typeof formatEvent>[] }>();

  // Fetch up to 2500 events (50 accounts × 50 events each). PostgREST defaults
  // to 1000 rows without an explicit limit, which could silently truncate results.
  const { data: allEvents } = await supabaseAdmin
    .from('events')
    .select('id, content, event_at, end_time, place_name, category, recurrence, series_id, description, event_image_url, price, link_url, creator_account_id')
    .in('creator_account_id', accountIds)
    .eq('status', 'published')
    .gte('event_at', new Date().toISOString())
    .order('event_at', { ascending: true })
    .limit(2500);

  // Group by account
  const byAccount = new Map<string, ReturnType<typeof formatEvent>[]>();
  for (const id of accountIds) byAccount.set(id, []);
  for (const e of allEvents || []) {
    const accId = e.creator_account_id as string;
    byAccount.get(accId)?.push(formatEvent(e));
  }

  // Split + deduplicate per account
  const result = new Map<string, { regular_programming: ReturnType<typeof formatEvent>[]; upcoming_events: ReturnType<typeof formatEvent>[] }>();
  for (const [accId, events] of byAccount) {
    const regular = events.filter(e => e.recurrence || e.series_id);
    const upcoming = events.filter(e => !e.recurrence && !e.series_id);
    const seenSeries = new Set<string>();
    const dedupedProgramming = regular.filter(e => {
      const key = (e.series_id || e.name) as string;
      if (seenSeries.has(key)) return false;
      seenSeries.add(key);
      return true;
    });
    result.set(accId, { regular_programming: dedupedProgramming, upcoming_events: upcoming });
  }
  return result;
}

// ---------------------------------------------------------------------------
// GET /api/v1/accounts — search accounts
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(listSchema, req.query);
    const includeEvents = params.include === 'events';
    // Lower max page size when including events to keep response sizes reasonable
    const limit = Math.min(params.limit || 20, includeEvents ? 50 : 100);
    const offset = params.offset || 0;

    let query = supabaseAdmin
      .from('portal_accounts')
      .select(ACCOUNT_SELECT, { count: 'exact' })
      .eq('status', 'active')
      .order('business_name', { ascending: true })
      .range(offset, offset + limit - 1);

    if (params.q) {
      const sanitized = sanitizeSearchInput(params.q);
      if (sanitized) {
        query = query.or(
          `business_name.ilike.%${sanitized}%,default_venue_name.ilike.%${sanitized}%,default_address.ilike.%${sanitized}%`
        );
      }
    }

    const { data: accounts, error, count } = await query;

    if (error) {
      console.error('[V1:ACCOUNTS] Query error:', error.message);
      throw createError('Failed to fetch accounts', 500, 'SERVER_ERROR');
    }

    let response;
    if (includeEvents) {
      // Single batch query for all accounts' events (avoids N+1)
      const accountIds = (accounts || []).map(a => a.id as string);
      const eventsByAccount = await getEventsForAccounts(accountIds);
      response = (accounts || []).map(acct => ({
        ...formatAccount(acct),
        ...(eventsByAccount.get(acct.id as string) || { regular_programming: [], upcoming_events: [] }),
      }));
    } else {
      response = (accounts || []).map(formatAccount);
    }

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      accounts: response,
      pagination: {
        total: count || 0,
        limit,
        offset,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/accounts/:id — single account by ID or slug
// ---------------------------------------------------------------------------

router.get('/:idOrSlug', async (req, res, next) => {
  try {
    const param = req.params.idOrSlug;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);

    let account: Record<string, unknown> | null = null;

    if (isUuid) {
      const { data } = await supabaseAdmin
        .from('portal_accounts')
        .select(ACCOUNT_SELECT)
        .eq('id', param)
        .eq('status', 'active')
        .single();
      account = data;
    } else {
      // Slug lookup: query the indexed slug column directly
      const { data } = await supabaseAdmin
        .from('portal_accounts')
        .select(ACCOUNT_SELECT)
        .eq('slug', param.toLowerCase())
        .eq('status', 'active')
        .maybeSingle();
      account = data;
    }

    if (!account) {
      throw createError('Account not found', 404, 'NOT_FOUND');
    }

    const events = await getAccountEvents(account.id as string);

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      account: {
        ...formatAccount(account),
        ...events,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Format account for API response
// ---------------------------------------------------------------------------

function formatAccount(row: Record<string, unknown>) {
  const name = (row.business_name as string) || '';
  // Prefer DB slug; derive from name as fallback
  const slug = (row.slug as string) || name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return {
    id: row.id,
    name,
    slug,
    description: row.description || null,
    phone: row.phone || null,
    website: row.website || null,
    logo_url: row.logo_url || null,
    cover_image_url: row.cover_image_url || null,
    venue: {
      name: row.default_venue_name || name,
      address: row.default_address || null,
      place_id: row.default_place_id || null,
      lat: row.default_latitude || null,
      lng: row.default_longitude || null,
    },
    operating_hours: row.operating_hours || null,
    is_claimed: !!(row.claimed_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export default router;
