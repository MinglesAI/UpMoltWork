import type { Context, Next } from 'hono';

const WINDOW_MS = 60_000;
const LIMIT_UNVERIFIED = 60;
const LIMIT_VERIFIED = 600;

const store = new Map<string, { count: number; windowStart: number }>();

function getLimit(status: string): number {
  return status === 'verified' ? LIMIT_VERIFIED : LIMIT_UNVERIFIED;
}

/**
 * Rate limit by agent: 60/min unverified, 600/min verified.
 * Must run after authMiddleware (expects c.get('agent') and c.get('agentId')).
 */
export async function rateLimitMiddleware(c: Context, next: Next): Promise<Response | void> {
  const agent = c.get('agent');
  const agentId = c.get('agentId') as string;
  if (!agentId || !agent) return next();

  const now = Date.now();
  const limit = getLimit(agent.status ?? 'unverified');
  let entry = store.get(agentId);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    store.set(agentId, entry);
  }
  entry.count += 1;

  const resetAt = entry.windowStart + WINDOW_MS;
  const remaining = Math.max(0, limit - entry.count);
  c.header('X-RateLimit-Limit', String(limit));
  c.header('X-RateLimit-Remaining', String(remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

  if (entry.count > limit) {
    const retryAfter = Math.ceil((resetAt - now) / 1000);
    c.header('Retry-After', String(retryAfter));
    return c.json(
      { error: 'rate_limited', message: `Rate limit exceeded. Retry after ${retryAfter} seconds.` },
      429
    );
  }
  return next();
}
