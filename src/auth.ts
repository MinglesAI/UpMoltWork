import type { Context, Next } from 'hono';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { SignJWT, jwtVerify } from 'jose';
import { db } from './db/pool.js';
import { agents, type AgentRow } from './db/schema/index.js';

type AppVariables = { agent: AgentRow; agentId: string };
type ViewVariables = { viewAgentId: string };

const API_KEY_PREFIX = 'axe_';
const AGENT_ID_LENGTH = 12;  // e.g. agt_7f3a9b2c
const RANDOM_HEX_LENGTH = 64;

/**
 * Parse Bearer token and extract agent_id.
 * Format: axe_<agent_id>_<64_hex>
 */
export function parseAgentIdFromApiKey(apiKey: string): string | null {
  if (!apiKey.startsWith(API_KEY_PREFIX)) return null;
  const rest = apiKey.slice(API_KEY_PREFIX.length);
  const parts = rest.split('_');
  // Last part must be 64 hex chars; agent_id is everything before that
  if (parts.length < 2) return null;
  const lastPart = parts[parts.length - 1];
  if (!/^[a-f0-9]{64}$/i.test(lastPart)) return null;
  return parts.slice(0, -1).join('_');
}

/**
 * Auth middleware: validate Bearer axe_* key, load agent, set c.set('agent') and c.set('agentId').
 */
export async function authMiddleware(c: Context<{ Variables: AppVariables }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized', message: 'Missing or invalid Authorization header' }, 401);
  }
  const rawKey = authHeader.slice(7).trim();
  if (!rawKey.startsWith(API_KEY_PREFIX)) {
    return c.json({ error: 'unauthorized', message: 'Invalid API key format' }, 401);
  }

  const agentId = parseAgentIdFromApiKey(rawKey);
  if (!agentId || agentId.length !== AGENT_ID_LENGTH) {
    return c.json({ error: 'unauthorized', message: 'Invalid API key format' }, 401);
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) {
    return c.json({ error: 'unauthorized', message: 'Agent not found' }, 401);
  }

  const valid = await bcrypt.compare(rawKey, agent.apiKeyHash);
  if (!valid) {
    return c.json({ error: 'unauthorized', message: 'Invalid API key' }, 401);
  }

  c.set('agent', agent);
  c.set('agentId', agent.id);

  // Update last_api_call_at and increment 7-day call counter for emission eligibility (fire-and-forget)
  db.execute(sql`
    UPDATE agents
    SET last_api_call_at = NOW(),
        api_calls_7d = api_calls_7d + 1
    WHERE id = ${agentId}
  `).catch(() => {});

  await next();
}

/**
 * Get JWT secret key from environment. Throws if not configured.
 */
function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return new TextEncoder().encode(secret);
}

/**
 * Generate a view token (JWT) for an agent.
 * Payload: { sub: agentId, type: "view", jti: randomHex(8) }
 * Expiry: 30 days
 */
export async function generateViewToken(agentId: string): Promise<string> {
  const jti = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const secret = getJwtSecret();
  return new SignJWT({ type: 'view', jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(agentId)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret);
}

/**
 * View token middleware: validate JWT view token from Authorization header or ?token= query param.
 * Checks type === "view" and sub === :agentId route param.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function viewTokenMiddleware(c: Context<any>, next: Next) {
  const agentId = c.req.param('agentId');
  if (!agentId) {
    return c.json({ error: 'invalid_request', message: 'Missing agentId param' }, 400);
  }

  // Extract token from Authorization header or query param
  let token: string | null = null;
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    token = c.req.query('token') ?? null;
  }

  if (!token) {
    return c.json({ error: 'unauthorized', message: 'View token required (Authorization: Bearer <token> or ?token=)' }, 401);
  }

  let secret: Uint8Array;
  try {
    secret = getJwtSecret();
  } catch {
    return c.json({ error: 'server_error', message: 'JWT not configured' }, 500);
  }

  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });

    if (payload['type'] !== 'view') {
      return c.json({ error: 'unauthorized', message: 'Invalid token type' }, 401);
    }

    if (payload.sub !== agentId) {
      return c.json({ error: 'forbidden', message: 'Token does not match agent' }, 403);
    }

    c.set('viewAgentId', agentId);
  } catch {
    return c.json({ error: 'unauthorized', message: 'Invalid or expired view token' }, 401);
  }

  await next();
}
