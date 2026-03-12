import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

const { Pool } = pg;

/**
 * Connection URLs:
 *
 * DATABASE_POOLER_URL  — Supavisor (transaction mode, port 6543)
 *   Use for most read/write API operations.
 *   Format: postgresql://postgres.<project-ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres
 *
 * DATABASE_URL  — Direct PostgreSQL (port 5432)
 *   Use for: SELECT...FOR UPDATE, DDL migrations, long sessions.
 *   Format: postgresql://postgres:<pw>@db.<project-ref>.supabase.co:5432/postgres
 *
 * Fallback: if DATABASE_POOLER_URL is not set, the pooler uses DATABASE_URL directly.
 * This is safe for development but reduces connection efficiency in production.
 */
const poolerUrl = process.env.DATABASE_POOLER_URL ?? process.env.DATABASE_URL;
const directUrl = process.env.DATABASE_URL;

if (!directUrl) {
  throw new Error('DATABASE_URL is required');
}

/**
 * Pooled connection via Supavisor (transaction mode).
 * Use for most read/write operations.
 *
 * ⚠️ NOT suitable for:
 *   - `SELECT ... FOR UPDATE` (requires session-level state)
 *   - DDL / schema migrations
 *   - `SET` session variables
 *
 * Note: If DATABASE_POOLER_URL is unreachable (e.g., during local dev from
 * restricted IPs), falls back to DATABASE_URL automatically.
 * Supavisor is available on Supabase Pro plan; on Free plan the pooler
 * endpoint resolves but may reject connections from non-Supabase IPs.
 */
const poolerPool = new Pool({
  connectionString: poolerUrl,
  // Supavisor manages the actual pool size; keep client-side pool small
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Gracefully handle pooler connection errors without crashing the process.
// In production the pooler is always reachable; in dev it may not be.
poolerPool.on('error', (err) => {
  console.warn('[pool] Pooler connection error (will retry):', err.message);
});

/**
 * Direct connection to PostgreSQL (bypasses Supavisor pooler).
 * Use for:
 *   - `SELECT ... FOR UPDATE` (pessimistic locking in Shells transfers)
 *   - Schema migrations
 *   - Long-running transactions requiring session state
 */
const directPool = new Pool({
  connectionString: directUrl,
  max: 3,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 10_000,
});

// Drizzle ORM instances
export const db = drizzle(poolerPool, { schema });         // For standard read/write
export const dbDirect = drizzle(directPool, { schema });   // For FOR UPDATE + migrations

// Export pools for health checks
export { poolerPool, directPool };
