/**
 * SSRF Guard
 *
 * Validates outbound URLs to prevent Server-Side Request Forgery.
 * Blocks requests to private IP ranges, loopback, link-local, and non-http(s) protocols.
 *
 * Usage:
 *   await validateOutboundUrl(url);  // throws SsrfBlockedError if blocked
 */

import { promises as dns } from 'node:dns';

export class SsrfBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(`SSRF blocked: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * IPv4 CIDR ranges that are private/reserved and must not be reached.
 */
const BLOCKED_IPV4_CIDRS: Array<{ network: number; mask: number; label: string }> = [
  { network: 0x7f000000, mask: 0xff000000, label: 'loopback (127.0.0.0/8)' },
  { network: 0x0a000000, mask: 0xff000000, label: 'private (10.0.0.0/8)' },
  { network: 0xac100000, mask: 0xfff00000, label: 'private (172.16.0.0/12)' },
  { network: 0xc0a80000, mask: 0xffff0000, label: 'private (192.168.0.0/16)' },
  { network: 0xa9fe0000, mask: 0xffff0000, label: 'link-local (169.254.0.0/16)' },
  { network: 0xe0000000, mask: 0xf0000000, label: 'multicast (224.0.0.0/4)' },
  { network: 0x00000000, mask: 0xff000000, label: 'this-network (0.0.0.0/8)' },
  { network: 0xc0000000, mask: 0xffffff00, label: 'IETF (192.0.0.0/24)' },
  { network: 0xc0000200, mask: 0xffffff00, label: 'documentation (192.0.2.0/24)' },
  { network: 0xc6336400, mask: 0xffffff00, label: 'documentation (198.51.100.0/24)' },
  { network: 0xcb007100, mask: 0xffffff00, label: 'documentation (203.0.113.0/24)' },
  { network: 0xffffffff, mask: 0xffffffff, label: 'broadcast (255.255.255.255/32)' },
];

/**
 * Check if an IPv4 address string is in a blocked range.
 */
function isBlockedIpv4(ip: string): string | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return null; // Not a valid IPv4; skip
  }
  const addr = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  for (const cidr of BLOCKED_IPV4_CIDRS) {
    if ((addr & cidr.mask) >>> 0 === cidr.network) {
      return cidr.label;
    }
  }
  return null;
}

/**
 * Check if an IPv6 address string is blocked.
 * Covers ::1 (loopback) and fc00::/7 (unique local).
 */
function isBlockedIpv6(ip: string): string | null {
  // Strip zone ID if present (e.g. "::1%lo")
  const addr = ip.split('%')[0].toLowerCase();

  if (addr === '::1') return 'loopback (::1)';

  // fc00::/7 covers fc00:: through fdff::
  // First two hex chars of first group: fc or fd
  const firstGroup = addr.split(':')[0];
  if (firstGroup.length >= 2) {
    const byte = parseInt(firstGroup.slice(0, 2), 16);
    if (!isNaN(byte) && (byte & 0xfe) === 0xfc) {
      return 'unique local (fc00::/7)';
    }
  }

  // ::ffff:0:0/96 — IPv4-mapped (check inner IPv4 portion)
  const v4MappedMatch = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedMatch) {
    return isBlockedIpv4(v4MappedMatch[1]);
  }

  return null;
}

/**
 * Validate an outbound URL for SSRF safety.
 *
 * Resolves hostname to IPs via DNS and checks each against blocked ranges.
 * Throws SsrfBlockedError if the URL should not be fetched.
 */
export async function validateOutboundUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(`unparseable URL: ${url}`);
  }

  // Protocol check
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SsrfBlockedError(`non-http(s) protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;

  // Direct IP address check (no DNS needed)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    const reason = isBlockedIpv4(hostname);
    if (reason) throw new SsrfBlockedError(`blocked IP ${hostname}: ${reason}`);
    return;
  }

  // IPv6 literal (possibly wrapped in brackets by URL parser)
  const ipv6 = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (ipv6.includes(':')) {
    const reason = isBlockedIpv6(ipv6);
    if (reason) throw new SsrfBlockedError(`blocked IPv6 ${ipv6}: ${reason}`);
    return;
  }

  // localhost shorthand
  if (hostname === 'localhost') {
    throw new SsrfBlockedError('blocked hostname: localhost');
  }

  // DNS resolution — resolve to IPs and check each one
  let addresses: string[] = [];
  try {
    const [v4Results, v6Results] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);
    if (v4Results.status === 'fulfilled') addresses.push(...v4Results.value);
    if (v6Results.status === 'fulfilled') addresses.push(...v6Results.value);
  } catch {
    // If DNS resolution completely fails, block as unresolvable to prevent
    // attackers from exploiting DNS-based SSRF via NXDOMAIN bypass
    throw new SsrfBlockedError(`hostname "${hostname}" could not be resolved`);
  }

  if (addresses.length === 0) {
    throw new SsrfBlockedError(`hostname "${hostname}" resolved to no addresses`);
  }

  for (const addr of addresses) {
    const v4Reason = isBlockedIpv4(addr);
    if (v4Reason) throw new SsrfBlockedError(`hostname "${hostname}" resolved to blocked IP ${addr}: ${v4Reason}`);
    const v6Reason = isBlockedIpv6(addr);
    if (v6Reason) throw new SsrfBlockedError(`hostname "${hostname}" resolved to blocked IPv6 ${addr}: ${v6Reason}`);
  }
}
