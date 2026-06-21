/**
 * Public takedown / content-report endpoint — Neighborhood Commons
 *
 * Anyone can file a content report against any event or organization.
 * Reports cover the full landscape of legitimate content
 * complaints (copyright, trademark, privacy, defamation, factual error,
 * other). The service-tier /api/v1/service/disputes endpoint is the
 * authenticated equivalent for app-to-app reporting; this surface is for
 * humans — venue owners, rights-holders, ordinary users.
 *
 * Captcha-gated when CAPTCHA_ENABLED=true (production default). Writes
 * an audit_log row and fires a fire-and-forget operator notification.
 *
 * The endpoint does NOT auto-flip the target row's status today —
 * operator reviews each report and takes action. The audit_log row is
 * the queue.
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest } from '../lib/helpers.js';
import { verifyTurnstile } from '../lib/captcha.js';
import { notifyOperator } from '../lib/operator-notify.js';
import { config } from '../config.js';

const router: ReturnType<typeof Router> = Router();

const reportInputSchema = z.object({
  // 'person' intentionally absent — Persons aren't a Commons primitive
  // (no-users doctrine), and there's no persons table to target post-migration
  // 079. Mirrors the same drop on the service-tier /disputes endpoint.
  target_type: z.enum(['event', 'organization']),
  target_id: z.string().uuid(),
  reason_category: z.enum([
    'copyright',
    'trademark',
    'privacy',
    'defamation',
    'factual_error',
    'other',
  ]),
  reason: z.string().min(20).max(2000),
  reporter_contact: z.string().email().max(200),
  captcha_token: z.string().min(1).optional(),
});

router.post('/', async (req, res, next) => {
  try {
    const body = validateRequest(reportInputSchema, req.body);

    // Captcha verification (skipped in development when CAPTCHA_ENABLED=false).
    if (config.captcha.enabled) {
      if (!body.captcha_token) {
        throw createError('captcha_token is required', 400, 'VALIDATION_ERROR');
      }
      const ok = await verifyTurnstile(body.captcha_token, req.ip);
      if (!ok) {
        throw createError('Captcha verification failed', 400, 'CAPTCHA_FAILED');
      }
    }

    const metadata = {
      target_type: body.target_type,
      target_id: body.target_id,
      reason_category: body.reason_category,
      reason: body.reason,
      reporter_contact: body.reporter_contact,
      reporter_ip_truncated: truncateIp(req.ip),
    };

    const { data, error } = await supabaseAdmin
      .from('audit_logs')
      .insert({
        action: 'content.reported',
        resource_id: body.target_id,
        metadata,
      })
      .select('id')
      .single();

    if (error || !data) {
      console.error('[REPORT] Audit log insert failed:', error?.message);
      throw createError('Failed to record report', 500, 'SERVER_ERROR');
    }

    notifyOperator({
      kind: 'report',
      targetType: body.target_type,
      targetId: body.target_id,
      reason: `[${body.reason_category}] ${body.reason}`,
      submitterContact: body.reporter_contact,
      submittedByApp: null,
      auditLogId: data.id,
    });

    res.status(201).json({
      id: data.id,
      status: 'received',
      message: 'Report received. The operator will review and respond if a contact email was provided.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Truncate IP to /24 (IPv4) or /48 (IPv6) for audit retention. Keeps a
 * coarse signal for abuse-detection without storing precise PII.
 */
function truncateIp(ip: string | undefined): string | null {
  if (!ip) return null;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 3).join(':') + '::/48';
  }
  return null;
}

export default router;
