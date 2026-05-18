/**
 * Public Contributors API — Neighborhood Commons 3.1
 *
 * Read-only public surface for `contributor_profiles` — the public-facing
 * identity of each contributing app (the ecosystem participants that route
 * data into the Commons). The "splash card" data a consumer app like Fiber
 * renders when a reader taps "via Merrie".
 *
 * The slug is the stable cross-key identifier; survives api_key rotation.
 *
 * Base: /api/v1/contributors
 *
 * No authentication required. Optional API key for dedicated rate limit.
 * Only active profiles are surfaced; pending and suspended profiles are
 * operational and live outside the public read surface.
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, sanitizeSearchInput } from '../lib/helpers.js';
import { optionalApiKey } from '../middleware/api-key.js';

const router: ReturnType<typeof Router> = Router();
router.use(optionalApiKey);

export const contributorsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.apiKeyInfo?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded (1000/hr).' } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public columns only. Internal fields (mfa_*, application_metadata,
// what_youre_building, verification_process) never surface here.
const CONTRIBUTOR_SELECT = `
  id, slug, name, tagline, description, who_its_for,
  app_url, logo_url, category,
  created_at, updated_at
`;

const listSchema = z.object({
  category: z.string().max(50).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/v1/contributors
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(listSchema, req.query);
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    let query = supabaseAdmin
      .from('contributor_profiles')
      .select(CONTRIBUTOR_SELECT, { count: 'exact' })
      .eq('status', 'active')
      .order('name', { ascending: true })
      .range(offset, offset + limit - 1);

    if (params.category) {
      query = query.eq('category', params.category);
    }

    if (params.q) {
      const sanitized = sanitizeSearchInput(params.q);
      if (sanitized) {
        query = query.or(`name.ilike.%${sanitized}%,tagline.ilike.%${sanitized}%,description.ilike.%${sanitized}%`);
      }
    }

    const { data: rows, error, count } = await query;
    if (error) {
      console.error('[V1:CONTRIBUTORS] Query error:', error.message);
      throw createError('Failed to fetch contributors', 500, 'SERVER_ERROR');
    }

    const contributors = (rows || []).map(formatContributor);

    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      meta: buildMeta(count || 0, limit, offset),
      contributors,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/contributors/:idOrSlug
// ---------------------------------------------------------------------------

router.get('/:idOrSlug', async (req, res, next) => {
  try {
    const param = req.params.idOrSlug;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);

    const lookup = isUuid
      ? supabaseAdmin.from('contributor_profiles').select(CONTRIBUTOR_SELECT).eq('id', param)
      : supabaseAdmin.from('contributor_profiles').select(CONTRIBUTOR_SELECT).eq('slug', param.toLowerCase());

    const { data: row, error } = await lookup
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      console.error('[V1:CONTRIBUTORS] Lookup error:', error.message);
      throw createError('Failed to fetch contributor', 500, 'SERVER_ERROR');
    }
    if (!row) {
      throw createError('Contributor not found', 404, 'NOT_FOUND');
    }

    res.set('Cache-Control', 'public, max-age=300');
    res.json({ contributor: formatContributor(row as Record<string, unknown>) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatContributor(row: Record<string, unknown>) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: (row.tagline as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    who_its_for: (row.who_its_for as string | null) ?? null,
    app_url: (row.app_url as string | null) ?? null,
    logo_url: (row.logo_url as string | null) ?? null,
    category: (row.category as string | null) ?? null,
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
