/**
 * Service-tier Disputes API — Neighborhood Commons 1.0.0
 *
 * App-to-app dispute recording. The companion public endpoint
 * /api/v1/report covers human-filed content reports; this endpoint is
 * for service-tier writers reporting structural issues like wrong
 * verification or duplicate entities.
 *
 * On every submission: an audit_log row is written AND a fire-and-forget
 * operator email is dispatched (notifyOperator). No automated row
 * status mutation yet — operator reviews and acts via Supabase admin
 * tooling. Audit log entry is the load-bearing record.
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest } from '../../lib/helpers.js';
import { notifyOperator } from '../../lib/operator-notify.js';

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

    notifyOperator({
      kind: 'dispute',
      targetType: body.targetType,
      targetId: body.targetId,
      reason: body.reason,
      submitterContact: body.submitterContact || null,
      submittedByApp: req.apiKeyInfo?.brandConfig?.app_name || null,
      auditLogId: data.id,
    });

    res.status(201).json({ id: data.id, status: 'recorded' });
  } catch (err) {
    next(err);
  }
});

export default router;
