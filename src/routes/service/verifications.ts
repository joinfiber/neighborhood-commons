/**
 * Service-tier Verifications API — Neighborhood Commons v2
 *
 * Endpoints:
 *   GET   /service/verifications/path                       — routing authority
 *   POST  /service/verifications/challenges                 — auto-track issue code
 *   POST  /service/verifications/challenges/:id/confirm     — auto-track confirm code
 *   POST  /service/verifications/manual                     — slow-track submit evidence
 *   GET   /service/verifications/pending                    — admin queue
 *   POST  /service/verifications/pending/:id/approve        — admin approve
 *   POST  /service/verifications/pending/:id/reject         — admin reject
 *
 * v2: only organizations verify. The Person target is gone. Heavy-rigor
 * rigor classification uses organizations.commercial (replaces the legacy
 * kind enum). Verified identifiers land in organization_verifications
 * (which replaced account_verified_identifiers in migration 080/082).
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest, validateUuidParam } from '../../lib/helpers.js';
import { sendEmailWithSender } from '../../lib/email.js';
import {
  decideVerificationPath,
  findExistingVerifiedIdentifier,
  generateVerificationCode,
  hashVerificationCode,
  hasVerificationAuthority,
  isPersonalEmailDomain,
} from '../../lib/verification.js';

const router: ReturnType<typeof Router> = Router();

const CHALLENGE_TTL_MINUTES = 30;
const MAX_CONFIRM_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// GET /service/verifications/path
// ---------------------------------------------------------------------------

const pathQuerySchema = z.object({
  organization_id: z.string().uuid(),
  identifier_type: z.enum(['email']),
  identifier_value: z.string().email(),
});

router.get('/verifications/path', async (req, res, next) => {
  try {
    const params = validateRequest(pathQuerySchema, req.query);
    const value = params.identifier_value.toLowerCase();

    const existing = await findExistingVerifiedIdentifier(
      params.organization_id,
      params.identifier_type,
      value,
    );
    if (existing) {
      res.json({
        alreadyVerified: true,
        existingIdentifier: {
          identifierType: existing.identifier_type,
          identifierValue: existing.identifier_value,
          method: existing.method,
          verifiedAt: existing.verified_at,
          verifiedByApp: existing.approved_by_app,
          status: existing.status,
        },
      });
      return;
    }

    const decision = await decideVerificationPath(
      params.organization_id,
      params.identifier_type,
      value,
    );
    if (!decision) {
      throw createError('Organization not found', 404, 'NOT_FOUND');
    }

    res.json({
      alreadyVerified: false,
      requiredMethod: decision.requiredMethod,
      endpoint: decision.endpoint,
      reason: decision.reason,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /service/verifications/challenges
// ---------------------------------------------------------------------------

const challengeInputSchema = z.object({
  organizationId: z.string().uuid(),
  identifierType: z.enum(['email']),
  identifierValue: z.string().email(),
});

router.post('/verifications/challenges', async (req, res, next) => {
  try {
    const body = validateRequest(challengeInputSchema, req.body);
    const value = body.identifierValue.toLowerCase();

    // Routing enforcement: commercial (heavy-rigor) orgs with personal-email
    // → must use manual path.
    const { data: org } = await supabaseAdmin
      .from('organizations')
      .select('commercial')
      .eq('id', body.organizationId)
      .maybeSingle();
    if (!org) throw createError('Organization not found', 404, 'NOT_FOUND');

    if (org.commercial === true && isPersonalEmailDomain(value)) {
      throw createError(
        'Personal email domains require manual review for commercial organizations. Submit via POST /v1/service/verifications/manual.',
        409,
        'WRONG_METHOD',
      );
    }

    // Generate code + hash
    const { code, hash } = generateVerificationCode();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MINUTES * 60 * 1000).toISOString();

    const { data: challenge, error } = await supabaseAdmin
      .from('verification_challenges')
      .insert({
        target_type: 'organization',
        target_id: body.organizationId,
        identifier_type: body.identifierType,
        identifier_value: value,
        code_hash: hash,
        expires_at: expiresAt,
        brand_key_id: req.apiKeyInfo!.id,
      })
      .select('id, expires_at')
      .single();

    if (error || !challenge) {
      console.error('[SERVICE:VERIFICATIONS] Challenge insert error:', error?.message);
      throw createError('Failed to create challenge', 500, 'SERVER_ERROR');
    }

    // Send the code via email — using the calling key's brand_config for sender identity
    const brand = req.apiKeyInfo?.brandConfig;
    const appName = brand?.app_name || 'Neighborhood Commons';
    const subject = brand?.subjects?.verification || `Your ${appName} verification code`;
    const html = `<p>Your verification code is: <strong style="font-size:1.4rem;letter-spacing:0.1em;">${code}</strong></p>
<p>This code expires in ${CHALLENGE_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.</p>
<p style="color:#888;font-size:0.85rem;">— ${appName}</p>`;

    try {
      await sendEmailWithSender({
        to: value,
        subject,
        html,
        fromEmail: brand?.from_email,
        fromName: brand?.from_name,
      });
    } catch (e) {
      // Email send failure shouldn't expose details, but log them
      console.error('[SERVICE:VERIFICATIONS] Email send failed:', e);
      // The challenge row exists; the user can request another via re-call.
    }

    res.status(201).json({
      challengeId: challenge.id,
      expiresAt: challenge.expires_at,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /service/verifications/challenges/:id/confirm
// ---------------------------------------------------------------------------

const confirmInputSchema = z.object({ code: z.string().min(1).max(20) });

router.post('/verifications/challenges/:id/confirm', async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'id');
    const body = validateRequest(confirmInputSchema, req.body);

    const { data: challenge } = await supabaseAdmin
      .from('verification_challenges')
      .select('id, target_id, identifier_type, identifier_value, code_hash, expires_at, consumed_at, attempts, brand_key_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!challenge) throw createError('Challenge not found or expired', 404, 'NOT_FOUND');

    if (challenge.consumed_at) {
      throw createError('Challenge already consumed', 409, 'CONFLICT');
    }
    if (new Date(challenge.expires_at as string).getTime() < Date.now()) {
      throw createError('Challenge expired', 404, 'NOT_FOUND');
    }
    if ((challenge.attempts as number) >= MAX_CONFIRM_ATTEMPTS) {
      throw createError('Too many attempts on this challenge', 429, 'RATE_LIMIT');
    }

    const submittedHash = hashVerificationCode(body.code.trim());
    if (submittedHash !== (challenge.code_hash as string)) {
      // Bump attempts; do not reveal which character was wrong, etc.
      await supabaseAdmin
        .from('verification_challenges')
        .update({ attempts: (challenge.attempts as number) + 1 })
        .eq('id', req.params.id);

      res.status(200).json({
        status: 'rejected',
        reason: 'invalid_code',
      });
      return;
    }

    // Mark consumed AND insert verified identifier in a best-effort sequence.
    const consumedAt = new Date().toISOString();
    await supabaseAdmin
      .from('verification_challenges')
      .update({ consumed_at: consumedAt })
      .eq('id', req.params.id);

    const value = (challenge.identifier_value as string).toLowerCase();
    const appName = req.apiKeyInfo?.brandConfig?.app_name || 'Neighborhood Commons';

    const { data: identifier, error: insertErr } = await supabaseAdmin
      .from('organization_verifications')
      .insert({
        organization_id: challenge.target_id,
        identifier_type: challenge.identifier_type,
        identifier_value: value,
        method: 'domain_email_loop',
        approved_by_app: appName,
        approved_by_key: req.apiKeyInfo!.id,
      })
      .select('id, verified_at, identifier_type, identifier_value, method, approved_by_app, status')
      .single();

    if (insertErr) {
      // If unique constraint hit, the (org, identifier) is already verified —
      // surface that as success rather than error.
      if (insertErr.code === '23505') {
        const existing = await findExistingVerifiedIdentifier(
          challenge.target_id as string,
          challenge.identifier_type as 'email',
          value,
        );
        if (existing) {
          res.json({
            status: 'verified',
            verifiedAt: existing.verified_at,
            method: existing.method,
            identifier: {
              identifierType: existing.identifier_type,
              identifierValue: existing.identifier_value,
              method: existing.method,
              verifiedAt: existing.verified_at,
              verifiedByApp: existing.approved_by_app,
              status: existing.status,
            },
          });
          return;
        }
      }
      console.error('[SERVICE:VERIFICATIONS] Identifier insert error:', insertErr.message);
      throw createError('Failed to record verified identifier', 500, 'SERVER_ERROR');
    }

    res.json({
      status: 'verified',
      verifiedAt: identifier!.verified_at,
      method: identifier!.method,
      identifier: {
        identifierType: identifier!.identifier_type,
        identifierValue: identifier!.identifier_value,
        method: identifier!.method,
        verifiedAt: identifier!.verified_at,
        verifiedByApp: identifier!.approved_by_app,
        status: identifier!.status,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /service/verifications/manual
// ---------------------------------------------------------------------------

const manualInputSchema = z.object({
  organizationId: z.string().uuid(),
  identifierType: z.enum(['email']),
  identifierValue: z.string().email(),
  evidence: z.object({
    phone: z.string().min(1),
    verifiedVia: z.enum(['in_person', 'video_call']),
    reviewerAttestation: z.string().min(1).max(2000),
    reviewerAccountId: z.string().min(1),
    businessAddressObserved: z.boolean(),
    idDocumentObserved: z.boolean(),
    supportingNotes: z.string().max(2000).optional(),
  }),
});

router.post('/verifications/manual', async (req, res, next) => {
  try {
    const body = validateRequest(manualInputSchema, req.body);
    const value = body.identifierValue.toLowerCase();

    // Routing enforcement: commercial org + business-email domain → should
    // use auto-track challenge path. Manual is for heavy-rigor + personal-email.
    const { data: org } = await supabaseAdmin
      .from('organizations')
      .select('commercial')
      .eq('id', body.organizationId)
      .maybeSingle();
    if (!org) throw createError('Organization not found', 404, 'NOT_FOUND');

    const heavy = org.commercial === true;
    if (heavy && !isPersonalEmailDomain(value)) {
      throw createError(
        'Business email domains use the auto-track challenge path. Submit via POST /v1/service/verifications/challenges.',
        409,
        'WRONG_METHOD',
      );
    }

    // Does the calling key have authority to auto-approve manual_review:in_person/video_call?
    const autoApprove = hasVerificationAuthority(req, 'manual_review', body.evidence.verifiedVia);
    const appName = req.apiKeyInfo?.brandConfig?.app_name || 'unknown';

    if (autoApprove) {
      const { data: identifier, error } = await supabaseAdmin
        .from('organization_verifications')
        .insert({
          organization_id: body.organizationId,
          identifier_type: body.identifierType,
          identifier_value: value,
          method: 'manual_review',
          approved_by_app: appName,
          approved_by_key: req.apiKeyInfo!.id,
          evidence: body.evidence,
        })
        .select('id, verified_at, method, identifier_type, identifier_value, approved_by_app, status')
        .single();

      if (error) {
        if (error.code === '23505') {
          throw createError('Identifier already verified for this organization', 409, 'CONFLICT');
        }
        console.error('[SERVICE:VERIFICATIONS] Manual auto-approve insert error:', error.message);
        throw createError('Failed to record verified identifier', 500, 'SERVER_ERROR');
      }

      res.json({
        status: 'verified',
        verifiedAt: identifier!.verified_at,
        method: identifier!.method,
        identifier: {
          identifierType: identifier!.identifier_type,
          identifierValue: identifier!.identifier_value,
          method: identifier!.method,
          verifiedAt: identifier!.verified_at,
          verifiedByApp: identifier!.approved_by_app,
          status: identifier!.status,
        },
      });
      return;
    }

    // No authority → queue for admin review
    const { data: review, error } = await supabaseAdmin
      .from('verification_pending_reviews')
      .insert({
        target_type: 'organization',
        target_id: body.organizationId,
        identifier_type: body.identifierType,
        identifier_value: value,
        method: 'manual_review',
        submitted_by_key: req.apiKeyInfo!.id,
        evidence: body.evidence,
      })
      .select('id')
      .single();

    if (error || !review) {
      console.error('[SERVICE:VERIFICATIONS] Manual queue insert error:', error?.message);
      throw createError('Failed to submit manual review', 500, 'SERVER_ERROR');
    }

    res.json({ status: 'pending', reviewId: review.id });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin queue: list, approve, reject
// ---------------------------------------------------------------------------

function requireAdmin(req: import('express').Request) {
  if (!req.apiKeyInfo?.isAdmin) {
    throw createError('Admin access required', 403, 'INSUFFICIENT_TIER');
  }
}

const pendingListSchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

router.get('/verifications/pending', async (req, res, next) => {
  try {
    requireAdmin(req);
    const params = validateRequest(pendingListSchema, req.query);
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    const { data, error } = await supabaseAdmin
      .from('verification_pending_reviews')
      .select('id, target_type, target_id, identifier_type, identifier_value, method, submitted_by_key, evidence, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('[SERVICE:VERIFICATIONS] Pending list error:', error.message);
      throw createError('Failed to fetch pending reviews', 500, 'SERVER_ERROR');
    }

    // Hydrate submitted_by_key → app name for visual context
    const keyIds = Array.from(new Set((data || []).map(r => r.submitted_by_key as string)));
    const keysById = new Map<string, string>();
    if (keyIds.length > 0) {
      const { data: keys } = await supabaseAdmin
        .from('api_keys')
        .select('id, brand_config, name')
        .in('id', keyIds);
      for (const k of keys || []) {
        const brand = k.brand_config as Record<string, unknown> | null;
        keysById.set(k.id as string, (brand?.app_name as string) || (k.name as string) || 'unknown');
      }
    }

    const reviews = (data || []).map(r => ({
      id: r.id,
      organizationId: r.target_id,
      identifierType: r.identifier_type,
      identifierValue: r.identifier_value,
      method: r.method,
      submittedByApp: keysById.get(r.submitted_by_key as string) || 'unknown',
      evidence: r.evidence,
      createdAt: r.created_at,
    }));

    res.json({ reviews });
  } catch (err) {
    next(err);
  }
});

router.post('/verifications/pending/:id/approve', async (req, res, next) => {
  try {
    requireAdmin(req);
    validateUuidParam(req.params.id, 'id');

    const { data: review } = await supabaseAdmin
      .from('verification_pending_reviews')
      .select('id, status, target_id, identifier_type, identifier_value, method, submitted_by_key, evidence')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!review) throw createError('Review not found', 404, 'NOT_FOUND');
    if (review.status !== 'pending') throw createError('Review already decided', 409, 'CONFLICT');

    // Resolve approving app name (snapshot)
    const appName = req.apiKeyInfo?.brandConfig?.app_name || 'Neighborhood Commons';
    const value = (review.identifier_value as string).toLowerCase();

    const { data: identifier, error: insertErr } = await supabaseAdmin
      .from('organization_verifications')
      .insert({
        organization_id: review.target_id,
        identifier_type: review.identifier_type,
        identifier_value: value,
        method: review.method,
        approved_by_app: appName,
        approved_by_key: req.apiKeyInfo!.id,
        evidence: review.evidence,
      })
      .select('id, verified_at, method, identifier_type, identifier_value, approved_by_app, status')
      .single();

    if (insertErr) {
      if (insertErr.code === '23505') {
        throw createError('Identifier already verified', 409, 'CONFLICT');
      }
      console.error('[SERVICE:VERIFICATIONS] Approve insert error:', insertErr.message);
      throw createError('Failed to approve review', 500, 'SERVER_ERROR');
    }

    await supabaseAdmin
      .from('verification_pending_reviews')
      .update({
        status: 'approved',
        reviewed_by_key: req.apiKeyInfo!.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);

    res.json({
      status: 'verified',
      verifiedAt: identifier!.verified_at,
      method: identifier!.method,
      identifier: {
        identifierType: identifier!.identifier_type,
        identifierValue: identifier!.identifier_value,
        method: identifier!.method,
        verifiedAt: identifier!.verified_at,
        verifiedByApp: identifier!.approved_by_app,
        status: identifier!.status,
      },
    });
  } catch (err) {
    next(err);
  }
});

const rejectInputSchema = z.object({
  reason: z.enum(['INSUFFICIENT_EVIDENCE', 'IDENTIFIER_DISPUTED', 'IMPOSTER_SIGNALS', 'OUT_OF_POLICY']),
  note: z.string().max(1000).optional(),
});

router.post('/verifications/pending/:id/reject', async (req, res, next) => {
  try {
    requireAdmin(req);
    validateUuidParam(req.params.id, 'id');
    const body = validateRequest(rejectInputSchema, req.body);

    const { data: review } = await supabaseAdmin
      .from('verification_pending_reviews')
      .select('status')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!review) throw createError('Review not found', 404, 'NOT_FOUND');
    if (review.status !== 'pending') throw createError('Review already decided', 409, 'CONFLICT');

    const decisionReason = body.note ? `${body.reason}: ${body.note}` : body.reason;

    await supabaseAdmin
      .from('verification_pending_reviews')
      .update({
        status: 'rejected',
        reviewed_by_key: req.apiKeyInfo!.id,
        reviewed_at: new Date().toISOString(),
        decision_reason: decisionReason,
      })
      .eq('id', req.params.id);

    res.status(200).json({ status: 'rejected', reason: body.reason });
  } catch (err) {
    next(err);
  }
});

export default router;
