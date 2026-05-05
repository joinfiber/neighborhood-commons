/**
 * Public Verifiers API — Neighborhood Commons 1.0.0
 *
 * The reputation graph. One entry per app that has ever issued a verification.
 * Apps reading the Commons use these counts to compose `verified_by` filters
 * that match their trust policy. Maximum sunlight — anyone can audit.
 *
 * Base: /api/v1/verifiers
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from '../middleware/error-handler.js';
import { validateRequest } from '../lib/helpers.js';
import { optionalApiKey } from '../middleware/api-key.js';

const router: ReturnType<typeof Router> = Router();
router.use(optionalApiKey);

export const verifiersLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.apiKeyInfo?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded (1000/hr).' } },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// GET /api/v1/verifiers
//
// Aggregates account_verified_identifiers by approved_by_app. v1 implements
// this with a fetch-and-aggregate-in-JS approach, which is fine while the
// table is small. If/when verification volume grows past ~100k rows, swap
// to a materialized view or RPC function.
// ---------------------------------------------------------------------------

router.get('/', async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('account_verified_identifiers')
      .select('approved_by_app, method, status, verified_at, evidence')
      .order('verified_at', { ascending: true });

    if (error) {
      console.error('[V1:VERIFIERS] Query error:', error.message);
      throw createError('Failed to fetch verifiers', 500, 'SERVER_ERROR');
    }

    type Aggregate = {
      appName: string;
      firstApprovalAt: string | null;
      approvalCount: number;
      activeCount: number;
      revokedCount: number;
      methods: Set<string>;
    };

    const byApp = new Map<string, Aggregate>();
    for (const row of data || []) {
      const app = row.approved_by_app as string;
      if (!byApp.has(app)) {
        byApp.set(app, {
          appName: app,
          firstApprovalAt: row.verified_at as string,
          approvalCount: 0,
          activeCount: 0,
          revokedCount: 0,
          methods: new Set(),
        });
      }
      const agg = byApp.get(app)!;
      agg.approvalCount++;
      if (row.status === 'active') agg.activeCount++;
      if (row.status === 'revoked') agg.revokedCount++;

      // Build the method:context string (e.g., "manual_review:in_person")
      const method = row.method as string;
      const evidence = (row.evidence || {}) as Record<string, unknown>;
      const verifiedVia = evidence.verifiedVia as string | undefined;
      agg.methods.add(verifiedVia ? `${method}:${verifiedVia}` : method);
    }

    const verifiers = Array.from(byApp.values())
      .map(a => ({
        appName: a.appName,
        firstApprovalAt: a.firstApprovalAt,
        approvalCount: a.approvalCount,
        activeCount: a.activeCount,
        revokedCount: a.revokedCount,
        methods: Array.from(a.methods).sort(),
      }))
      .sort((a, b) => b.approvalCount - a.approvalCount);

    res.set('Cache-Control', 'public, max-age=300');
    res.json({ verifiers });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/verifiers/:appName/recent_approvals
// ---------------------------------------------------------------------------

const recentApprovalsSchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional(),
});

router.get('/:appName/recent_approvals', async (req, res, next) => {
  try {
    const params = validateRequest(recentApprovalsSchema, req.query);
    const limit = params.limit || 50;
    const appName = req.params.appName;

    const { data, error } = await supabaseAdmin
      .from('account_verified_identifiers')
      .select('verified_at, method, target_type, target_id, status, evidence')
      .eq('approved_by_app', appName)
      .order('verified_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[V1:VERIFIERS] Recent approvals query error:', error.message);
      throw createError('Failed to fetch recent approvals', 500, 'SERVER_ERROR');
    }
    if (!data || data.length === 0) {
      // Return 404 only if the verifier app has never approved anything (consistent with the spec).
      throw createError('Verifier not found or has no approvals', 404, 'NOT_FOUND');
    }

    // Hydrate target names — the public spot-check is more useful with names than UUIDs.
    const orgIds = data.filter(r => r.target_type === 'organization').map(r => r.target_id as string);
    const personIds = data.filter(r => r.target_type === 'person').map(r => r.target_id as string);

    const [orgsRes, personsRes] = await Promise.all([
      orgIds.length > 0
        ? supabaseAdmin.from('organizations').select('id, name').in('id', orgIds)
        : Promise.resolve({ data: [] }),
      personIds.length > 0
        ? supabaseAdmin.from('persons').select('id, name').in('id', personIds)
        : Promise.resolve({ data: [] }),
    ]);

    const namesById = new Map<string, string>();
    for (const o of orgsRes.data || []) namesById.set(o.id as string, o.name as string);
    for (const p of personsRes.data || []) namesById.set(p.id as string, p.name as string);

    const approvals = data.map(r => {
      const evidence = (r.evidence || {}) as Record<string, unknown>;
      const verifiedVia = evidence.verifiedVia as string | undefined;
      return {
        verifiedAt: r.verified_at,
        method: verifiedVia ? `${r.method}:${verifiedVia}` : r.method,
        targetType: r.target_type,
        targetId: r.target_id,
        targetName: namesById.get(r.target_id as string) || null,
        status: r.status,
      };
    });

    res.set('Cache-Control', 'public, max-age=60');
    res.json({ approvals });
  } catch (err) {
    next(err);
  }
});

export default router;
