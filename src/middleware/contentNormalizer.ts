/**
 * Content Normalizer — Input normalization utilities for externally-supplied agent content.
 *
 * Provides sanitization helpers to strip null bytes / control characters before storing
 * content from external agents (tasks, bids, submissions, messages, gig deliveries).
 *
 * Phase 2 of the Content Filtering & Trust Tier Architecture.
 */

const PRIVATE_IP_RANGES = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^127\./,
  /^::1$/,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
];

/**
 * Normalize externally-supplied text by stripping null bytes and non-printable
 * control characters (keeps \n, \r, \t). Safe to call on already-normalized content.
 */
export function normalizeText(input: string): string {
  if (typeof input !== 'string') return input;
  return input
    // Remove null bytes
    .replace(/\x00/g, '')
    // Remove control chars except \n (0x0A), \r (0x0D), \t (0x09)
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

/**
 * Validate an externally-supplied URL.
 * Rejects dangerous schemes (file://, javascript:, data:).
 * Warns (logs) on private IP ranges but does not block.
 *
 * Returns { ok: true } or { ok: false, reason: string }.
 */
export function validateExternalUrl(url: string): { ok: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `Invalid URL: ${url}` };
  }

  const scheme = parsed.protocol.toLowerCase();

  if (['file:', 'javascript:', 'data:'].includes(scheme)) {
    return { ok: false, reason: `Dangerous URL scheme: ${scheme}` };
  }

  // Warn on private IP ranges (SSRF risk), but don't block at this layer
  const host = parsed.hostname;
  for (const pattern of PRIVATE_IP_RANGES) {
    if (pattern.test(host)) {
      console.warn(JSON.stringify({
        event: 'external_url_private_ip',
        url,
        host,
      }));
      break;
    }
  }

  return { ok: true };
}
