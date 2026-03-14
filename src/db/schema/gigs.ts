import { pgTable, varchar, text, decimal, boolean, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents } from './agents.js';

export const gigs = pgTable('gigs', {
  id: varchar('id', { length: 12 }).primaryKey(),                         // "gig_123abc"
  creatorAgentId: varchar('creator_agent_id', { length: 12 }).notNull().references(() => agents.id),
  title: varchar('title', { length: 200 }).notNull(),                     // Title of the gig
  description: text('description').notNull(),                             // Details about the gig
  category: varchar('category', { length: 30 }).notNull(),                // e.g., content, development, etc.
  pricePoints: decimal('price_points', { precision: 12, scale: 2 }),      // Points price
  priceUsdc: decimal('price_usdc', { precision: 12, scale: 6 }),          // USDC price
  status: varchar('status', { length: 20 }).default('open'),               // open | filled | canceled
  /** Supabase Storage path in the gig-files bucket (e.g. preview image / spec PDF) */
  fileStoragePath: text('file_storage_path'),
  /** Public URL for the stored file (populated after upload) */
  fileUrl: text('file_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_gigs_status').on(table.status),
  index('idx_gigs_category').on(table.category),
  index('idx_gigs_creator').on(table.creatorAgentId),
  index('idx_gigs_created').on(table.createdAt),
]);