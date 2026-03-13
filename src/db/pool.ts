import { lookup } from 'node:dns/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

const { Pool } = pg;

/**
 * Resolve host in a postgres URL to IPv4 and return a new URL.
 * Fixes ENETUNREACH when Docker has no IPv6 but Supabase host resolves to IPv6 first.
 */
async function connectionStringWithIPv4(connectionString: string): Promise<string> {
  try {
    const url = new URL(connectionString.replace(/^postgresql:\/\//, 'https://'));
    const host = url.hostname;
    const { address } = await lookup(host, { family: 4 });
    const auth = url.username && url.password
      ? `${encodeURIComponent(url.username)}:${encodeURIComponent(url.password)}@`
      : '';
    return `postgresql://${auth}${address}:${url.port}${url.pathname}${url.search || ''}`;
  } catch {
    return connectionString;
  }
}

const poolerUrl = process.env.DATABASE_POOLER_URL ?? process.env.DATABASE_URL;
const directUrl = process.env.DATABASE_URL;

if (!directUrl) {
  throw new Error('DATABASE_URL is required');
}

let poolerPool!: pg.Pool;
let directPool!: pg.Pool;
let _db!: ReturnType<typeof drizzle>;
let _dbDirect!: ReturnType<typeof drizzle>;

export async function initPool(): Promise<void> {
  const poolerStr = poolerUrl ?? directUrl;
  const directStr = directUrl;
  if (!poolerStr || !directStr) throw new Error('DATABASE_URL is required');
  const poolerResolved = await connectionStringWithIPv4(poolerStr);
  const directResolved = await connectionStringWithIPv4(directStr);

  poolerPool = new Pool({
    connectionString: poolerResolved,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  poolerPool.on('error', (err) => {
    console.warn('[pool] Pooler connection error (will retry):', err.message);
  });

  directPool = new Pool({
    connectionString: directResolved,
    max: 3,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 10_000,
  });

  _db = drizzle(poolerPool, { schema });
  _dbDirect = drizzle(directPool, { schema });
}

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_, prop) {
    if (!_db) throw new Error('DB not initialized: call await initPool() first');
    return (_db as unknown as Record<string, unknown>)[prop as string];
  },
});
export const dbDirect = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_, prop) {
    if (!_dbDirect) throw new Error('DB not initialized: call await initPool() first');
    return (_dbDirect as unknown as Record<string, unknown>)[prop as string];
  },
});
export { poolerPool, directPool };
