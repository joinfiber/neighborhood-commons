/**
 * Service-tier Lists API — Neighborhood Commons v2
 *
 * Endpoints:
 *   POST    /service/lists                          — create
 *   PATCH   /service/lists/:id                      — update metadata
 *   POST    /service/lists/:id/items                — add item
 *   DELETE  /service/lists/:id/items/:position      — remove item by position
 *
 * v2: lists are always curated by an organization (curator_org_id is
 * NOT NULL after migration 082). The Person primitive is gone.
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest, validateUuidParam } from '../../lib/helpers.js';
import { assertLinkedListCurator, assertLinkedOrganization } from './helpers-v1.js';

const router: ReturnType<typeof Router> = Router();

const LIST_SELECT = `
  id, slug, name, description,
  curator_org_id,
  created_at, updated_at
`;

const listCreateSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  curatorOrganizationId: z.string().uuid(),
});

const listUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
});

const listItemInputSchema = z.object({
  position: z.number().int().min(1),
  itemType: z.enum(['event', 'organization', 'place']),
  itemId: z.string().uuid(),
  curatorNote: z.string().max(500).optional(),
});

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

// ---------------------------------------------------------------------------
// POST /service/lists
// ---------------------------------------------------------------------------

router.post('/lists', async (req, res, next) => {
  try {
    const body = validateRequest(listCreateSchema, req.body);
    const slug = body.slug || deriveSlug(body.name);
    if (!slug) throw createError('Could not derive valid slug', 400, 'VALIDATION_ERROR');

    await assertLinkedOrganization(req, body.curatorOrganizationId);

    const insertRow = {
      slug,
      name: body.name,
      description: body.description || null,
      curator_org_id: body.curatorOrganizationId,
    };

    const { data: created, error } = await supabaseAdmin
      .from('lists')
      .insert(insertRow)
      .select(LIST_SELECT)
      .single();

    if (error) {
      if (error.code === '23505') throw createError(`Slug "${slug}" already in use`, 409, 'CONFLICT');
      console.error('[SERVICE:LISTS] Insert error:', error.message);
      throw createError('Failed to create list', 500, 'SERVER_ERROR');
    }

    res.status(201).json({ list: formatListMetadata(created) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /service/lists/:id
// ---------------------------------------------------------------------------

router.patch('/lists/:id', async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    await assertLinkedListCurator(req, req.params.id);

    const body = validateRequest(listUpdateSchema, req.body);
    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.slug !== undefined) update.slug = body.slug;
    if (body.description !== undefined) update.description = body.description;

    if (Object.keys(update).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const { data: updated, error } = await supabaseAdmin
      .from('lists')
      .update(update)
      .eq('id', req.params.id)
      .select(LIST_SELECT)
      .single();

    if (error) {
      if (error.code === '23505') throw createError('Slug already in use', 409, 'CONFLICT');
      console.error('[SERVICE:LISTS] Update error:', error.message);
      throw createError('Failed to update list', 500, 'SERVER_ERROR');
    }

    res.json({ list: formatListMetadata(updated) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /service/lists/:id/items
// ---------------------------------------------------------------------------

router.post('/lists/:id/items', async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    await assertLinkedListCurator(req, req.params.id);

    const body = validateRequest(listItemInputSchema, req.body);

    const insertRow: Record<string, unknown> = {
      list_id: req.params.id,
      position: body.position,
      curator_note: body.curatorNote || null,
      event_id: body.itemType === 'event' ? body.itemId : null,
      organization_id: body.itemType === 'organization' ? body.itemId : null,
      place_id: body.itemType === 'place' ? body.itemId : null,
    };

    const { data: item, error } = await supabaseAdmin
      .from('list_items')
      .insert(insertRow)
      .select('id, position, event_id, organization_id, place_id, curator_note, added_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw createError(`Position ${body.position} already in use for this list`, 409, 'CONFLICT');
      }
      console.error('[SERVICE:LISTS] Item insert error:', error.message);
      throw createError('Failed to add list item', 500, 'SERVER_ERROR');
    }

    res.status(201).json({
      item: {
        position: item!.position,
        item: null, // not hydrated on write; clients can re-GET the list to see hydrated items
        curatorNote: item!.curator_note,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /service/lists/:id/items/:position
// ---------------------------------------------------------------------------

router.delete('/lists/:id/items/:position', async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const position = parseInt(req.params.position, 10);
    if (isNaN(position) || position < 1) {
      throw createError('Position must be a positive integer', 400, 'VALIDATION_ERROR');
    }
    await assertLinkedListCurator(req, req.params.id);

    const { error } = await supabaseAdmin
      .from('list_items')
      .delete()
      .eq('list_id', req.params.id)
      .eq('position', position);

    if (error) {
      console.error('[SERVICE:LISTS] Item delete error:', error.message);
      throw createError('Failed to remove list item', 500, 'SERVER_ERROR');
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Format helper
// ---------------------------------------------------------------------------

function formatListMetadata(row: Record<string, unknown>) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || null,
    curator: row.curator_org_id
      ? { type: 'organization', id: row.curator_org_id }
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export default router;
