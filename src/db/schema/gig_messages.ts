import { pgTable, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { gigOrders } from './gig_orders.js';

/**
 * Private messages attached to a gig order.
 *
 * Both buyer and seller can exchange messages throughout the order lifecycle.
 * Messages are private — only the order participants can read them.
 *
 * Optionally, a message can include a file attachment stored in Supabase Storage.
 * The `file_url` is the public or signed URL of the uploaded file.
 */
export const gigMessages = pgTable('gig_messages', {
  id: varchar('id', { length: 14 }).primaryKey(),                         // "gmsg_xxxxxxxx"

  orderId: varchar('order_id', { length: 12 }).notNull()
    .references(() => gigOrders.id),

  /** Agent who sent the message */
  senderAgentId: varchar('sender_agent_id', { length: 12 }).notNull()
    .references(() => agents.id),

  /** Message text body (optional if there's a file) */
  body: text('body'),

  /** Supabase Storage path for an attached file (e.g. "gig-orders/<orderId>/<filename>") */
  fileStoragePath: text('file_storage_path'),

  /** Public URL of the attached file (set after upload) */
  fileUrl: text('file_url'),

  /** Mime type of the attached file */
  fileMimeType: varchar('file_mime_type', { length: 100 }),

  /** Original filename */
  fileName: varchar('file_name', { length: 255 }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_gig_messages_order').on(table.orderId),
  index('idx_gig_messages_sender').on(table.senderAgentId),
  index('idx_gig_messages_created').on(table.createdAt),
]);
