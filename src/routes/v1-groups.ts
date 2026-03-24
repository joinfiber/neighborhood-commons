/**
 * Public Groups API — Neighborhood API v0.2
 *
 * Read-only public API for Neighborhood Commons groups.
 * Groups are entities that do things in a neighborhood:
 * businesses, community groups, curators, nonprofits.
 *
 * No authentication required. Rate-limited.
 *
 * Base: /api/v1/groups
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest, validateUuidParam } from '../lib/helpers.js';

const router: ReturnType<typeof Router> = Router();

export const groupsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

const listSchema = z.object({
  type: z.enum(['business', 'community_group', 'nonprofit', 'collective', 'curator']).optional(),
  category: z.string().max(100).optional(),
  neighborhood: z.string().max(200).optional(),
  near: z.string().regex(/^-?\d+\.?\d*,-?\d+\.?\d*$/).optional(),
  radius_km: z.coerce.number().min(0.1).max(50).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Shared select for group responses
// ---------------------------------------------------------------------------

const GROUP_SELECT = `
  id, name, slug, description, type,
  category_tags, neighborhood, city, address, latitude, longitude,
  avatar_url, hero_image_url, links, phone, website,
  operating_hours, status, claimed,
  source_publisher, source_method,
  created_at, updated_at
`;

const GROUP_VENUES_SELECT = `
  group_venues (
    id, place_id, venue_name, venue_address, latitude, longitude, is_primary
  )
`;

// ---------------------------------------------------------------------------
// GET /api/v1/groups — list groups
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const params = validateRequest(listSchema, req.query);
    const limit = params.limit || 20;
    const offset = params.offset || 0;

    let query = supabaseAdmin
      .from('groups')
      .select(`${GROUP_SELECT}, ${GROUP_VENUES_SELECT}`, { count: 'exact' })
      .in('status', ['active', 'dormant'])
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Filters
    if (params.type) {
      query = query.eq('type', params.type);
    }
    if (params.category) {
      query = query.contains('category_tags', [params.category]);
    }
    if (params.neighborhood) {
      query = query.ilike('neighborhood', `%${params.neighborhood}%`);
    }
    if (params.q) {
      query = query.or(`name.ilike.%${params.q}%,description.ilike.%${params.q}%`);
    }

    // Geo filter (near + radius_km)
    if (params.near && params.radius_km) {
      const [lat, lng] = params.near.split(',').map(Number);
      if (lat && lng) {
        // Approximate bounding box for PostgREST (not exact circle, but good enough)
        const latDelta = params.radius_km / 111;
        const lngDelta = params.radius_km / (111 * Math.cos((lat * Math.PI) / 180));
        query = query
          .gte('latitude', lat - latDelta)
          .lte('latitude', lat + latDelta)
          .gte('longitude', lng - lngDelta)
          .lte('longitude', lng + lngDelta);
      }
    }

    const { data: groups, error, count } = await query;

    if (error) {
      console.error('[V1:GROUPS] Query error:', error.message);
      throw createError('Failed to fetch groups', 500, 'SERVER_ERROR');
    }

    // Get event counts per group
    const groupIds = (groups || []).map(g => g.id);
    let eventCounts: Record<string, number> = {};
    if (groupIds.length > 0) {
      const { data: counts } = await supabaseAdmin
        .from('events')
        .select('group_id')
        .in('group_id', groupIds)
        .eq('status', 'published');

      if (counts) {
        for (const row of counts) {
          if (row.group_id) {
            eventCounts[row.group_id] = (eventCounts[row.group_id] || 0) + 1;
          }
        }
      }
    }

    const response = (groups || []).map(g => ({
      ...formatGroup(g),
      venues: g.group_venues || [],
      event_count: eventCounts[g.id] || 0,
    }));

    res.json({
      groups: response,
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
// GET /api/v1/groups/:id — single group
// ---------------------------------------------------------------------------

router.get('/:id', async (req, res, next) => {
  try {
    const id = validateUuidParam(req.params.id, 'id');

    const { data: group, error } = await supabaseAdmin
      .from('groups')
      .select(`${GROUP_SELECT}, ${GROUP_VENUES_SELECT}`)
      .eq('id', id)
      .in('status', ['active', 'dormant'])
      .single();

    if (error || !group) {
      throw createError('Group not found', 404, 'NOT_FOUND');
    }

    // Get event count
    const { count: eventCount } = await supabaseAdmin
      .from('events')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', id)
      .eq('status', 'published');

    // Get upcoming events (next 5)
    const { data: upcomingEvents } = await supabaseAdmin
      .from('events')
      .select('id, content, event_at, end_time, place_name, category')
      .eq('group_id', id)
      .eq('status', 'published')
      .gte('event_at', new Date().toISOString())
      .order('event_at', { ascending: true })
      .limit(5);

    res.json({
      group: {
        ...formatGroup(group),
        venues: group.group_venues || [],
        event_count: eventCount || 0,
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
// Format group for API response
// ---------------------------------------------------------------------------

function formatGroup(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description || null,
    type: row.type,
    category_tags: row.category_tags || [],
    location: {
      neighborhood: row.neighborhood || null,
      city: row.city || null,
      address: row.address || null,
      lat: row.latitude || null,
      lng: row.longitude || null,
    },
    avatar_url: row.avatar_url || null,
    hero_image_url: row.hero_image_url || null,
    links: row.links || {},
    phone: row.phone || null,
    website: row.website || null,
    operating_hours: row.operating_hours || null,
    status: row.status,
    claimed: row.claimed || false,
    source: {
      publisher: row.source_publisher || null,
      method: row.source_method || null,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export default router;
