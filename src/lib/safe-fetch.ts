/**
 * safeFetch — outbound HTTP for user-supplied URLs
 *
 * This is the single chokepoint for fetches where the hostname is influenced
 * by external input: webhook delivery, image fetch-by-URL, iCal feed import,
 * image verification cron. It enforces two properties:
 *
 *   1. `redirect: 'error'` by default. A validated public URL can 302 to a
 *      private IP; following redirects defeats the SSRF gate. Callers may
 *      override explicitly, but shouldn't.
 *
 *   2. When SSRF_STRICT=1, outgoing connections route through an undici Agent
 *      whose DNS lookup re-resolves the hostname at connect time and refuses
 *      any resolution landing on a private/reserved IP. This closes the
 *      DNS-rebinding TOCTOU gap between the upfront validateFeedUrl/
 *      validateWebhookUrl check and the actual TCP connect: an attacker-
 *      controlled DNS server returning TTL=0 answers can swap a public IP
 *      for 169.254.169.254 between those two resolutions.
 *
 * Callers MUST still call validateFeedUrl/validateWebhookUrl first —
 * safeFetch is defense-in-depth, not a replacement for protocol/hostname
 * checks. Hardcoded-hostname fetches (Resend, Google Places, Nominatim,
 * R2, Turnstile) continue to use global fetch directly; they carry no
 * user-supplied hostname and adding the dispatcher there costs latency
 * without benefit.
 */

import { Agent, type Dispatcher } from 'undici';
import { lookup as dnsLookup } from 'dns';
import { config } from '../config.js';
import { isPrivateIPv4, isPrivateIPv6 } from './url-validation.js';

/**
 * Custom DNS lookup used by the SSRF-strict dispatcher. Resolves the hostname
 * normally, then rejects the connection if the resolved IP is private.
 * This runs for every TCP connect undici makes through the Agent.
 *
 * Signature matches undici's `LookupFunction`. We force `all: false` when
 * delegating to `dns.lookup` so the callback always receives a single address.
 */
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string,
  family: number,
) => void;

function ssrfSafeLookup(
  hostname: string,
  options: { family?: number; hints?: number },
  callback: LookupCallback,
): void {
  // `all: false` guarantees dnsLookup's callback receives (err, string, number)
  dnsLookup(hostname, { family: options.family, hints: options.hints, all: false }, (err, address, family) => {
    if (err) return callback(err, '', 0);
    if (family === 4 && isPrivateIPv4(address)) {
      const e = new Error(
        `SSRF blocked: ${hostname} resolved to private IPv4 ${address}`,
      ) as NodeJS.ErrnoException;
      e.code = 'SSRF_BLOCKED';
      return callback(e, '', 0);
    }
    if (family === 6 && isPrivateIPv6(address)) {
      const e = new Error(
        `SSRF blocked: ${hostname} resolved to private IPv6 ${address}`,
      ) as NodeJS.ErrnoException;
      e.code = 'SSRF_BLOCKED';
      return callback(e, '', 0);
    }
    callback(null, address, family);
  });
}

let strictAgent: Agent | null = null;

/** Lazy — build the Agent on first use so tests that don't touch network don't construct one. */
function getStrictAgent(): Agent {
  if (!strictAgent) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    strictAgent = new Agent({ connect: { lookup: ssrfSafeLookup as any } });
  }
  return strictAgent;
}

/**
 * Fetch for user-supplied URLs. Always sets `redirect: 'error'` unless the
 * caller explicitly overrides. Routes through the SSRF-strict dispatcher
 * when config.security.ssrfStrict is true.
 */
export async function safeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const opts: RequestInit & { dispatcher?: Dispatcher } = {
    redirect: 'error',
    ...init,
  };
  if (config.security.ssrfStrict) {
    opts.dispatcher = getStrictAgent();
  }
  // `dispatcher` is an undici extension; Node's fetch passes it through.
  return fetch(input, opts as RequestInit);
}

/** Test-only: reset the cached Agent so flag flips take effect. */
export function _resetStrictAgentForTests(): void {
  strictAgent = null;
}

/** Test-only: direct access to the connect-hook lookup for unit tests. */
export const _ssrfSafeLookupForTests = ssrfSafeLookup;
