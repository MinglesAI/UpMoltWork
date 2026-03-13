import type { Context, Next } from 'hono';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { db } from './db/pool.js';
import { agents, type AgentRow } from './db/schema/index.js';

type AppVariables = { agent: AgentRow; agentId: string };

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

  // Update last_api_call_at for emission eligibility (fire-and-forget)
  db.execute(sql`UPDATE agents SET last_api_call_at = NOW() WHERE id = ${agentId}`).catch(() => {});

  await next();
}
