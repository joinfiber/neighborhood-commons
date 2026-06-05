/**
 * Service-tier Organizations API — Neighborhood Commons 1.0.0
 *
 * Endpoints:
 *   POST   /service/organizations               — create
 *   PATCH  /service/organizations/:id           — update (linked or admin)
 *   POST   /service/organizations/link          — link this key to an existing org
 *   POST   /service/organizations/:id/logo      — upload logo (multipart)
 *   POST   /service/organizations/:id/image     — upload hero image (multipart)
 */

import { Router, json as expressJson } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest, validateUuidParam } from '../../lib/helpers.js';
import { processAndUploadImage } from '../../lib/image-processing.js';
import { formatOrganization } from '../v1-organizations.js';
import { hydrateVerificationsFor } from '../../lib/verification-hydrate.js';
import { assertLinkedOrganization } from './helpers-v1.js';
import { serviceLimiter } from '../../middleware/rate-limit.js';

const router: ReturnType<typeof Router> = Router();

const ORG_SELECT = `
  id, slug, name, legal_name,
  description, url, logo_url, image_url, telephone, email,
  same_as, keywords, opening_hours_specification,
  tags, commercial, method,
  primary_place_id, owner_account_id,
  created_at, updated_at
`;

const PLACE_SELECT_INLINE = `
  id, google_place_id, name,
  street_address, address_locality, address_region, postal_code, address_country,
  latitude, longitude, region_id, created_at, updated_at
`;

// Caller-facing provenance method (docs/provenance.md). Mirrors events'
// callerSourceMethod, plus `seeded` — the honest default for a bulk-imported
// org with no first-party assertion behind it yet. `method` is the authority
// signal consumers filter on, so it must reflect the *nature of the claim*,
// not the act of creation. (The bug this closes: every service-created org was
// hardcoded `self_asserted`, so the signal carried no information — a scraped
// Porchfest venue looked identical to a verified first-party org.) The
// stronger claims are gated by key authority in the handler below.
const callerOrgMethod = z.enum(['self_asserted', 'proxied', 'witnessed', 'seeded']);

const orgCreateSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().max(100).optional(),
  legalName: z.string().max(200).optional(),
  // Classify via tags + commercial — there is no `kind` discriminator.
  tags: z.array(z.string().max(50)).max(15).optional(),
  commercial: z.boolean().nullable().optional(),
  description: z.string().max(2000).optional(),
  url: z.string().url().max(2000).optional(),
  logo: z.string().url().max(2000).optional(),
  image: z.string().url().max(2000).optional(),
  telephone: z.string().max(50).optional(),
  email: z.string().email().optional(),
  sameAs: z.array(z.string().url()).max(20).optional(),
  keywords: z.array(z.string().max(50)).max(20).optional(),
  openingHoursSpecification: z.array(z.unknown()).optional(),
  primaryPlaceId: z.string().uuid().optional(),
  method: callerOrgMethod.optional(),
});

// Provenance is set at creation (or promoted by the verification path); it is
// not a generic editable field. Omitting `method` from the update shape keeps
// a PATCH from silently re-stamping authority — a seeded org earns
// self_asserted through verification, never through an ordinary profile edit.
const orgUpdateSchema = orgCreateSchema.omit({ method: true }).partial();

const linkSchema = z.object({
  organizationId: z.string().uuid(),
});

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

async function fetchOrgWithExtras(id: string) {
  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select(ORG_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (!org) return null;

  const placesById = new Map<string, Record<string, unknown>>();
  if (org.primary_place_id) {
    const { data: place } = await supabaseAdmin
      .from('places')
      .select(PLACE_SELECT_INLINE)
      .eq('id', org.primary_place_id)
      .maybeSingle();
    if (place) placesById.set(place.id as string, place);
  }
  const verifs = await hydrateVerificationsFor([id]);
  return formatOrganization(org, placesById, verifs);
}

// ---------------------------------------------------------------------------
// POST /service/organizations
// ---------------------------------------------------------------------------

router.post('/organizations', serviceLimiter, async (req, res, next) => {
  try {
    const body = validateRequest(orgCreateSchema, req.body);
    const slug = body.slug || deriveSlug(body.name);

    if (!slug || slug.length < 1) {
      throw createError('Could not derive a valid slug from name', 400, 'VALIDATION_ERROR');
    }

    // Provenance gate (docs/provenance.md). Default `seeded`: a bulk-imported
    // row with no first-party assertion yet — the safe, honest baseline. The
    // stronger claims each require standing, mirroring the events path; admin
    // keys (operator tools) bypass. Write-ownership (the auto-link below) stays
    // orthogonal — the creator can always edit what it created, whatever the
    // method.
    //   self_asserted — the org will have a claimed owner (the key is bound to
    //                   a tenant account, so owner_account_id is set below);
    //                   coherent with migration 085's owner⇒self_asserted
    //                   invariant. An ownerless org earns self_asserted instead
    //                   through verification (seeded→self_asserted promotion).
    //   proxied       — extracted from a public source; requires proxy_authority.
    //   witnessed     — collective observation; requires witness_authority.
    const method = body.method ?? 'seeded';
    if (!req.apiKeyInfo?.isAdmin) {
      if (method === 'self_asserted' && !req.apiKeyInfo?.tenantAccountId) {
        throw createError(
          'method=self_asserted requires a key bound to a tenant account (so the '
          + 'organization has a claimed owner) or an admin key. Orgs created without '
          + 'an owner are seeded and earn self_asserted through verification.',
          403,
          'INSUFFICIENT_TIER',
        );
      }
      if (method === 'proxied' && !req.apiKeyInfo?.proxyAuthority) {
        throw createError(
          'method=proxied requires a key with proxy_authority (or an admin key).',
          403,
          'INSUFFICIENT_TIER',
        );
      }
      if (method === 'witnessed' && !req.apiKeyInfo?.witnessAuthority) {
        throw createError(
          'method=witnessed requires a key with witness_authority (or an admin key).',
          403,
          'INSUFFICIENT_TIER',
        );
      }
    }

    const { data: created, error } = await supabaseAdmin
      .from('organizations')
      .insert({
        slug,
        name: body.name,
        legal_name: body.legalName || null,
        tags: body.tags || [],
        commercial: body.commercial ?? null,
        description: body.description || null,
        url: body.url || null,
        logo_url: body.logo || null,
        image_url: body.image || null,
        telephone: body.telephone || null,
        email: body.email || null,
        same_as: body.sameAs || [],
        keywords: body.keywords || [],
        opening_hours_specification: body.openingHoursSpecification || null,
        primary_place_id: body.primaryPlaceId || null,
        // Trusted-tenant pattern: if the calling key has a tenant_account_id,
        // the new organization is owned by that account. This satisfies the
        // photo-eligibility gate for tenant-umbrella consumers (Merrie etc.)
        // without per-publisher portal_accounts. Keys without a tenant
        // account create orgs with owner_account_id=NULL — those orgs work
        // for everything except photo uploads.
        owner_account_id: req.apiKeyInfo?.tenantAccountId ?? null,
        // Contributor attribution (migration 090): the registered profile this
        // key publishes under, snapshotted so source.contributor on the org
        // survives api_key rotation. Mirrors events.contributor_profile_id.
        contributor_profile_id: req.apiKeyInfo?.contributorProfileId ?? null,
        // Provenance (docs/provenance.md). Caller-declared, gated above,
        // defaulting to `seeded`. This is the authority signal — it names how
        // the claim came to be, independent of who may edit the row.
        method,
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw createError(`Slug "${slug}" already in use`, 409, 'CONFLICT');
      }
      console.error('[SERVICE:ORGS] Insert error:', error.message);
      throw createError('Failed to create organization', 500, 'SERVER_ERROR');
    }

    // Auto-link the calling key to the new organization
    if (req.apiKeyInfo) {
      await supabaseAdmin
        .from('api_key_organization_links')
        .insert({
          api_key_id: req.apiKeyInfo.id,
          organization_id: created.id,
        })
        .select('api_key_id')
        .maybeSingle();
    }

    const formatted = await fetchOrgWithExtras(created.id as string);
    res.status(201).json({ organization: formatted });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /service/organizations/:id
// ---------------------------------------------------------------------------

router.patch('/organizations/:id', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    await assertLinkedOrganization(req, req.params.id);

    const body = validateRequest(orgUpdateSchema, req.body);

    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.slug !== undefined) update.slug = body.slug;
    if (body.legalName !== undefined) update.legal_name = body.legalName;
    if (body.tags !== undefined) update.tags = body.tags;
    if (body.commercial !== undefined) update.commercial = body.commercial;
    if (body.description !== undefined) update.description = body.description;
    if (body.url !== undefined) update.url = body.url;
    if (body.logo !== undefined) update.logo_url = body.logo;
    if (body.image !== undefined) update.image_url = body.image;
    if (body.telephone !== undefined) update.telephone = body.telephone;
    if (body.email !== undefined) update.email = body.email;
    if (body.sameAs !== undefined) update.same_as = body.sameAs;
    if (body.keywords !== undefined) update.keywords = body.keywords;
    if (body.openingHoursSpecification !== undefined) update.opening_hours_specification = body.openingHoursSpecification;
    if (body.primaryPlaceId !== undefined) update.primary_place_id = body.primaryPlaceId;

    if (Object.keys(update).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const { error } = await supabaseAdmin
      .from('organizations')
      .update(update)
      .eq('id', req.params.id);

    if (error) {
      if (error.code === '23505') {
        throw createError('Slug already in use', 409, 'CONFLICT');
      }
      console.error('[SERVICE:ORGS] Update error:', error.message);
      throw createError('Failed to update organization', 500, 'SERVER_ERROR');
    }

    const formatted = await fetchOrgWithExtras(req.params.id);
    res.json({ organization: formatted });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /service/organizations/link
// ---------------------------------------------------------------------------

router.post('/organizations/link', serviceLimiter, async (req, res, next) => {
  try {
    const body = validateRequest(linkSchema, req.body);

    // Confirm the org exists and read its owner.
    const { data: org } = await supabaseAdmin
      .from('organizations')
      .select('id, owner_account_id')
      .eq('id', body.organizationId)
      .maybeSingle();
    if (!org) throw createError('Organization not found', 404, 'NOT_FOUND');

    // Authorization: linking grants write authority (every assertLinked* check
    // authorizes on the presence of a link row), so linking itself must be gated
    // on a real ownership relationship — never mere existence. A key may link
    // only to an organization owned by its own tenant account (e.g. re-linking a
    // key the create-time auto-link didn't cover); admin keys bypass. Otherwise
    // any activated key could self-grant control of any organization. Orgs are
    // auto-linked to their creator at create time, so this path is rarely needed.
    const tenantId = req.apiKeyInfo?.tenantAccountId ?? null;
    const owns = tenantId !== null && org.owner_account_id === tenantId;
    if (!req.apiKeyInfo?.isAdmin && !owns) {
      throw createError(
        'This key may only link to organizations owned by its own account. '
        + 'Linking to an organization you do not own requires operator approval.',
        403,
        'NOT_LINKED',
      );
    }

    // Idempotent: 200 if the link already existed, 201 if newly created.
    const { data: existing } = await supabaseAdmin
      .from('api_key_organization_links')
      .select('api_key_id')
      .eq('api_key_id', req.apiKeyInfo!.id)
      .eq('organization_id', body.organizationId)
      .maybeSingle();

    if (!existing) {
      const { error } = await supabaseAdmin
        .from('api_key_organization_links')
        .insert({ api_key_id: req.apiKeyInfo!.id, organization_id: body.organizationId });
      if (error) {
        console.error('[SERVICE:ORGS] Link error:', error.message);
        throw createError('Failed to link organization', 500, 'SERVER_ERROR');
      }
    }

    const formatted = await fetchOrgWithExtras(body.organizationId);
    res.status(existing ? 200 : 201).json({ organization: formatted });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /service/organizations/:id/logo  — JSON: { image: <base64> }
// POST /service/organizations/:id/image — JSON: { image: <base64> }
//
// Matches the legacy /service/accounts/:id/{logo,cover-image} pattern.
// Multipart file upload can be layered in a follow-up; base64 JSON works
// fine for the consumer apps we have today (Merrie, Holler, Studio).
// ---------------------------------------------------------------------------

const imageBodyLimit = expressJson({ limit: '12mb' });

const imageBodySchema = z.object({ image: z.string().min(1) });

function imageUploadHandler(target: 'logo_url' | 'image_url') {
  return async (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    try {
      validateUuidParam(req.params.id, 'id');
      await assertLinkedOrganization(req, req.params.id);

      const body = validateRequest(imageBodySchema, req.body);
      const url = await processAndUploadImage(req.params.id, body.image);

      const { error } = await supabaseAdmin
        .from('organizations')
        .update({ [target]: url })
        .eq('id', req.params.id);

      if (error) {
        console.error('[SERVICE:ORGS] Image update error:', error.message);
        throw createError('Failed to update image URL', 500, 'SERVER_ERROR');
      }

      const formatted = await fetchOrgWithExtras(req.params.id);
      res.json({ organization: formatted });
    } catch (err) {
      next(err);
    }
  };
}

router.post('/organizations/:id/logo', imageBodyLimit, serviceLimiter, imageUploadHandler('logo_url'));
router.post('/organizations/:id/image', imageBodyLimit, serviceLimiter, imageUploadHandler('image_url'));

export default router;
