/**
 * Verification library — Neighborhood Commons 1.0.0
 *
 * Shared logic for the verification flow:
 *   - Personal-email domain detection (routing signal, not rejection)
 *   - Code generation + hashing
 *   - Routing decisions (which submission endpoint applies for an identifier)
 *   - Authority checks (does the calling key auto-approve manual reviews?)
 *
 * The Commons routes; apps follow.
 */

import { createHash, randomBytes } from 'crypto';
import type { Request } from 'express';
import { supabaseAdmin } from './supabase.js';

/**
 * Personal-email providers. Identifiers at these domains are routed to
 * manual review when the target is a heavy-rigor Organization (local_business,
 * business, nonprofit). For light-rigor targets (community_group, curator,
 * collective, person), personal emails are accepted via the auto-track
 * email loop — we just need to prove control.
 */
export const PERSONAL_EMAIL_DOMAINS = new Set<string>([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'passport.com',
  'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me',
  'aol.com', 'aim.com',
  'fastmail.com', 'fastmail.fm',
  'tutanota.com', 'tuta.io',
  'hey.com',
  'duck.com', 'duckduckgo.com',
  'gmx.com', 'gmx.us',
  'zoho.com',
]);

/** Extract the domain portion (post-@) from an email, lowercased. */
export function extractDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return '';
  return email.slice(at + 1).toLowerCase();
}

export function isPersonalEmailDomain(email: string): boolean {
  return PERSONAL_EMAIL_DOMAINS.has(extractDomain(email));
}

/** Heavy-rigor organization kinds — manual review required for personal-email identifiers. */
export const HEAVY_RIGOR_ORG_KINDS = new Set<string>([
  'local_business', 'business', 'nonprofit',
]);

/**
 * Decide which verification path applies for a target+identifier pair.
 * Returns the prescribed method and the endpoint apps should call next.
 */
export type VerificationPathDecision = {
  requiredMethod: 'domain_email_loop' | 'manual_review';
  endpoint: string;
  reason: string;
};

export async function decideVerificationPath(
  targetType: 'organization' | 'person',
  targetId: string,
  _identifierType: 'email',
  identifierValue: string,
): Promise<VerificationPathDecision | null> {
  const domain = extractDomain(identifierValue);
  if (!domain) return null;

  // Person targets: always light-rigor (any email loop)
  if (targetType === 'person') {
    return {
      requiredMethod: 'domain_email_loop',
      endpoint: '/v1/service/verifications/challenges',
      reason: 'person_target',
    };
  }

  // Organization: rigor depends on kind
  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('kind')
    .eq('id', targetId)
    .maybeSingle();

  if (!org) return null;

  const kind = org.kind as string;
  const isHeavyRigor = HEAVY_RIGOR_ORG_KINDS.has(kind);
  const isPersonalDomain = PERSONAL_EMAIL_DOMAINS.has(domain);

  if (isHeavyRigor && isPersonalDomain) {
    return {
      requiredMethod: 'manual_review',
      endpoint: '/v1/service/verifications/manual',
      reason: 'personal_email_domain',
    };
  }

  return {
    requiredMethod: 'domain_email_loop',
    endpoint: '/v1/service/verifications/challenges',
    reason: isHeavyRigor ? 'business_email_domain' : 'light_rigor_target',
  };
}

/**
 * Look up an existing active verified identifier matching the (target, identifier)
 * pair. Returns null if not yet verified.
 */
export async function findExistingVerifiedIdentifier(
  targetType: 'organization' | 'person',
  targetId: string,
  identifierType: 'email',
  identifierValue: string,
) {
  const { data } = await supabaseAdmin
    .from('account_verified_identifiers')
    .select('identifier_type, identifier_value, identifier_domain, method, verified_at, approved_by_app, status')
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .eq('identifier_type', identifierType)
    .eq('identifier_value', identifierValue.toLowerCase())
    .eq('status', 'active')
    .maybeSingle();

  return data;
}

/**
 * Generate a verification code (6-digit numeric) and its SHA-256 hash.
 * The raw code is sent to the user; only the hash is persisted.
 */
export function generateVerificationCode(): { code: string; hash: string } {
  // 6-digit code, zero-padded. Numeric is easier to type from a phone.
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  const code = String(n).padStart(6, '0');
  const hash = createHash('sha256').update(code).digest('hex');
  return { code, hash };
}

export function hashVerificationCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Does the calling service key have authority to auto-approve a manual review
 * with the given method:context? Used for the "vouching authority" path
 * (e.g., Holler's manual_review:in_person).
 */
export function hasVerificationAuthority(
  req: Request,
  method: string,
  context: string,
): boolean {
  const auth = req.apiKeyInfo?.verificationAuthority;
  if (!auth || !Array.isArray(auth)) return false;
  if (auth.includes('*')) return true;  // operator/admin wildcard
  const target = `${method}:${context}`;
  return auth.includes(target);
}
