/**
 * Public Series API — Neighborhood Commons 1.0.0
 *
 * Read-only public API for the event_series primitive. A series is a
 * recurring activity with its own identity (name, slug, description, cover
 * image) separate from any individual instance. Consumers use series for
 * subscribable entities, series pages, and aggregation by recurring activity.
 *
 * Distinct from /api/v1/events?series_id=X (which returns the materialized
 * instances). Use this endpoint for the *series itself*; use the events
 * endpoint for the *instances under a series*.
 *
 * See docs/series-as-first-class.md for design rationale.
 *
 * No authentication required. Optional API key for dedicated rate limit.
 *
 * Base: /api/v1/series
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest } from '../lib/helpers.js';
import { optionalApiKey } from '../middleware/api-key.js';
import { hydrateVerificationsFor } from '../lib/verification-hydrate.js';
import { toNeighborhoodEvent, toRRule, type PortalEventRow } from '../lib/event-transform.js';
import { PORTAL_SELECT } from '../lib/event-operations.js';
import { formatOrganization } from './v1-organizations.js';

const router: ReturnType<typeof Router> = Router();
router.use(optionalApiKey);

export const seriesLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.apiKeyInfo?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded (1000/hr).' } },
  standardHeaders: true,
  legacyHeaders: false,
});

const SERIES_SELECT = `
  id, slug, name, description, cover_image_url, organizer_org_id,
  recurrence, recurrence_rule, created_at, updated_at,
  organizations!event_series_organizer_org_id_fkey(
    id, slug, name, legal_name, tags, commercial, description, url, logo_url, image_url,
    telephone, email, same_as, keywords, opening_hours_specification,
    primary_place_id, method, created_at, updated_at
  )
`;

const listSchema = z.object({
  organizer_org_id: z.string().uuid().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/v1/series — list series, optionally filtered by organizer
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(listSchema, req.query);
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    let query = supabaseAdmin
      .from('event_series')
      .select(SERIES_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (params.organizer_org_id) {
      query = query.eq('organizer_org_id', params.organizer_org_id);
    }

    const { data: rows, error, count } = await query;
    if (error) {
      console.error('[V1:SERIES] List query error:', error.message);
      throw createError('Failed to fetch series', 500, 'SERVER_ERROR');
    }

    const seriesList = (rows || []) as Array<Record<string, unknown>>;
    const seriesIds = seriesList.map((s) => s.id as string);

    // Batch-fetch next instances for all returned series in a single query.
    // Sort by series_id, event_at — JS dedupe keeps the first (earliest) per series.
    const nextInstanceMap = new Map<string, Record<string, unknown>>();
    if (seriesIds.length > 0) {
      const { data: instanceRows } = await supabaseAdmin
        .from('events')
        .select(`${PORTAL_SELECT}, organizations!events_organizer_org_id_fkey(id, slug, name)`)
        .in('series_id', seriesIds)
        // SECURITY: next_instance is a public Event — only published instances
        // may surface (mirrors GET /events). Without this, a pending_review/draft
        // instance leaks as the series' next_instance.
        .eq('status', 'published')
        .gte('event_at', new Date().toISOString())
        .order('series_id', { ascending: true })
        .order('event_at', { ascending: true });

      for (const ev of instanceRows || []) {
        const sid = (ev as Record<string, unknown>).series_id as string;
        if (!nextInstanceMap.has(sid)) nextInstanceMap.set(sid, ev as Record<string, unknown>);
      }
    }

    const orgIds = Array.from(new Set(
      seriesList.map((s) => s.organizer_org_id as string).filter(Boolean)
    ));
    const verifications = await hydrateVerificationsFor(orgIds);

    const series = seriesList.map((s) =>
      formatSeries(s, nextInstanceMap.get(s.id as string) || null, verifications)
    );

    res.set('Cache-Control', 'public, max-age=15');
    res.json({
      meta: buildMeta(count || 0, limit, offset),
      series,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/series/:idOrSlug
// ---------------------------------------------------------------------------

router.get('/:idOrSlug', async (req, res, next) => {
  try {
    const idOrSlug = req.params.idOrSlug;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

    const { data: row, error } = await supabaseAdmin
      .from('event_series')
      .select(SERIES_SELECT)
      .eq(isUuid ? 'id' : 'slug', idOrSlug)
      .maybeSingle();

    if (error) {
      console.error('[V1:SERIES] Lookup error:', error.message);
      throw createError('Failed to fetch series', 500, 'SERVER_ERROR');
    }
    if (!row) {
      throw createError('Series not found', 404, 'NOT_FOUND');
    }

    const seriesRow = row as Record<string, unknown>;

    const { data: nextInstanceRow } = await supabaseAdmin
      .from('events')
      .select(`${PORTAL_SELECT}, organizations!events_organizer_org_id_fkey(id, slug, name)`)
      .eq('series_id', seriesRow.id as string)
      .eq('status', 'published') // SECURITY: see list handler — published-only next_instance
      .gte('event_at', new Date().toISOString())
      .order('event_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    const orgId = seriesRow.organizer_org_id as string | null;
    const verifications = orgId ? await hydrateVerificationsFor([orgId]) : new Map();

    res.set('Cache-Control', 'public, max-age=15');
    res.json({
      series: formatSeries(seriesRow, (nextInstanceRow as Record<string, unknown>) || null, verifications),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Format Series for API response
// ---------------------------------------------------------------------------

function formatSeries(
  row: Record<string, unknown>,
  nextInstanceRow: Record<string, unknown> | null,
  verifications: ReturnType<typeof hydrateVerificationsFor> extends Promise<infer T> ? T : never
) {
  const orgRow = row.organizations as Record<string, unknown> | null;
  const recurrencePattern = row.recurrence as string;
  const rrule = recurrencePattern && recurrencePattern !== 'none' ? toRRule(recurrencePattern) : null;

  // Embedded org won't carry its primary_place (extra fetch we don't do here);
  // consumers wanting full org with location should hit /v1/organizations/:id.
  const orgPlacesById = new Map<string, Record<string, unknown>>();

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    cover_image_url: row.cover_image_url ?? null,
    organizer: orgRow ? formatOrganization(orgRow, orgPlacesById, verifications) : null,
    recurrence: rrule ? { rrule } : null,
    next_instance: nextInstanceRow ? toNeighborhoodEvent(nextInstanceRow as unknown as PortalEventRow) : null,
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
