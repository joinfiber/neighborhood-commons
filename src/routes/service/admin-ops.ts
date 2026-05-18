/**
 * Service API — Admin-gated operations
 *
 * All routes here require the calling service key to have is_admin=true.
 * Segregated in one file so the `isAdmin` gate is easy to audit and so
 * the non-admin files stay free of the pattern.
 *
 * Endpoints:
 *   - GET  /service/stats
 *   - GET  /service/api-keys
 *   - POST /service/api-keys
 *   - PATCH /service/api-keys/:id
 *   - POST /service/api-keys/:id/activate
 *   - POST /service/migrate-image-urls
 *   - GET/POST/DELETE /service/approved-domains
 *   - GET /service/domain-approval-requests
 *   - POST /service/domain-approval-requests/:id/{approve,reject}
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateRequest, validateUuidParam } from '../../lib/helpers.js';
import { serviceLimiter } from '../../middleware/rate-limit.js';
import { MANAGED_SOURCES } from '../../lib/event-operations.js';
import { invalidateApprovedDomainsCache } from '../../lib/url-sanitizer.js';
import { config } from '../../config.js';

const router: ReturnType<typeof Router> = Router();

// =============================================================================
// STATS
// =============================================================================

/** GET /service/stats — Platform statistics + category distribution */
router.get('/stats', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    // Run account and event counts in parallel
    const [accountCounts, oneOffCount, seriesCount, categoryRows] = await Promise.all([
      // Account counts: use head:true to avoid fetching rows
      supabaseAdmin.from('portal_accounts').select('id', { count: 'exact', head: true }),

      // One-off events
      supabaseAdmin.from('events')
        .select('id', { count: 'exact', head: true })
        .in('source', [...MANAGED_SOURCES])
        .is('series_id', null),

      // Series (representative instance: 0 = ongoing, 1 = first of bounded)
      supabaseAdmin.from('events')
        .select('id', { count: 'exact', head: true })
        .in('source', [...MANAGED_SOURCES])
        .not('series_id', 'is', null)
        .or('series_instance_number.eq.0,series_instance_number.eq.1'),

      // Category distribution — only fetch unique events (one-offs + first instances)
      // Use minimal select to reduce payload
      supabaseAdmin.from('events')
        .select('category')
        .in('source', [...MANAGED_SOURCES])
        .or('series_id.is.null,series_instance_number.eq.0,series_instance_number.eq.1')
        .limit(10000),
    ]);

    // Account breakdowns need status/claimed_at — separate lightweight query
    const { data: accountStatuses } = await supabaseAdmin
      .from('portal_accounts')
      .select('status, claimed_at')
      .limit(10000);

    const totalAccounts = accountCounts.count || 0;
    const claimedAccounts = accountStatuses?.filter((a) => a.claimed_at).length || 0;
    const pendingAccounts = accountStatuses?.filter((a) => a.status === 'pending').length || 0;

    const totalEvents = (oneOffCount.count || 0) + (seriesCount.count || 0);

    const category_distribution: Record<string, number> = {};
    if (categoryRows.data) {
      for (const row of categoryRows.data) {
        const cat = (row as Record<string, unknown>).category as string || 'uncategorized';
        category_distribution[cat] = (category_distribution[cat] || 0) + 1;
      }
    }

    res.json({
      stats: {
        total_accounts: totalAccounts,
        claimed_accounts: claimedAccounts,
        pending_accounts: pendingAccounts,
        total_events: totalEvents,
        category_distribution,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// API KEYS
// =============================================================================

/** GET /service/api-keys — List all API keys with event stats */
router.get('/api-keys', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    const { data: keys, error } = await supabaseAdmin
      .from('api_keys')
      .select('id, key_prefix, name, url, contact_email, rate_limit_per_hour, status, contributor_tier, last_used_at, created_at')
      .order('created_at', { ascending: false });

    if (error) throw createError('Failed to list API keys', 500, 'SERVER_ERROR');

    // Fetch event counts and last submission per API key
    const keyIds = (keys || []).map((k) => k.id);
    const eventStats: Record<string, { event_count: number; last_submitted_at: string | null; pending_count: number }> = {};

    if (keyIds.length > 0) {
      // Fetch counts per key — use minimal select, the new compound index handles this efficiently
      const sourceFeedUrls = keyIds.map((id) => `api-key:${id}`);
      const { data: stats } = await supabaseAdmin
        .from('events')
        .select('source_feed_url, status, created_at')
        .in('source_feed_url', sourceFeedUrls)
        .eq('source_method', 'self_asserted')
        .order('created_at', { ascending: false });

      if (stats) {
        for (const row of stats) {
          const keyId = row.source_feed_url?.replace('api-key:', '');
          if (!keyId) continue;
          if (!eventStats[keyId]) eventStats[keyId] = { event_count: 0, last_submitted_at: null, pending_count: 0 };
          eventStats[keyId].event_count++;
          if (row.status === 'pending_review') eventStats[keyId].pending_count++;
          if (!eventStats[keyId].last_submitted_at) {
            eventStats[keyId].last_submitted_at = row.created_at;
          }
        }
      }
    }

    const enrichedKeys = (keys || []).map((k) => ({
      ...k,
      event_count: eventStats[k.id]?.event_count ?? 0,
      pending_count: eventStats[k.id]?.pending_count ?? 0,
      last_submitted_at: eventStats[k.id]?.last_submitted_at ?? null,
    }));

    res.json({ api_keys: enrichedKeys });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /service/api-keys — Issue a new API key linked to a portal account.
 *
 * The new key is the credential; the linked account is the stable owner.
 * Rotation: call this with the same account_id as the existing key, then
 * revoke the old key (PATCH .../api-keys/:id with status='revoked') when
 * ready. Editorial control over the account's events follows the account,
 * not the key — both old and new keys can edit the same events while
 * both are active.
 *
 * Issuing a Contribute-tier key without account_id is forbidden: that
 * was the bug that made key rotation silently destroy ownership. Service
 * keys may be issued without account_id (admin keys span accounts).
 */
router.post('/api-keys', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    const schema = z.object({
      name: z.string().min(1).max(100),
      contact_email: z.string().email().max(200),
      contributor_tier: z.enum(['pending', 'verified', 'trusted', 'service']).default('verified'),
      account_id: z.string().uuid().optional(),
      url: z.string().url().max(500).optional(),
      rate_limit_per_hour: z.number().int().min(1).max(100000).default(1000),
      is_admin: z.boolean().default(false),
    });
    const data = validateRequest(schema, req.body);

    // Invariant: Contribute keys (any non-service tier) MUST be linked to an
    // account at issuance. Otherwise PATCH/DELETE return 403 KEY_NOT_LINKED
    // and we recreate the rotation bug we just fixed.
    const isServiceTier = data.contributor_tier === 'service';
    if (!isServiceTier && !data.account_id) {
      throw createError(
        'account_id is required for non-service API keys. Without a linked account, the key cannot edit or delete the events it creates.',
        400,
        'ACCOUNT_REQUIRED',
      );
    }

    // Verify the account exists if provided
    if (data.account_id) {
      const { data: account } = await supabaseAdmin
        .from('portal_accounts')
        .select('id, status')
        .eq('id', data.account_id)
        .maybeSingle();
      if (!account) throw createError('Account not found', 404, 'NOT_FOUND');
    }

    // Generate the raw key + hash. The raw key is returned ONCE in this
    // response and never recoverable — caller must store it immediately.
    const { randomBytes, createHash } = await import('crypto');
    const rawKey = 'nc_' + randomBytes(16).toString('hex');
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.substring(0, 12);

    const { data: newKey, error: insertError } = await supabaseAdmin
      .from('api_keys')
      .insert({
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name: data.name,
        contact_email: data.contact_email,
        contributor_tier: data.contributor_tier,
        url: data.url || null,
        rate_limit_per_hour: data.rate_limit_per_hour,
        status: 'active',
        is_admin: data.is_admin,
      })
      .select('id, key_prefix, name, contributor_tier, is_admin, created_at')
      .single();

    if (insertError || !newKey) throw createError('Failed to create API key', 500, 'SERVER_ERROR');

    // v2: api_key_account_links was dropped in migration 082. Authority
    // scope now lives in api_key_organization_links. Consumers should
    // call POST /service/organizations/link (or use the auto-link
    // path on POST /service/organizations) after key issuance to
    // establish writeable scope.

    console.log(`[SERVICE] API key ${newKey.id} created (${newKey.contributor_tier})${data.account_id ? ` (tenant account ref: ${data.account_id})` : ''}`);
    res.status(201).json({
      api_key: { ...newKey, account_id: data.account_id || null },
      key: rawKey,
      warning: 'Store this key immediately — it is not recoverable.',
    });
  } catch (err) { next(err); }
});

/** PATCH /service/api-keys/:id — Update API key tier, name, status, or contact email */
router.patch('/api-keys/:id', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    validateUuidParam(req.params.id, 'API key ID');
    const schema = z.object({
      name: z.string().min(1).max(100).optional(),
      url: z.string().url().max(500).optional().nullable(),
      status: z.enum(['active', 'revoked']).optional(),
      contributor_tier: z.enum(['pending', 'verified', 'trusted']).optional(),
      contact_email: z.string().email().max(200).optional(),
    });
    const updates = validateRequest(schema, req.body);

    if (Object.keys(updates).length === 0) throw createError('No fields to update', 400, 'VALIDATION_ERROR');

    const { data: apiKey, error } = await supabaseAdmin
      .from('api_keys')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, key_prefix, name, url, contact_email, rate_limit_per_hour, status, contributor_tier, last_used_at, created_at')
      .single();

    if (error) throw createError('Failed to update API key', 500, 'SERVER_ERROR');

    console.log(`[SERVICE] API key ${req.params.id} updated: ${Object.keys(updates).join(', ')}`);
    res.json({ api_key: apiKey });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /service/api-keys/:id/activate — Flip a self-registered service key
 * from pending to active. Optionally sets brand_config and verification_authority
 * in the same transaction; otherwise those stay at whatever was on the row
 * (typically NULL for self-registered keys).
 *
 * If `provision_account` is provided, ALSO creates the consumer app's tenant
 * portal_account (or finds an existing one) and links the now-active key to
 * it in the same call. This is the canonical path for tenant-umbrella
 * consumers — the UUID arrives in the activation response, the consumer
 * never makes a second round-trip. Per-operator portable consumers omit
 * `provision_account` and continue to call /service/accounts/link per
 * operator as those operators onboard.
 *
 * Pending keys remain strictly read-only — no portal_account is created
 * before activation. The atomicity here is the point: the account exists
 * exactly from the moment writes are authorized, never before.
 *
 * No-op (returns 200 with `already_active: true`) if the key is already
 * active — activation is idempotent. `provision_account` is ignored on
 * re-call; use POST /service/accounts/link to add accounts post-activation.
 */
router.post('/api-keys/:id/activate', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    validateUuidParam(req.params.id, 'API key ID');
    const schema = z.object({
      brand_config: z.record(z.unknown()).optional(),
      verification_authority: z.array(z.string()).optional(),
      rate_limit_per_hour: z.number().int().min(1).max(100000).optional(),
      provision_account: z.object({
        email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
        claimed_by: z.string().max(50).optional(),
      }).optional(),
    });
    const updates = validateRequest(schema, req.body ?? {});

    const { data: existing, error: readError } = await supabaseAdmin
      .from('api_keys')
      .select('id, contributor_tier, activated_at, application_metadata')
      .eq('id', req.params.id)
      .maybeSingle();

    if (readError || !existing) throw createError('API key not found', 404, 'NOT_FOUND');
    if (existing.contributor_tier !== 'service') {
      throw createError('Only service-tier keys are activated; this key is a different tier.', 400, 'VALIDATION_ERROR');
    }

    if (existing.activated_at !== null) {
      res.json({ api_key_id: existing.id, already_active: true, activated_at: existing.activated_at });
      return;
    }

    const patch: Record<string, unknown> = { activated_at: new Date().toISOString() };
    if (updates.brand_config !== undefined) patch.brand_config = updates.brand_config;
    if (updates.verification_authority !== undefined) patch.verification_authority = updates.verification_authority;
    if (updates.rate_limit_per_hour !== undefined) patch.rate_limit_per_hour = updates.rate_limit_per_hour;

    const { data: activated, error: updateError } = await supabaseAdmin
      .from('api_keys')
      .update(patch)
      .eq('id', req.params.id)
      .select('id, key_prefix, name, contact_email, contributor_tier, rate_limit_per_hour, brand_config, verification_authority, activated_at, application_metadata, created_at')
      .single();

    if (updateError) throw createError('Failed to activate API key', 500, 'SERVER_ERROR');

    console.log(`[SERVICE] API key ${req.params.id} activated for live writes`);

    // Optional: provision the consumer's tenant portal_account atomically.
    // Mirrors the /accounts/link find-or-create logic with the same
    // defense-in-depth — refuse to claim an account that's owned by Supabase
    // Auth (auth_user_id set) or claimed by a different consumer.
    //
    // v2: this no longer inserts api_key_account_links (table dropped in
    // migration 082). Writeable scope is established separately via
    // POST /service/organizations/link.
    if (updates.provision_account) {
      const p = updates.provision_account;
      try {
        let { data: account } = await supabaseAdmin
          .from('portal_accounts')
          .select('id, email, status, claimed_at, claimed_by, auth_user_id, created_at, updated_at')
          .ilike('email', p.email)
          .maybeSingle();

        let created = false;

        if (account) {
          if (account.auth_user_id) {
            throw createError(
              'Account exists and has an authenticated owner; cannot link via activation. Resolve manually.',
              409,
              'CONFLICT',
            );
          }
          if (account.claimed_at && account.claimed_by && p.claimed_by
            && account.claimed_by !== p.claimed_by) {
            throw createError(
              `Account is already claimed by "${account.claimed_by}"; refusing to link under "${p.claimed_by}".`,
              409,
              'CONFLICT',
            );
          }
        } else {
          const nowIso = new Date().toISOString();
          const { data: newAccount, error: insertError } = await supabaseAdmin
            .from('portal_accounts')
            .insert({
              email: p.email,
              status: 'active',
              claimed_at: nowIso,
              claimed_by: p.claimed_by ?? 'api',
            })
            .select('id, email, status, claimed_at, claimed_by, auth_user_id, created_at, updated_at')
            .single();
          if (insertError) {
            console.error('[SERVICE] Activate-with-provision insert error:', insertError.message);
            throw createError('Failed to provision tenant account during activation', 500, 'SERVER_ERROR');
          }
          account = newAccount;
          created = true;
        }

        console.log(`[SERVICE] Provisioned tenant account ${account!.id} (created=${created}) for activated key`);
        res.json({
          api_key: activated,
          already_active: false,
          account,
          account_created: created,
        });
        return;
      } catch (provisionErr) {
        // Activation already succeeded. Bubble the provision error so the
        // operator sees what went wrong; they can call /accounts/link to
        // recover without re-activating.
        throw provisionErr;
      }
    }

    res.json({ api_key: activated, already_active: false });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// IMAGE URL MIGRATION
// =============================================================================

/**
 * POST /service/migrate-image-urls — Rewrite all image URLs to direct R2 public URLs.
 * Converts portal proxy URLs and re-hosts external URLs (Google, gstatic, etc.)
 * One-time migration endpoint. Requires R2_PUBLIC_URL to be configured.
 */
router.post('/migrate-image-urls', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    if (!config.r2.publicUrl) {
      throw createError('R2_PUBLIC_URL not configured', 400, 'VALIDATION_ERROR');
    }

    const r2Base = config.r2.publicUrl;
    const results = { events: 0, errors: [] as string[] };

    // v2 (migration 082): logo_url and cover_image_url were dropped from
    // portal_accounts; profile images live on organizations now. Account
    // image migration is therefore a no-op in v2. If needed, run a
    // separate migration against the `organizations` table.

    // --- Migrate events ---
    const { data: events } = await supabaseAdmin
      .from('events')
      .select('id, event_image_url')
      .not('event_image_url', 'is', null);

    for (const event of events || []) {
      const url = event.event_image_url as string;
      if (!url || url.startsWith(r2Base)) continue;

      // Portal proxy URL — rewrite to direct R2 URL
      const eventMatch = url.match(/\/api\/portal\/events\/([^/]+)\/image$/);
      if (eventMatch) {
        const newUrl = `${r2Base}/portal-events/${eventMatch[1]}/image`;
        await supabaseAdmin.from('events').update({ event_image_url: newUrl }).eq('id', event.id);
        results.events++;
        continue;
      }

      // Raw R2 key stored directly
      if (url.startsWith('portal-events/')) {
        const newUrl = `${r2Base}/${url}`;
        await supabaseAdmin.from('events').update({ event_image_url: newUrl }).eq('id', event.id);
        results.events++;
      }
    }

    console.log(`[SERVICE] Image URL migration complete:`, JSON.stringify(results));
    res.json({ migration: results });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// APPROVED DOMAINS — operator-managed allowlist for Contribute API URLs
// =============================================================================
//
// Admin-only. Curator-submitted URLs whose domain isn't on this list are
// queued in domain_approval_requests and rejected with DOMAIN_PENDING_REVIEW.
// Operators review the queue and approve domains here.

const domainParam = z.string().min(1).max(253).regex(
  /^[a-z0-9.-]+$/i,
  'Domain must be a hostname (no scheme, path, or port).',
).transform((d) => d.toLowerCase());

const createApprovedDomainSchema = z.object({
  domain: domainParam,
  reason: z.string().max(500).optional(),
});

const reviewRequestSchema = z.object({
  reason: z.string().max(500).optional(),
});

router.get('/approved-domains', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    const { data, error } = await supabaseAdmin
      .from('approved_domains')
      .select('domain, added_by, reason, added_at')
      .order('added_at', { ascending: false });
    if (error) throw createError('Failed to load approved domains', 500, 'SERVER_ERROR');
    res.json({ approved_domains: data || [] });
  } catch (err) { next(err); }
});

router.post('/approved-domains', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    const { domain, reason } = validateRequest(createApprovedDomainSchema, req.body);
    const addedBy = `service:${req.apiKeyInfo.id}`;

    const { error } = await supabaseAdmin
      .from('approved_domains')
      .insert({ domain, reason: reason || null, added_by: addedBy });
    if (error && error.code !== '23505') {
      throw createError('Failed to add approved domain', 500, 'SERVER_ERROR');
    }

    // Mark any pending request for this domain as approved.
    await supabaseAdmin
      .from('domain_approval_requests')
      .update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: addedBy })
      .eq('domain', domain)
      .eq('status', 'pending');

    invalidateApprovedDomainsCache();
    console.log(`[SERVICE] Approved domain added: ${domain} by ${addedBy}`);
    res.status(201).json({ approved_domain: { domain, reason: reason || null, added_by: addedBy } });
  } catch (err) { next(err); }
});

router.delete('/approved-domains/:domain', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    const domain = domainParam.parse(req.params.domain);

    const { error } = await supabaseAdmin
      .from('approved_domains')
      .delete()
      .eq('domain', domain);
    if (error) throw createError('Failed to remove approved domain', 500, 'SERVER_ERROR');

    invalidateApprovedDomainsCache();
    console.log(`[SERVICE] Approved domain removed: ${domain} by service:${req.apiKeyInfo.id}`);
    res.status(204).end();
  } catch (err) { next(err); }
});

router.get('/domain-approval-requests', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    const status = (typeof req.query.status === 'string' && ['pending', 'approved', 'rejected'].includes(req.query.status))
      ? req.query.status as string
      : 'pending';

    const { data, error } = await supabaseAdmin
      .from('domain_approval_requests')
      .select('id, domain, requested_via_api_key, requested_url, event_context, status, requested_at, reviewed_at, reviewed_by')
      .eq('status', status)
      .order('requested_at', { ascending: false })
      .limit(200);
    if (error) throw createError('Failed to load approval requests', 500, 'SERVER_ERROR');
    res.json({ requests: data || [] });
  } catch (err) { next(err); }
});

router.post('/domain-approval-requests/:id/approve', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    validateUuidParam(req.params.id, 'request ID');
    const { reason } = validateRequest(reviewRequestSchema, req.body || {});
    const reviewedBy = `service:${req.apiKeyInfo.id}`;

    const { data: request, error: fetchError } = await supabaseAdmin
      .from('domain_approval_requests')
      .select('id, domain, status')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError || !request) throw createError('Request not found', 404, 'NOT_FOUND');
    if (request.status !== 'pending') throw createError(`Request already ${request.status}`, 409, 'CONFLICT');

    const domain = request.domain as string;
    const { error: insertError } = await supabaseAdmin
      .from('approved_domains')
      .insert({ domain, reason: reason || null, added_by: reviewedBy });
    if (insertError && insertError.code !== '23505') {
      throw createError('Failed to add approved domain', 500, 'SERVER_ERROR');
    }

    await supabaseAdmin
      .from('domain_approval_requests')
      .update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: reviewedBy })
      .eq('id', req.params.id);

    invalidateApprovedDomainsCache();
    console.log(`[SERVICE] Approval request approved: ${domain} (${req.params.id}) by ${reviewedBy}`);
    res.json({ request: { id: req.params.id, domain, status: 'approved' } });
  } catch (err) { next(err); }
});

router.post('/domain-approval-requests/:id/reject', serviceLimiter, async (req, res, next) => {
  try {
    if (!req.apiKeyInfo?.isAdmin) {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }
    validateUuidParam(req.params.id, 'request ID');
    const reviewedBy = `service:${req.apiKeyInfo.id}`;

    const { data: request, error: fetchError } = await supabaseAdmin
      .from('domain_approval_requests')
      .select('id, domain, status')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError || !request) throw createError('Request not found', 404, 'NOT_FOUND');
    if (request.status !== 'pending') throw createError(`Request already ${request.status}`, 409, 'CONFLICT');

    const { error: updateError } = await supabaseAdmin
      .from('domain_approval_requests')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString(), reviewed_by: reviewedBy })
      .eq('id', req.params.id);
    if (updateError) throw createError('Failed to reject request', 500, 'SERVER_ERROR');

    console.log(`[SERVICE] Approval request rejected: ${request.domain} (${req.params.id}) by ${reviewedBy}`);
    res.json({ request: { id: req.params.id, domain: request.domain, status: 'rejected' } });
  } catch (err) { next(err); }
});

export default router;
