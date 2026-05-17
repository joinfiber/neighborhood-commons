/**
 * Operator notifications — Neighborhood Commons
 *
 * Best-effort email dispatch for events the operator should act on:
 * content takedown reports (/api/v1/report) and verification disputes
 * (/api/v1/service/disputes). Both also write an audit_log entry; this
 * helper exists so the operator gets a notification, not just a row.
 *
 * If COMMONS_OPERATOR_EMAIL is not configured, calls log a warning and
 * return — never throw. The audit_log entry is the load-bearing record.
 */

import { config } from '../config.js';
import { sendEmail } from './email.js';

export interface OperatorAlert {
  kind: 'report' | 'dispute';
  targetType: string;
  targetId: string;
  reason: string;
  submitterContact?: string | null;
  submittedByApp?: string | null;
  auditLogId?: string;
}

/**
 * Dispatch an operator email for a content report or verification dispute.
 *
 * Fire-and-forget — caller does NOT await. Email failures are logged but
 * never bubble; the audit_log row is the source of truth and the operator
 * can sweep audit_logs even if email delivery is down.
 */
export function notifyOperator(alert: OperatorAlert): void {
  const operatorEmail = config.operator.email;
  if (!operatorEmail) {
    console.warn(`[OPERATOR] ${alert.kind} on ${alert.targetType}/${alert.targetId} — no COMMONS_OPERATOR_EMAIL configured, skipping notification`);
    return;
  }

  const subjectKind = alert.kind === 'report' ? 'Content report' : 'Verification dispute';
  const subject = `[Commons] ${subjectKind}: ${alert.targetType} ${alert.targetId.slice(0, 8)}`;

  const html = `
    <p><strong>${subjectKind} filed against ${escapeHtml(alert.targetType)} ${escapeHtml(alert.targetId)}</strong></p>
    <p><strong>Reason:</strong></p>
    <blockquote style="border-left: 3px solid #ccc; padding-left: 12px; margin-left: 0; color: #444;">
      ${escapeHtml(alert.reason)}
    </blockquote>
    ${alert.submitterContact ? `<p><strong>Submitter contact:</strong> ${escapeHtml(alert.submitterContact)}</p>` : '<p><em>No submitter contact provided.</em></p>'}
    ${alert.submittedByApp ? `<p><strong>Submitted via:</strong> ${escapeHtml(alert.submittedByApp)}</p>` : ''}
    ${alert.auditLogId ? `<p><strong>Audit log id:</strong> <code>${escapeHtml(alert.auditLogId)}</code></p>` : ''}
    <hr/>
    <p style="color: #888; font-size: 12px;">Review the target row and act per the takedown policy. Audit log entry has been recorded regardless of this email's delivery status.</p>
  `;

  void sendEmail(operatorEmail, subject, html).catch((err) => {
    console.error(`[OPERATOR] Email dispatch failed for ${alert.kind} ${alert.targetType}/${alert.targetId}:`, err instanceof Error ? err.message : err);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
