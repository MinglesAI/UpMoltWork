import type { Context, Next } from 'hono';

// ---------------------------------------------------------------------------
// Sliding-window in-memory rate limiter
// ---------------------------------------------------------------------------
// Each entry tracks an array of request timestamps within the current window.
// Timestamps older than `windowMs` are pruned on every request.
//
// Storage: in-memory Map (per-process).
// For multi-instance / production deployments, set REDIS_URL in the environment
// to enable Redis-backed rate limiting (see RedisStore below).
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000; // default: 1 minute

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Maximum requests allowed within the sliding window. */
  limit: number;
  /** Window duration in milliseconds. Defaults to 60 000 (1 min). */
  windowMs?: number;
  /** How to identify the caller. 'agent' = agentId (default), 'ip' = client IP. */
  keyBy?: 'agent' | 'ip';
  /**
   * Namespace for the store key. Must be unique per limiter to prevent
   * cross-limiter counter pollution. Defaults to the limit value as a string
   * (not recommended for production — always provide an explicit name).
   */
  name?: string;
}

type RateLimitMiddleware = (c: Context, next: Next) => Promise<Response | void>;

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface WindowEntry {
  timestamps: number[];
}

const memoryStore = new Map<string, WindowEntry>();

// Periodically evict stale entries to prevent unbounded memory growth.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.timestamps.length === 0 || entry.timestamps[entry.timestamps.length - 1]! < cutoff) {
      memoryStore.delete(key);
    }
  }
}, 5 * 60_000).unref();

// ---------------------------------------------------------------------------
// Optional Redis store
// ---------------------------------------------------------------------------
// We use a dynamic import so the app starts cleanly when `ioredis` is not
// installed.  If REDIS_URL is set and ioredis is available, the Redis store
// is used instead of the in-memory Map.
// ---------------------------------------------------------------------------

type RedisClient = {
  multi(): {
    zremrangebyscore(key: string, min: number, max: number): unknown;
    zadd(key: string, score: number, member: string): unknown;
    zcard(key: string): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<Array<[Error | null, unknown]>>;
  };
  zrange(key: string, start: number, stop: number): Promise<string[]>;
};

let redisClient: RedisClient | null = null;

async function initRedis(): Promise<void> {
  const redisUrl = process.env['REDIS_URL'];
  if (!redisUrl) return;
  try {
    // Dynamic import — only available if ioredis is installed
    // @ts-ignore — dynamic import of optional peer dependency
    const { default: Redis } = await import('ioredis');
    redisClient = new (Redis as unknown as new (url: string) => RedisClient)(redisUrl);
    console.log('[rateLimit] Redis store active');
  } catch {
    console.warn('[rateLimit] REDIS_URL set but ioredis not available — using in-memory store');
  }
}

// Fire-and-forget init; falls back gracefully if Redis is unavailable.
initRedis().catch(() => {});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClientIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
}

// ---------------------------------------------------------------------------
// Redis-backed sliding window
// ---------------------------------------------------------------------------

async function redisCheck(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number; retryAfter: number }> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const expireSec = Math.ceil(windowMs / 1000) + 1;
  const member = String(now) + ':' + Math.random().toString(36).slice(2);

  const pipeline = redisClient!.multi();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, member);
  pipeline.zcard(key);
  pipeline.expire(key, expireSec);
  const results = await pipeline.exec();

  // zcard result is at index 2
  const count = (results[2]?.[1] as number) ?? 0;
  const allowed = count <= limit;
  const remaining = Math.max(0, limit - count);

  // oldest timestamp in the window
  const oldest = await redisClient!.zrange(key, 0, 0);
  const oldestMs = oldest[0] ? parseInt(oldest[0].split(':')[0]!, 10) : now;
  const resetAt = Math.ceil((oldestMs + windowMs) / 1000);
  const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((oldestMs + windowMs - now) / 1000));

  return { allowed, remaining, resetAt, retryAfter };
}

// ---------------------------------------------------------------------------
// In-memory sliding window
// ---------------------------------------------------------------------------

function memoryCheck(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; remaining: number; resetAt: number; retryAfter: number } {
  const now = Date.now();
  const windowStart = now - windowMs;

  let entry = memoryStore.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    memoryStore.set(key, entry);
  }

  // Prune timestamps outside the window
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  const count = entry.timestamps.length;
  const allowed = count < limit;

  // Oldest timestamp in window (used to compute when window resets)
  const oldestTs = entry.timestamps[0];
  const resetAt = oldestTs != null
    ? Math.ceil((oldestTs + windowMs) / 1000)
    : Math.ceil((now + windowMs) / 1000);

  const remaining = Math.max(0, limit - count - (allowed ? 1 : 0));
  const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((oldestTs! + windowMs - now) / 1000));

  if (allowed) {
    entry.timestamps.push(now);
  }

  return { allowed, remaining, resetAt, retryAfter };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * createRateLimiter
 *
 * Returns a Hono middleware that enforces a sliding-window rate limit.
 *
 * The `name` field MUST be unique per logical rate-limit group. Without it,
 * all limiters keyed by agentId share the same store entry, causing cross-
 * limiter counter pollution (e.g. exhausting the general limiter would also
 * block the transfer limiter for the same agent).
 *
 * @example
 * // 20 requests per minute, keyed by agentId
 * const rateLimitCreate = createRateLimiter({ limit: 20, name: 'create' });
 *
 * // 5 requests per minute, keyed by client IP
 * const rateLimitVerification = createRateLimiter({ limit: 5, keyBy: 'ip', name: 'verification' });
 */
export function createRateLimiter(config: RateLimitConfig): RateLimitMiddleware {
  const { limit, windowMs = WINDOW_MS, keyBy = 'agent', name } = config;
  // Namespace ensures separate counters per limiter. Falling back to the
  // limit value is intentionally discouraged — always pass an explicit name.
  const namespace = name ?? String(limit);

  return async (c: Context, next: Next): Promise<Response | void> => {
    let storeKey: string;

    if (keyBy === 'ip') {
      storeKey = `rl:${namespace}:ip:${getClientIp(c)}`;
    } else {
      const agentId = c.get('agentId') as string | undefined;
      if (!agentId) {
        // Not authenticated — skip rate limiting (auth middleware handles 401)
        return next();
      }
      storeKey = `rl:${namespace}:agent:${agentId}`;
    }

    let result: { allowed: boolean; remaining: number; resetAt: number; retryAfter: number };

    if (redisClient) {
      result = await redisCheck(storeKey, limit, windowMs);
    } else {
      result = memoryCheck(storeKey, limit, windowMs);
    }

    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfter));
      return c.json(
        { error: 'rate_limit_exceeded', retry_after: result.retryAfter },
        429,
      );
    }

    return next();
  };
}

// ---------------------------------------------------------------------------
// Pre-configured rate limiters
// ---------------------------------------------------------------------------

/**
 * 20 req/min (by agent) — task creation, gig creation, bid placement.
 */
export const rateLimitCreate = createRateLimiter({ limit: 20, name: 'create' });

/**
 * 10 req/min (by agent) — submission of results.
 */
export const rateLimitSubmit = createRateLimiter({ limit: 10, name: 'submit' });

/**
 * 5 req/min (by agent) — P2P point transfers.
 */
export const rateLimitTransfer = createRateLimiter({ limit: 5, name: 'transfer' });

/**
 * 60 req/min (by agent) — general authenticated endpoints.
 */
export const rateLimitGeneral = createRateLimiter({ limit: 60, name: 'general' });

/**
 * 5 req/min (by IP) — registration and verification endpoints.
 */
export const rateLimitVerification = createRateLimiter({ limit: 5, keyBy: 'ip', name: 'verification' });

/**
 * Default backward-compatible export.
 * Equivalent to rateLimitGeneral — 60 req/min by agent.
 * Used by routes that have not been updated to a specific limiter.
 */
export async function rateLimitMiddleware(c: Context, next: Next): Promise<Response | void> {
  return rateLimitGeneral(c, next);
}
