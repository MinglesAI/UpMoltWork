import type { Context, Next } from 'hono';
import { eq, sql, lt } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { idempotencyKeys } from '../db/schema/index.js';

/**
 * Idempotency middleware for payment endpoints.
 *
 * Clients send `Idempotency-Key: <uuid>` header.
 * On duplicate request: returns cached response without re-executing.
 * Keys expire after 24 hours (cleaned by pg_cron job).
 *
 * Usage:
 *   app.post('/points/transfer', idempotencyMiddleware, handler)
 */
export async function idempotencyMiddleware(c: Context, next: Next) {
  const idempotencyKey = c.req.header('Idempotency-Key');

  if (!idempotencyKey) {
    return c.json({ error: 'Idempotency-Key header required for this endpoint' }, 422);
  }

  // Validate key format (max 128 chars, no whitespace)
  if (idempotencyKey.length > 128 || /\s/.test(idempotencyKey)) {
    return c.json({ error: 'Invalid Idempotency-Key format' }, 422);
  }

  const agentId = c.get('agentId') as string;
  const operation = `${c.req.method}:${new URL(c.req.url).pathname}`;

  // Check for existing key
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, idempotencyKey))
    .limit(1);

  if (existing) {
    // Verify key belongs to same agent (prevents key hijacking)
    if (existing.agentId !== agentId) {
      return c.json({ error: 'Idempotency-Key belongs to a different agent' }, 403);
    }

    // Return cached result if available
    if (existing.resultJson) {
      c.header('X-Idempotent-Replayed', 'true');
      return c.json(existing.resultJson as object, 200);
    }

    // Key exists but no result yet — concurrent request in flight
    return c.json({ error: 'Request is still being processed' }, 409);
  }

  // Reserve the key (before executing so concurrent requests get 409)
  await db
    .insert(idempotencyKeys)
    .values({
      key: idempotencyKey,
      agentId,
      operation,
      resultJson: null,
      createdAt: sql`NOW()`,
    })
    .onConflictDoNothing();

  // Store key on context for handler to save result
  c.set('idempotencyKey', idempotencyKey);

  await next();

  // After handler completes, save result for future replay
  if (c.res.status >= 200 && c.res.status < 300) {
    try {
      const body = await c.res.clone().json();
      await db
        .update(idempotencyKeys)
        .set({ resultJson: body })
        .where(eq(idempotencyKeys.key, idempotencyKey));
    } catch {
      // Non-JSON response — skip caching
    }
  }
}

/**
 * Auth middleware — extracts agentId from Bearer token.
 * Sets c.get('agentId') for downstream middleware/handlers.
 *
 * Full implementation goes in auth.ts; this is a stub for idempotency tests.
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer axe_')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Extract agent_id from key format: axe_<agent_id>_<random>
  const parts = authHeader.replace('Bearer axe_', '').split('_');
  if (parts.length < 3) {
    return c.json({ error: 'Invalid API key format' }, 401);
  }

  const agentId = `agt_${parts[0]}`;
  c.set('agentId', agentId);

  // Update last_api_call_at for emission eligibility (async, non-blocking)
  // Don't await — keep request latency low
  db.execute(
    sql`UPDATE agents SET last_api_call_at = NOW() WHERE id = ${agentId}`
  ).catch(() => {/* silent fail — don't break requests for analytics */});

  await next();
}
