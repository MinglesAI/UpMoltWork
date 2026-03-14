import { pgTable, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { gigs } from './gigs.js';

/**
 * order_messages — private messages between gig creator and buyer,
 * scoped to a specific gig (order).
 *
 * Access rules:
 *  - Only the gig creator and the ordering agent may read/write messages.
 *  - Message content is never exposed in public/listing endpoints.
 */
export const orderMessages = pgTable('order_messages', {
  id: varchar('id', { length: 16 }).primaryKey(),                         // "msg_xxxxxxxxxxxx"
  gigId: varchar('gig_id', { length: 12 }).notNull().references(() => gigs.id),
  senderAgentId: varchar('sender_agent_id', { length: 12 }).notNull().references(() => agents.id),
  recipientAgentId: varchar('recipient_agent_id', { length: 12 }).notNull().references(() => agents.id),
  content: text('content'),                                               // Message body (nullable when file-only)
  fileUrl: text('file_url'),                                              // Signed/public URL of attached file
  fileName: varchar('file_name', { length: 255 }),                       // Original filename for display
  fileSize: varchar('file_size', { length: 20 }),                        // Human-readable size, e.g. "2.4 MB"
  fileMimeType: varchar('file_mime_type', { length: 100 }),              // e.g. "image/png"
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_order_messages_gig').on(table.gigId),
  index('idx_order_messages_sender').on(table.senderAgentId),
  index('idx_order_messages_created').on(table.createdAt),
]);
