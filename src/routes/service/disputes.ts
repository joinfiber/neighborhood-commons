/**
 * Service-tier Disputes API — Neighborhood Commons 1.0.0
 *
 * Minimum-viable dispute recording. Stores claims for operator review;
 * no automated action in 1.0.0. Acts as the entry point for "this
 * verification is wrong" feedback into the system. The operator
 * (Studio) reviews via Supabase admin tooling for now; a dedicated
 * admin endpoint can land in a later minor version.
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest } from '../../lib/helpers.js';

const router: ReturnType<typeof Router> = Router();

const disputeInputSchema = z.object({
  targetType: z.enum(['organization', 'person', 'verified_identifier']),
  targetId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  submitterContact: z.string().max(200).optional(),
});

// Disputes are stored in audit_logs as a structured action — no dedicated
// table in 1.0.0 (kept thin). When the dispute volume justifies a queue,
// promote to its own table in a follow-up minor version.

router.post('/disputes', async (req, res, next) => {
  try {
    const body = validateRequest(disputeInputSchema, req.body);

    const metadata = {
      target_type: body.targetType,
      target_id: body.targetId,
      reason: body.reason,
      submitter_contact: body.submitterContact || null,
      submitted_by_key: req.apiKeyInfo?.id || null,
      submitted_by_app: req.apiKeyInfo?.brandConfig?.app_name || null,
    };

    const { data, error } = await supabaseAdmin
      .from('audit_logs')
      .insert({
        action: 'dispute.submitted',
        resource_id: body.targetId,
        metadata,
      })
      .select('id')
      .single();

    if (error || !data) {
      console.error('[SERVICE:DISPUTES] Insert error:', error?.message);
      throw createError('Failed to record dispute', 500, 'SERVER_ERROR');
    }

    res.status(201).json({ id: data.id, status: 'recorded' });
  } catch (err) {
    next(err);
  }
});

export default router;
