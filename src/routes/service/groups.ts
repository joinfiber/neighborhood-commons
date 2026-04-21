/**
 * Service API — Groups
 *
 * CRUD for the "groups" primitive (businesses, community groups, curators,
 * collectives, nonprofits) and group-venue many-to-many links. A group is
 * any entity that does things in a neighborhood.
 *
 * Also hosts PATCH /events/:id/group — linking an existing event to a
 * group. Lives here rather than in events.ts because the primary concern
 * is the group relationship.
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest, validateUuidParam, sanitizeSearchInput } from '../../lib/helpers.js';
import { serviceLimiter } from '../../middleware/rate-limit.js';
import { assertLinkedEvent } from './helpers.js';

const router: ReturnType<typeof Router> = Router();

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

export default router;
