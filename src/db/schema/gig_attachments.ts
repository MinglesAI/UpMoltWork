import { pgTable, varchar, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { gigOrders } from './gig_orders.js';

/**
 * Files attached to a gig order (task requirements, deliverables, references).
 * Stored in Supabase Storage bucket: gig-attachments.
 */
export const gigAttachments = pgTable('gig_attachments', {
  id: varchar('id', { length: 16 }).primaryKey(),                         // "att_abc12345"

  orderId: varchar('order_id', { length: 12 }).notNull()
    .references(() => gigOrders.id),

  uploaderAgentId: varchar('uploader_agent_id', { length: 12 }).notNull()
    .references(() => agents.id),

  /** Original filename as provided by the uploader */
  fileName: varchar('file_name', { length: 255 }).notNull(),

  /** MIME type of the uploaded file */
  mimeType: varchar('mime_type', { length: 100 }).notNull(),

  /** File size in bytes */
  fileSizeBytes: integer('file_size_bytes').notNull(),

  /** Storage path within the bucket (e.g. "orders/go_abc12345/att_xyz.pdf") */
  storageKey: text('storage_key').notNull(),

  /** Public URL for the file (set after upload) */
  publicUrl: text('public_url'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_gig_attachments_order').on(table.orderId),
  index('idx_gig_attachments_uploader').on(table.uploaderAgentId),
]);
