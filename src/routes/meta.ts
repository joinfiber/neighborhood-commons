/**
 * /meta — Feed Metadata
 *
 * Per the Neighborhood API spec, /meta provides feed identity,
 * steward info, data sources, and supported resource types.
 *
 * Also provides regions and categories for filtering.
 *
 * https://github.com/The-Relational-Technology-Project/neighborhood-api
 */

import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { parseLocation } from '../lib/helpers.js';

const router: ReturnType<typeof Router> = Router();

/**
 * GET /api/meta
 * Feed metadata: stewards, data sources, supported resources.
 */
router.get('/', (_req, res) => {
  res.json({
    name: 'Neighborhood Commons',
    description: 'Open, typed substrate for neighborhood public facts.',
    implementation_version: '3.0.0',
    implementation_spec: 'https://neighborhood-commons.org/openapi.json',
    upstream_spec: 'neighborhood-api-v0.2',
    upstream_spec_url: 'https://github.com/The-Relational-Technology-Project/neighborhood-api',
    stewards: [
      {
        name: 'Neighborhood Commons',
        url: 'https://neighborhood-commons.org',
        contact: 'hi@neighborhood-commons.org',
        role: 'maintainer',
      },
    ],
    data_sources: [
      {
        name: 'Self-asserted',
        method: 'self_asserted',
        description: 'Events asserted by the organizing organization, routed through a contributor app. The first-party authority path.',
      },
      {
        name: 'Proxied',
        method: 'proxied',
        description: 'Events extracted from a public source (RSS feed, calendar page, CSV) by a pipeline tool. The source URL is preserved for transparency.',
      },
      {
        name: 'Witnessed',
        method: 'witnessed',
        description: 'Events captured from public flyers and other documentary evidence by a contributor publishing under a collective identity.',
      },
    ],
    resources: ['events'],
    license: {
      name: 'Creative Commons Attribution 4.0 International',
      spdx: 'CC-BY-4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/',
    },
    terms_url: 'https://neighborhood-commons.org/api/v1/events/terms',
  });
});

/**
 * GET /api/meta/regions — List active regions
 */
router.get('/regions', async (_req, res, next) => {
  try {
    const { data: regions, error } = await supabaseAdmin
      .from('regions')
      .select('id, name, slug, timezone, centroid')
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) {
      console.error('[META] Failed to fetch regions:', error.message);
      throw createError('Failed to fetch regions', 500, 'DATABASE_ERROR');
    }

    // Transform PostGIS centroid to flat lat/lng for API consumers
    const result = (regions || []).map((r) => {
      const coords = parseLocation(r.centroid);
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        timezone: r.timezone,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      };
    });

    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ regions: result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/meta/categories — List event categories
 */
router.get('/categories', async (_req, res, next) => {
  try {
    // event_category_counts() (migration 096) does the GROUP BY in Postgres —
    // one row per category — instead of streaming every published event's
    // category into the process to dedup/count by hand.
    const { data: categories, error } = await supabaseAdmin.rpc('event_category_counts');

    if (error) {
      console.error('[META] Failed to fetch categories:', error.message);
      throw createError('Failed to fetch categories', 500, 'DATABASE_ERROR');
    }

    const result = ((categories as { category: string; count: number }[] | null) || [])
      .filter((row) => row.category)
      .map((row) => ({
        slug: row.category.replace(/_/g, '-'),
        key: row.category,
        count: Number(row.count),
      }))
      .sort((a, b) => b.count - a.count);

    res.set('Cache-Control', 'public, max-age=1800');
    res.json({ categories: result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/meta/stats — Live platform statistics (public, cached)
 */
router.get('/stats', async (_req, res, next) => {
  try {
    const [eventResult, venueResult, regionResult] = await Promise.all([
      supabaseAdmin.from('events').select('id', { count: 'exact', head: true }).eq('status', 'published'),
      supabaseAdmin.from('portal_accounts').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabaseAdmin.from('regions').select('name').eq('is_active', true).limit(1).maybeSingle(),
    ]);

    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      total_events: eventResult.count || 0,
      total_venues: venueResult.count || 0,
      region: regionResult.data?.name || null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
