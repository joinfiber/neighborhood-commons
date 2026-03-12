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
 */
function isPrivateIPv4(ip: string): boolean {
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
 * Check if an IPv6 address is private/reserved.
 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // Loopback ::1
  if (normalized === '::1') return true;
  // Unspecified ::
  if (normalized === '::') return true;
  // Link-local fe80::/10
  if (normalized.startsWith('fe80:')) return true;
  // Unique local fc00::/7
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // IPv4-mapped ::ffff:x.x.x.x -- extract and check IPv4 portion
  if (normalized.startsWith('::ffff:')) {
    const ipv4Part = normalized.slice(7);
    if (ipv4Part.includes('.')) {
      return isPrivateIPv4(ipv4Part);
    }
  }

  return false;
}

/**
 * Validate a webhook URL is safe to fetch.
 * Resolves the hostname and blocks private/internal IPs.
 *
 * @throws Error if the URL is unsafe
 */
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

  // Resolve hostname to IP address
  try {
    const { address, family } = await dns.lookup(hostname);

    if (family === 4 && isPrivateIPv4(address)) {
      throw new Error('URL resolves to a private IP address');
    }

    if (family === 6 && isPrivateIPv6(address)) {
      throw new Error('URL resolves to a private IP address');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('private IP')) {
      throw err;
    }
    // DNS resolution failure -- block (fail closed)
    if (err instanceof Error && (err.message.includes('ENOTFOUND') || err.message.includes('EAI_AGAIN'))) {
      throw new Error('URL hostname could not be resolved');
    }
    throw err;
  }
}
