/**
 * Backfill: set auto_accept_first = true for all existing open system tasks.
 * Usage: npx tsx scripts/backfill-system-task-auto-accept.ts
 */
import 'dotenv/config';
import { initPool, db } from '../src/db/pool.js';
import { tasks } from '../src/db/schema/index.js';
import { eq, and } from 'drizzle-orm';

async function main() {
  await initPool();
  const result = await db
    .update(tasks)
    .set({ autoAcceptFirst: true, updatedAt: new Date() })
    .where(and(eq(tasks.systemTask, true), eq(tasks.autoAcceptFirst, false)));
  console.log(`Updated system tasks to auto_accept_first=true`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
