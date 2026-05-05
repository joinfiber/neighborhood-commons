/**
 * Public Persons API — Neighborhood Commons 1.0.0
 *
 * Read-only public API for Schema.org Person records.
 * Persons are individuals — DJs, performers, curators, individual organizers.
 *
 * Light verification rigor (email loop, any domain). The verification block
 * is exposed publicly when present.
 *
 * Base: /api/v1/persons
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, sanitizeSearchInput } from '../lib/helpers.js';
import { optionalApiKey } from '../middleware/api-key.js';
import { hydrateVerificationsFor, type VerificationByTarget } from '../lib/verification-hydrate.js';

const router: ReturnType<typeof Router> = Router();
router.use(optionalApiKey);

export const personsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.apiKeyInfo?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded (1000/hr).' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const PERSON_SELECT = `
  id, slug, name, given_name, family_name, alternate_name,
  description, image_url, url, same_as, job_title,
  created_at, updated_at
`;

const listSchema = z.object({
  verified: z.enum(['true', 'false']).optional(),
  verified_by: z.string().max(500).optional(),
  not_verified_by: z.string().max(500).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/v1/persons
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(listSchema, req.query);
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    let query = supabaseAdmin
      .from('persons')
      .select(PERSON_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (params.q) {
      const sanitized = sanitizeSearchInput(params.q);
      if (sanitized) {
        query = query.or(
          `name.ilike.%${sanitized}%,description.ilike.%${sanitized}%,alternate_name.ilike.%${sanitized}%`
        );
      }
    }

    const { data: persons, error, count } = await query;
    if (error) {
      console.error('[V1:PERSONS] Query error:', error.message);
      throw createError('Failed to fetch persons', 500, 'SERVER_ERROR');
    }

    const ids = (persons || []).map(p => p.id as string);
    const verifications = await hydrateVerificationsFor('person', ids);

    let formatted = (persons || []).map(p => formatPerson(p, verifications));

    // Filter by verified state (post-fetch since the verification source is in a separate table)
    if (params.verified === 'true') {
      formatted = formatted.filter(p => p.verified);
    } else if (params.verified === 'false') {
      formatted = formatted.filter(p => !p.verified);
    }
    if (params.verified_by) {
      const allowed = new Set(params.verified_by.split(',').map(s => s.trim()));
      formatted = formatted.filter(p => p.verification && allowed.has(p.verification.verifiedByApp));
    }
    if (params.not_verified_by) {
      const blocked = new Set(params.not_verified_by.split(',').map(s => s.trim()));
      formatted = formatted.filter(p => !p.verification || !blocked.has(p.verification.verifiedByApp));
    }

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      meta: buildMeta(count || 0, limit, offset),
      persons: formatted,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/persons/:idOrSlug
// ---------------------------------------------------------------------------

router.get('/:idOrSlug', async (req, res, next) => {
  try {
    const param = req.params.idOrSlug;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);

    const lookup = isUuid
      ? supabaseAdmin.from('persons').select(PERSON_SELECT).eq('id', param)
      : supabaseAdmin.from('persons').select(PERSON_SELECT).eq('slug', param.toLowerCase());

    const { data: person, error } = await lookup.maybeSingle();
    if (error) {
      console.error('[V1:PERSONS] Query error:', error.message);
      throw createError('Failed to fetch person', 500, 'SERVER_ERROR');
    }
    if (!person) {
      throw createError('Person not found', 404, 'NOT_FOUND');
    }

    const verifications = await hydrateVerificationsFor('person', [person.id as string]);

    res.set('Cache-Control', 'public, max-age=60');
    res.json({ person: formatPerson(person, verifications) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Format Person for API response
// ---------------------------------------------------------------------------

export function formatPerson(row: Record<string, unknown>, verifications: VerificationByTarget) {
  const id = row.id as string;
  const v = verifications.get(id);

  return {
    id,
    slug: row.slug,
    name: row.name,
    givenName: row.given_name || null,
    familyName: row.family_name || null,
    alternateName: row.alternate_name || null,
    description: row.description || null,
    image: row.image_url || null,
    url: row.url || null,
    sameAs: row.same_as || [],
    jobTitle: row.job_title || null,
    verified: !!v,
    verification: v || null,
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
