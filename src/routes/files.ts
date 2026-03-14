/**
 * File Attachments API
 *
 * POST /v1/files/upload          — upload a file, attach it to a gig/order/task
 * GET  /v1/files/:fileId         — get file metadata
 * GET  /v1/files/:fileId/url     — get a signed download URL (1h TTL)
 * DELETE /v1/files/:fileId       — delete a file (uploader only)
 *
 * Files are stored in the appropriate Supabase Storage bucket based on entity type.
 * Metadata (path, mime, size, parent entity) is persisted in `file_attachments`.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { fileAttachments } from '../db/schema/index.js';
import { authMiddleware } from '../auth.js';
import { generateFileId } from '../lib/ids.js';
import {
  uploadFile,
  getSignedUrl,
  deleteFile,
  bucketForEntityType,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  BUCKET_GIG_ATTACHMENTS,
} from '../lib/storage.js';
import type { AgentRow } from '../db/schema/index.js';

type AppVariables = { agent: AgentRow; agentId: string };

export const filesRouter = new Hono<{ Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAttachment(a: typeof fileAttachments.$inferSelect) {
  return {
    id: a.id,
    uploaded_by_agent_id: a.uploadedByAgentId,
    task_id: a.taskId,
    gig_id: a.gigId,
    submission_id: a.submissionId,
    filename: a.filename,
    mimetype: a.mimetype,
    size_bytes: a.sizeBytes,
    created_at: a.createdAt?.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * POST /v1/files/upload
 *
 * Accepts multipart/form-data with:
 *   file           — the binary file
 *   entity_type    — "gig" | "gig_order" | "task" | "submission"
 *   entity_id      — ID of the parent entity
 *
 * Returns file metadata + a short-lived signed URL for immediate download.
 */
filesRouter.post('/upload', authMiddleware, async (c) => {
  const agent = c.get('agent');

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Expected multipart/form-data' }, 400);
  }

  const fileEntry = formData.get('file');
  if (!fileEntry || typeof fileEntry === 'string') {
    return c.json({ error: 'invalid_request', message: '`file` field is required and must be a file' }, 400);
  }

  const file = fileEntry as File;
  const entityType = (formData.get('entity_type') as string | null)?.trim() ?? '';
  const entityId   = (formData.get('entity_id')   as string | null)?.trim() ?? '';

  const validEntityTypes = ['gig', 'gig_order', 'task', 'submission'];
  if (!validEntityTypes.includes(entityType)) {
    return c.json(
      { error: 'invalid_request', message: `entity_type must be one of: ${validEntityTypes.join(', ')}` },
      400,
    );
  }
  if (!entityId) {
    return c.json({ error: 'invalid_request', message: 'entity_id is required' }, 400);
  }

  // Check MIME
  const mimetype = file.type || 'application/octet-stream';
  if (!ALLOWED_MIME_TYPES.has(mimetype)) {
    return c.json(
      {
        error: 'invalid_mime_type',
        message: `File type '${mimetype}' is not allowed. Allowed types: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
      },
      415,
    );
  }

  // Check size
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    return c.json({ error: 'file_too_large', message: 'File exceeds 50 MB maximum size' }, 413);
  }

  // Upload to Supabase Storage
  let uploadResult;
  try {
    uploadResult = await uploadFile(entityType, entityId, file.name, buffer, mimetype);
  } catch (err) {
    const e = err as Error;
    console.error('[files] Upload error:', e.message);
    return c.json({ error: 'upload_failed', message: e.message }, 500);
  }

  // Persist metadata
  const fileId = generateFileId();

  const insertValues: {
    id: string;
    uploadedByAgentId: string;
    storagePath: string;
    filename: string;
    mimetype: string;
    sizeBytes: number;
    taskId?: string;
    gigId?: string;
    submissionId?: string;
  } = {
    id: fileId,
    uploadedByAgentId: agent.id,
    storagePath: uploadResult.path,
    filename: file.name.substring(0, 255),
    mimetype,
    sizeBytes: buffer.byteLength,
  };

  // Set the appropriate FK based on entity_type
  if (entityType === 'task')       insertValues.taskId = entityId;
  if (entityType === 'gig')        insertValues.gigId  = entityId;
  if (entityType === 'gig_order')  insertValues.gigId  = entityId;
  if (entityType === 'submission') insertValues.submissionId = entityId;

  await db.insert(fileAttachments).values(insertValues);

  const [row] = await db
    .select()
    .from(fileAttachments)
    .where(eq(fileAttachments.id, fileId))
    .limit(1);

  // For private buckets generate a signed URL; for public buckets use publicUrl
  let downloadUrl: string | null = uploadResult.publicUrl ?? null;
  if (!downloadUrl) {
    try {
      const bucket = bucketForEntityType(entityType);
      downloadUrl = await getSignedUrl(uploadResult.path, 3600, bucket);
    } catch {
      downloadUrl = null;
    }
  }

  return c.json(
    {
      ...formatAttachment(row!),
      download_url: downloadUrl,
      download_url_expires_in: downloadUrl && !uploadResult.publicUrl ? 3600 : null,
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// Get metadata
// ---------------------------------------------------------------------------

/**
 * GET /v1/files/:fileId
 * Returns file metadata. Authenticated; no access control beyond auth.
 */
filesRouter.get('/:fileId', authMiddleware, async (c) => {
  const fileId = c.req.param('fileId') ?? '';
  if (!fileId) return c.json({ error: 'invalid_request', message: 'Missing file id' }, 400);

  const [row] = await db
    .select()
    .from(fileAttachments)
    .where(eq(fileAttachments.id, fileId))
    .limit(1);

  if (!row) return c.json({ error: 'not_found', message: 'File not found' }, 404);

  return c.json(formatAttachment(row));
});

// ---------------------------------------------------------------------------
// Get signed download URL
// ---------------------------------------------------------------------------

/**
 * GET /v1/files/:fileId/url
 * Returns a short-lived signed URL (1 hour) for downloading the file.
 * Authenticated; any authenticated agent can retrieve the URL.
 */
filesRouter.get('/:fileId/url', authMiddleware, async (c) => {
  const fileId = c.req.param('fileId') ?? '';
  if (!fileId) return c.json({ error: 'invalid_request', message: 'Missing file id' }, 400);

  const expiresIn = Math.min(
    Math.max(parseInt(c.req.query('expires_in') ?? '3600', 10) || 3600, 60),
    86400,  // max 24 hours
  );

  const [row] = await db
    .select()
    .from(fileAttachments)
    .where(eq(fileAttachments.id, fileId))
    .limit(1);

  if (!row) return c.json({ error: 'not_found', message: 'File not found' }, 404);

  let signedUrl: string;
  try {
    signedUrl = await getSignedUrl(row.storagePath, expiresIn, BUCKET_GIG_ATTACHMENTS);
  } catch (err) {
    const e = err as Error;
    return c.json({ error: 'signed_url_failed', message: e.message }, 500);
  }

  return c.json({
    file_id: row.id,
    filename: row.filename,
    download_url: signedUrl,
    expires_in: expiresIn,
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * DELETE /v1/files/:fileId
 * Deletes the file from storage and removes the metadata record.
 * Only the uploader can delete.
 */
filesRouter.delete('/:fileId', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const fileId = c.req.param('fileId') ?? '';
  if (!fileId) return c.json({ error: 'invalid_request', message: 'Missing file id' }, 400);

  const [row] = await db
    .select()
    .from(fileAttachments)
    .where(eq(fileAttachments.id, fileId))
    .limit(1);

  if (!row) return c.json({ error: 'not_found', message: 'File not found' }, 404);
  if (row.uploadedByAgentId !== agent.id) {
    return c.json({ error: 'forbidden', message: 'Only the uploader can delete this file' }, 403);
  }

  try {
    await deleteFile(row.storagePath, BUCKET_GIG_ATTACHMENTS);
  } catch (err) {
    // Log but continue — remove DB record even if storage delete fails
    console.error('[files] Storage delete error:', (err as Error).message);
  }

  await db.delete(fileAttachments).where(eq(fileAttachments.id, fileId));

  return c.json({ deleted: true, file_id: fileId });
});
