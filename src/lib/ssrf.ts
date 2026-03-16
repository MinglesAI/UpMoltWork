/**
 * SSRF prevention utilities.
 *
 * Standalone module with no DB/service dependencies so it can be safely
 * imported in tests without triggering DATABASE_URL / pool initialization.
 */

import dns from 'node:dns/promises';

/**
 * RFC-1918 / loopback / link-local / unspecified IPv4 ranges to block.
 */
const BLOCKED_IPV4_RANGES = [
  // Loopback
  { start: inetAton('127.0.0.0'), end: inetAton('127.255.255.255') },
  // RFC-1918 private
  { start: inetAton('10.0.0.0'),  end: inetAton('10.255.255.255') },
  { start: inetAton('172.16.0.0'), end: inetAton('172.31.255.255') },
  { start: inetAton('192.168.0.0'), end: inetAton('192.168.255.255') },
  // Link-local
  { start: inetAton('169.254.0.0'), end: inetAton('169.254.255.255') },
  // Unspecified
  { start: inetAton('0.0.0.0'), end: inetAton('0.255.255.255') },
];

function inetAton(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

export function isBlockedIPv4(ip: string): boolean {
  try {
    const n = inetAton(ip);
    return BLOCKED_IPV4_RANGES.some(({ start, end }) => n >= start && n <= end);
  } catch {
    return true; // unparseable → block
  }
}

export function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Loopback
  if (lower === '::1') return true;
  // Link-local fe80::/10 (fe80 – febf)
  if (/^fe[89ab]/i.test(lower)) return true;
  // ULA fc00::/7 (fc and fd prefixes)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  return false;
}

/**
 * Validate a webhook/callback URL for SSRF safety.
 * - Must use https:// scheme
 * - Hostname must not resolve to RFC-1918/loopback/link-local IPs
 * Throws an Error with a user-facing message if the URL is invalid.
 */
export async function validateWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use https:// scheme');
  }

  const hostname = parsed.hostname;

  // Resolve hostname to IPs and check each
  let addresses: string[];
  try {
    const results = await dns.lookup(hostname, { all: true, family: 0 });
    addresses = results.map((r) => r.address);
  } catch {
    // DNS resolution failure — reject to be safe
    throw new Error(`Webhook URL hostname could not be resolved: ${hostname}`);
  }

  for (const addr of addresses) {
    if (addr.includes(':')) {
      // IPv6
      if (isBlockedIPv6(addr)) {
        throw new Error(`Webhook URL resolves to a blocked IP address: ${addr}`);
      }
    } else {
      if (isBlockedIPv4(addr)) {
        throw new Error(`Webhook URL resolves to a blocked IP address: ${addr}`);
      }
    }
  }
}
