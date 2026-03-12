/**
 * Neighborhood API v0.2 — Feed Metadata
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
    description: 'Open neighborhood event data, flourishes because of you.',
    spec: 'neighborhood-api-v0.2',
    spec_url: 'https://github.com/The-Relational-Technology-Project/neighborhood-api',
    stewards: [
      {
        name: 'Neighborhood Commons',
        url: 'https://joinfiber.app',
        contact: 'hello@joinfiber.app',
        role: 'maintainer',
      },
    ],
    data_sources: [
      {
        name: 'Portal',
        method: 'portal',
        description: 'Events submitted directly by venue owners and promoters.',
      },
    ],
    resources: ['events'],
    license: {
      name: 'Creative Commons Attribution 4.0 International',
      spdx: 'CC-BY-4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/',
    },
    terms_url: 'https://commons.joinfiber.app/api/v1/events/terms',
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
    // Categories are defined in the DB or config — query distinct from events
    const { data: categories, error } = await supabaseAdmin
      .from('events')
      .select('category')
      .eq('status', 'published')
      .is('ended_at', null)
      .not('category', 'is', null);

    if (error) {
      console.error('[META] Failed to fetch categories:', error.message);
      throw createError('Failed to fetch categories', 500, 'DATABASE_ERROR');
    }

    // Deduplicate and count
    const categoryMap = new Map<string, number>();
    for (const row of categories || []) {
      if (row.category) {
        categoryMap.set(row.category, (categoryMap.get(row.category) || 0) + 1);
      }
    }

    const result = Array.from(categoryMap.entries())
      .map(([slug, count]) => ({
        slug: slug.replace(/_/g, '-'),
        key: slug,
        count,
      }))
      .sort((a, b) => b.count - a.count);

    res.set('Cache-Control', 'public, max-age=1800');
    res.json({ categories: result });
  } catch (err) {
    next(err);
  }
});

export default router;
