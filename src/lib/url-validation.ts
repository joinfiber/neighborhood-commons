/**
 * URL Validation -- SSRF Protection
 *
 * Validates webhook URLs before making outbound requests.
 * Resolves hostnames to IP addresses and blocks private/internal ranges.
 *
 * SECURITY: Prevents server-side request forgery (SSRF) attacks where
 * an attacker registers a webhook pointing at internal network resources
 * (cloud metadata, local services, RFC 1918 addresses).
 */

import { promises as dns } from 'dns';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  '[::]',
  '[::1]',
]);

/**
 * Check if an IPv4 address is in a private/reserved range.
 * Exported so safe-fetch can re-validate at connect time (defeats DNS rebinding).
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;

  const a = parts[0]!;
  const b = parts[1]!;

  // Loopback: 127.0.0.0/8
  if (a === 127) return true;
  // RFC 1918: 10.0.0.0/8
  if (a === 10) return true;
  // RFC 1918: 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // RFC 1918: 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // Link-local: 169.254.0.0/16 (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // Current network: 0.0.0.0/8
  if (a === 0) return true;
  // RFC 6598: 100.64.0.0/10 — shared address space / CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // IETF protocol assignments: 192.0.0.0/24
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  // Benchmark testing: 198.18.0.0/15
  if (a === 198 && (b === 18 || b === 19)) return true;
  // Reserved for future use: 240.0.0.0/4
  if (a >= 240) return true;

  return false;
}

/**
 * Decode the trailing 32 bits of an IPv4-in-IPv6 address (the `::ffff:` mapped
 * range or the `64:ff9b::` NAT64 well-known prefix) into a dotted-quad string,
 * or null if the tail isn't a well-formed embedded IPv4.
 *
 * dns.lookup can return either the dotted form (`...:169.254.169.254`) or the
 * compressed hex-pair form (`...:a9fe:a9fe`) for the same address, so both are
 * accepted. Anything we can't decode returns null so callers can fail closed.
 */
function embeddedIPv4(tail: string): string | null {
  let octets: number[];
  if (tail.includes('.')) {
    // Dotted form -- already an IPv4 literal.
    octets = tail.split('.').map(Number);
  } else {
    // Compressed-hex form -- two 16-bit groups hold the high and low halves.
    const groups = tail.split(':');
    if (groups.length !== 2) return null;
    const hi = parseInt(groups[0]!, 16);
    const lo = parseInt(groups[1]!, 16);
    if (Number.isNaN(hi) || Number.isNaN(lo) || hi < 0 || hi > 0xffff || lo < 0 || lo > 0xffff) {
      return null;
    }
    octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    return null;
  }
  return octets.join('.');
}

/**
 * Check if an IPv6 address is private/reserved.
 * Exported so safe-fetch can re-validate at connect time (defeats DNS rebinding).
 */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // Loopback ::1
  if (normalized === '::1') return true;
  // Unspecified ::
  if (normalized === '::') return true;
  // Unique local fc00::/7
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // Discard-only 100::/64 (RFC 6666). Canonical form compresses to "100::".
  if (normalized.startsWith('100::')) return true;

  // Link-local fe80::/10 -- the first hextet spans fe80..febf, NOT just fe80.
  // The old startsWith('fe80:') missed fe90/fea0/feb0..febf, all inside the /10
  // and all routing to link-local (incl. cloud metadata at fe80::a9fe:a9fe).
  const firstHextet = parseInt(normalized.split(':')[0]!, 16);
  if (!Number.isNaN(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) {
    return true;
  }

  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052) embeds an IPv4 in its low
  // 32 bits and routes through a NAT64 gateway. Classify by that embedded IPv4
  // so 64:ff9b::a9fe:a9fe (-> 169.254.169.254) is blocked while a public
  // mapping stays reachable for IPv6-only/DNS64 hosts. Fail closed if unparsable.
  if (normalized.startsWith('64:ff9b::')) {
    const ipv4 = embeddedIPv4(normalized.slice('64:ff9b::'.length));
    return ipv4 === null ? true : isPrivateIPv4(ipv4);
  }

  // IPv4-mapped ::ffff:0:0/96 -- classify by the embedded IPv4. dns.lookup may
  // return the dotted form (::ffff:169.254.169.254) OR the compressed hex form
  // (::ffff:a9fe:a9fe); both encode the same 32-bit IPv4. Checking only the
  // dotted form was an SSRF bypass (the hex form sailed through as "public").
  // Fail closed on any ::ffff: address we can't decode into a valid IPv4.
  if (normalized.startsWith('::ffff:')) {
    const ipv4 = embeddedIPv4(normalized.slice('::ffff:'.length));
    return ipv4 === null ? true : isPrivateIPv4(ipv4);
  }

  return false;
}

/**
 * Resolve a hostname and reject if ANY resolved address is private/reserved.
 * Uses { all: true } so a dual-stack host can't pass on a public record while
 * a later connect lands on a private one. Mirrors safe-fetch's connect-time
 * ssrfSafeLookup; together they bracket the validate->connect TOCTOU window.
 */
async function assertResolvesToPublicIp(hostname: string): Promise<void> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (err) {
    if (err instanceof Error && (err.message.includes('ENOTFOUND') || err.message.includes('EAI_AGAIN'))) {
      throw new Error('URL hostname could not be resolved');
    }
    throw err;
  }
  for (const { address, family } of addresses) {
    if (family === 4 && isPrivateIPv4(address)) {
      throw new Error('URL resolves to a private IP address');
    }
    if (family === 6 && isPrivateIPv6(address)) {
      throw new Error('URL resolves to a private IP address');
    }
  }
}

/**
 * Validate a webhook URL is safe to fetch.
 * Resolves the hostname and blocks private/internal IPs.
 *
 * @throws Error if the URL is unsafe
 */
/**
 * Validate a feed URL is safe to fetch.
 * Same SSRF protection as webhooks, but allows HTTP (many iCal feeds are HTTP-only).
 *
 * @throws Error if the URL is unsafe
 */
export async function validateFeedUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }

  // Allow HTTP and HTTPS for feeds — block everything else
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('URL must use HTTP or HTTPS');
  }

  // Block known private hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error('URL hostname is not allowed');
  }

  await assertResolvesToPublicIp(hostname);
}

export async function validateWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }

  // Only allow HTTPS -- block HTTP even if Zod schema missed it (defense in depth)
  if (parsed.protocol !== 'https:') {
    throw new Error('URL must use HTTPS');
  }

  // Block known private hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error('URL hostname is not allowed');
  }

  await assertResolvesToPublicIp(hostname);
}
