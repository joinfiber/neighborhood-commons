/**
 * Public Accounts API — Neighborhood API v0.2
 *
 * Read-only public API for venue/business accounts.
 * These are the portal_accounts imported via Studio — venues, bars,
 * music halls, restaurants, etc.
 *
 * No authentication required. Rate-limited.
 *
 * Base: /api/v1/accounts
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest } from '../lib/helpers.js';

const router: ReturnType<typeof Router> = Router();

export const accountsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const ACCOUNT_SELECT = `
  id, business_name, phone, website, logo_url, description,
  default_venue_name, default_place_id, default_address,
  default_latitude, default_longitude,
  operating_hours, status, created_at, updated_at
`;

const listSchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/v1/accounts — search accounts
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(listSchema, req.query);
    const limit = params.limit || 20;
    const offset = params.offset || 0;

    let query = supabaseAdmin
      .from('portal_accounts')
      .select(ACCOUNT_SELECT, { count: 'exact' })
      .eq('status', 'active')
      .order('business_name', { ascending: true })
      .range(offset, offset + limit - 1);

    if (params.q) {
      query = query.or(
        `business_name.ilike.%${params.q}%,default_venue_name.ilike.%${params.q}%,default_address.ilike.%${params.q}%`
      );
    }

    const { data: accounts, error, count } = await query;

    if (error) {
      console.error('[V1:ACCOUNTS] Query error:', error.message);
      throw createError('Failed to fetch accounts', 500, 'SERVER_ERROR');
    }

    const response = (accounts || []).map(formatAccount);

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
// GET /api/v1/accounts/:id — single account by ID
// ---------------------------------------------------------------------------

router.get('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;

    const { data: account, error } = await supabaseAdmin
      .from('portal_accounts')
      .select(ACCOUNT_SELECT)
      .eq('id', id)
      .eq('status', 'active')
      .single();

    if (error || !account) {
      throw createError('Account not found', 404, 'NOT_FOUND');
    }

    // Get upcoming events for this account
    const { data: upcomingEvents } = await supabaseAdmin
      .from('events')
      .select('id, content, event_at, end_time, place_name, category')
      .eq('creator_account_id', account.id)
      .eq('status', 'published')
      .gte('event_at', new Date().toISOString())
      .order('event_at', { ascending: true })
      .limit(10);

    res.json({
      account: {
        ...formatAccount(account),
        upcoming_events: (upcomingEvents || []).map(e => ({
          id: e.id,
          name: e.content,
          start: e.event_at,
          end: e.end_time,
          location: { name: e.place_name },
          category: e.category ? [e.category] : [],
        })),
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
  // Generate a URL-safe slug from business name
  const name = (row.business_name as string) || '';
  const slug = name
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
    venue: {
      name: row.default_venue_name || name,
      address: row.default_address || null,
      place_id: row.default_place_id || null,
      lat: row.default_latitude || null,
      lng: row.default_longitude || null,
    },
    operating_hours: row.operating_hours || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export default router;
