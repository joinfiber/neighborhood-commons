/**
 * Service-tier Persons API — Neighborhood Commons 1.0.0
 *
 * Endpoints:
 *   POST   /service/persons      — create
 *   PATCH  /service/persons/:id  — update (admin only in 1.0.0; person-link
 *                                  semantics ship in a later version)
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest, validateUuidParam } from '../../lib/helpers.js';
import { formatPerson } from '../v1-persons.js';
import { hydrateVerificationsFor } from '../../lib/verification-hydrate.js';

const router: ReturnType<typeof Router> = Router();

const PERSON_SELECT = `
  id, slug, name, given_name, family_name, alternate_name,
  description, image_url, url, same_as, job_title,
  created_at, updated_at
`;

const personCreateSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().max(100).optional(),
  givenName: z.string().max(100).optional(),
  familyName: z.string().max(100).optional(),
  alternateName: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  image: z.string().url().max(2000).optional(),
  url: z.string().url().max(2000).optional(),
  sameAs: z.array(z.string().url()).max(20).optional(),
  jobTitle: z.string().max(100).optional(),
});

const personUpdateSchema = personCreateSchema.partial();

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

async function fetchPersonWithExtras(id: string) {
  const { data: person } = await supabaseAdmin
    .from('persons')
    .select(PERSON_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (!person) return null;
  const verifs = await hydrateVerificationsFor('person', [id]);
  return formatPerson(person, verifs);
}

// ---------------------------------------------------------------------------
// POST /service/persons
// ---------------------------------------------------------------------------

router.post('/persons', async (req, res, next) => {
  try {
    const body = validateRequest(personCreateSchema, req.body);
    const slug = body.slug || deriveSlug(body.name);

    if (!slug) throw createError('Could not derive valid slug', 400, 'VALIDATION_ERROR');

    const { data: created, error } = await supabaseAdmin
      .from('persons')
      .insert({
        slug,
        name: body.name,
        given_name: body.givenName || null,
        family_name: body.familyName || null,
        alternate_name: body.alternateName || null,
        description: body.description || null,
        image_url: body.image || null,
        url: body.url || null,
        same_as: body.sameAs || [],
        job_title: body.jobTitle || null,
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw createError(`Slug "${slug}" already in use`, 409, 'CONFLICT');
      }
      console.error('[SERVICE:PERSONS] Insert error:', error.message);
      throw createError('Failed to create person', 500, 'SERVER_ERROR');
    }

    const formatted = await fetchPersonWithExtras(created.id as string);
    res.status(201).json({ person: formatted });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /service/persons/:id
// ---------------------------------------------------------------------------

router.patch('/persons/:id', async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');

    // 1.0.0: only admin keys may edit Person records. Person-to-key linking
    // (analogous to api_key_organization_links) ships in a later minor version.
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Person editing requires an admin service key in 1.0.0', 403, 'INSUFFICIENT_TIER');
    }

    const body = validateRequest(personUpdateSchema, req.body);
    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.slug !== undefined) update.slug = body.slug;
    if (body.givenName !== undefined) update.given_name = body.givenName;
    if (body.familyName !== undefined) update.family_name = body.familyName;
    if (body.alternateName !== undefined) update.alternate_name = body.alternateName;
    if (body.description !== undefined) update.description = body.description;
    if (body.image !== undefined) update.image_url = body.image;
    if (body.url !== undefined) update.url = body.url;
    if (body.sameAs !== undefined) update.same_as = body.sameAs;
    if (body.jobTitle !== undefined) update.job_title = body.jobTitle;

    if (Object.keys(update).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const { error } = await supabaseAdmin
      .from('persons')
      .update(update)
      .eq('id', req.params.id);

    if (error) {
      if (error.code === '23505') {
        throw createError('Slug already in use', 409, 'CONFLICT');
      }
      console.error('[SERVICE:PERSONS] Update error:', error.message);
      throw createError('Failed to update person', 500, 'SERVER_ERROR');
    }

    const formatted = await fetchPersonWithExtras(req.params.id);
    if (!formatted) throw createError('Person not found', 404, 'NOT_FOUND');
    res.json({ person: formatted });
  } catch (err) {
    next(err);
  }
});

export default router;
