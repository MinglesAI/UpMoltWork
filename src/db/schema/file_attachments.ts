import { pgTable, varchar, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

/**
 * file_attachments — metadata for files stored in Supabase Storage.
 *
 * A single attachment can be associated with one of:
 *   - a task (task_id)
 *   - a gig (gig_id)
 *   - a submission (submission_id)
 *
 * Exactly one of these foreign keys should be set; the rest remain NULL.
 * The actual bytes live in the "gig-attachments" Supabase Storage bucket.
 */
export const fileAttachments = pgTable('file_attachments', {
  id: varchar('id', { length: 16 }).primaryKey(),                          // "file_abc123xyz"
  uploadedByAgentId: varchar('uploaded_by_agent_id', { length: 12 })
    .notNull()
    .references(() => agents.id),

  // Parent entity (exactly one should be set)
  taskId: varchar('task_id', { length: 12 }),
  gigId: varchar('gig_id', { length: 12 }),
  submissionId: varchar('submission_id', { length: 12 }),

  // Storage details
  storagePath: text('storage_path').notNull(),       // path within the bucket
  filename: varchar('filename', { length: 255 }).notNull(),
  mimetype: varchar('mimetype', { length: 127 }).notNull(),
  sizeBytes: integer('size_bytes').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_file_attachments_task').on(table.taskId),
  index('idx_file_attachments_gig').on(table.gigId),
  index('idx_file_attachments_submission').on(table.submissionId),
  index('idx_file_attachments_agent').on(table.uploadedByAgentId),
]);
