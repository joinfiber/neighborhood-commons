/**
 * Security Audit Logging — Neighborhood Commons
 *
 * Privacy-preserving audit trail for portal actions.
 * All user IDs are one-way hashed to prevent PII exposure in logs
 * while still allowing correlation of events by the same actor.
 *
 * Logs are written to:
 * 1. Console (stdout) - for real-time monitoring
 * 2. Supabase audit_logs table - for persistent, queryable storage
 */

import crypto from 'crypto';
import { config } from '../config.js';
import { supabaseAdmin } from './supabase.js';

// Salt for hashing - validated as required by config schema
const AUDIT_SALT = config.security.auditSalt;

/**
 * Portal audit action types.
 */
type PortalAuditAction =
  | 'portal_event_created'
  | 'portal_event_updated'
  | 'portal_event_deleted'
  | 'portal_account_suspended'
  | 'portal_account_reactivated'
  | 'portal_account_approved'
  | 'portal_account_rejected'
  | 'portal_creation_rate_limited'
  | 'portal_import'
  | 'admin_impersonation'
  | 'newsletter_candidate_approved'
  | 'newsletter_candidate_rejected'
  | 'newsletter_candidate_duplicate';

/**
 * One-way hash for privacy-preserving logs.
 * Same ID always produces same hash (for correlation),
 * but hash cannot be reversed to original ID.
 *
 * Exported for use in other modules that need consistent hashing.
 */
export function hashId(id: string): string {
  return crypto
    .createHash('sha256')
    .update(id + AUDIT_SALT)
    .digest('hex')
    .substring(0, 16); // 16 chars is enough for correlation
}

/**
 * Log a portal audit event.
 *
 * Actor is the portal account ID or admin user ID performing the action.
 * ResourceId is the event ID or account ID being acted upon.
 *
 * All IDs are hashed before logging to preserve privacy.
 * Output is JSON for easy parsing by log aggregation tools.
 */
export function auditPortalAction(
  action: PortalAuditAction,
  actor: string,
  resourceId: string,
  metadata?: Record<string, string | number | boolean>,
  endpoint?: string,
): void {
  const actorHash = hashId(actor);
  const resourceHash = hashId(resourceId);

  const logEntry = {
    type: 'AUDIT',
    action,
    actor: actorHash,
    resourceId: resourceHash,
    result: 'success',
    endpoint: endpoint || null,
    metadata: metadata || null,
    timestamp: new Date().toISOString(),
  };

  // Remove null fields for cleaner logs
  const cleanEntry = Object.fromEntries(
    Object.entries(logEntry).filter(([, v]) => v !== undefined && v !== null)
  );

  // 1. Write to console (real-time monitoring)
  console.log(JSON.stringify(cleanEntry));

  // 2. Write to database (persistent storage)
  // Fire-and-forget to not slow down API responses
  const dbEntry = {
    action,
    result: 'success',
    actor_hash: actorHash,
    resource_hash: resourceHash,
    reason: null,
    endpoint: endpoint || null,
    ip_hash: null,
    user_agent: null,
    metadata: metadata || {},
  };

  void supabaseAdmin
    .from('audit_logs')
    .insert(dbEntry)
    .then(({ error }) => {
      if (error) {
        // Log to console only - don't fail the request
        console.error('[AUDIT] DB write failed:', error.message);
      }
    });
}
