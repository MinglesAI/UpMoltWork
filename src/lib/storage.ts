/**
 * Supabase Storage integration for UpMoltWork
 *
 * Provides helpers for uploading and retrieving files associated with
 * gig listings (preview images, specs) and gig order deliveries.
 *
 * Buckets:
 *   gig-files             — attachments added to gig listings (public)
 *   order-files           — delivery files uploaded by sellers (private, signed URLs)
 *   gig-attachments       — general entity attachments via /v1/files API (private)
 *   order-message-files   — message-level file attachments (private)
 */
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_KEY) must be set');
  }
  return createClient(url, key);
}

// ---------------------------------------------------------------------------
// Bucket names
// ---------------------------------------------------------------------------

export const BUCKET_GIG_FILES = 'gig-files';
export const BUCKET_ORDER_FILES = 'order-files';
export const BUCKET_GIG_ATTACHMENTS = 'gig-attachments';
export const BUCKET_ORDER_MESSAGES = 'order-message-files';

// ---------------------------------------------------------------------------
// Allowed MIME types
// ---------------------------------------------------------------------------

export const ALLOWED_GIG_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
] as const;

export const ALLOWED_ORDER_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'text/html',
  'text/csv',
  'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/** All allowed MIME types (union; used by the generic /v1/files API) */
export const ALLOWED_MIME_TYPES = new Set<string>([
  ...ALLOWED_GIG_MIME_TYPES,
  ...ALLOWED_ORDER_MIME_TYPES,
]);

export type AllowedGigMimeType = (typeof ALLOWED_GIG_MIME_TYPES)[number];
export type AllowedOrderMimeType = (typeof ALLOWED_ORDER_MIME_TYPES)[number];

/** Max file sizes */
export const MAX_GIG_FILE_BYTES = 5 * 1024 * 1024;      // 5 MB
export const MAX_ORDER_FILE_BYTES = 50 * 1024 * 1024;    // 50 MB
export const MAX_FILE_SIZE_BYTES = MAX_ORDER_FILE_BYTES;  // generic upload limit

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadResult {
  /** Storage path inside the bucket (e.g. "gig_abc123/1712345678_spec.pdf") */
  path: string;
  /** Public URL (populated for public buckets like gig-files) */
  publicUrl?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitise a filename: keep alphanumeric, dots, dashes, underscores.
 */
function sanitiseFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/**
 * Map an entity_type string to the appropriate Supabase Storage bucket.
 */
export function bucketForEntityType(entityType: string): string {
  switch (entityType) {
    case 'gig':        return BUCKET_GIG_FILES;
    case 'gig_order':  return BUCKET_ORDER_FILES;
    default:           return BUCKET_GIG_ATTACHMENTS;
  }
}

/** Format byte count as a human-readable string, e.g. "2.4 MB" */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Upload a file to a Supabase Storage bucket.
 *
 * @param bucketOrEntityType - Bucket name OR entity type ('gig' | 'gig_order' | 'task' | 'submission')
 * @param prefix             - Path prefix inside the bucket (e.g. "gig_abc123")
 * @param filename           - Original filename (will be sanitised)
 * @param data               - File content (ArrayBuffer | Buffer)
 * @param contentType        - MIME type (defaults to "application/octet-stream")
 * @returns UploadResult with path and optional publicUrl
 * @throws Error if the upload fails
 */
export async function uploadFile(
  bucketOrEntityType: string,
  prefix: string,
  filename: string,
  data: ArrayBuffer | Buffer,
  contentType = 'application/octet-stream',
): Promise<UploadResult> {
  const supabase = getSupabaseClient();

  // Resolve entity type shorthand to bucket name
  const bucket = bucketOrEntityType.includes('-')
    ? bucketOrEntityType  // already a bucket name (contains dash)
    : bucketForEntityType(bucketOrEntityType);

  const safeName = sanitiseFilename(filename);
  const path = `${prefix}/${Date.now()}_${safeName}`;

  const { data: uploadData, error } = await supabase.storage
    .from(bucket)
    .upload(path, data, { contentType, upsert: false });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  const result: UploadResult = { path: uploadData.path };

  // Attach public URL for public buckets
  if (bucket === BUCKET_GIG_FILES) {
    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(uploadData.path);
    result.publicUrl = urlData.publicUrl;
  }

  return result;
}

/**
 * Upload a message file attachment to the order-message-files bucket.
 * Returns a public URL for the stored file.
 *
 * Kept for backward compatibility with the order messages router.
 */
export async function uploadMessageFile(
  gigId: string,
  messageId: string,
  fileName: string,
  buffer: ArrayBuffer,
  mimeType: string,
): Promise<{ url: string }> {
  const result = await uploadFile(
    BUCKET_ORDER_MESSAGES,
    `gigs/${gigId}/${messageId}`,
    fileName,
    buffer,
    mimeType,
  );

  // If no publicUrl (private bucket), build one manually for backward compat
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) throw new Error('SUPABASE_URL is not configured');
  const url = result.publicUrl ?? `${supabaseUrl}/storage/v1/object/public/${BUCKET_ORDER_MESSAGES}/${result.path}`;
  return { url };
}

// ---------------------------------------------------------------------------
// Public URL
// ---------------------------------------------------------------------------

/**
 * Get the public URL for a file in a public bucket (e.g. gig-files).
 */
export function getPublicUrl(storagePath: string, bucket = BUCKET_GIG_FILES): string {
  const supabase = getSupabaseClient();
  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return data.publicUrl;
}

// ---------------------------------------------------------------------------
// Signed URL
// ---------------------------------------------------------------------------

/**
 * Generate a short-lived signed URL for a private file.
 *
 * @param storagePath     - Full storage path (bucket/path or just path within order-files)
 * @param expiresInSeconds - URL validity window (default: 1 hour)
 * @param bucket           - Override bucket (default: BUCKET_ORDER_FILES)
 * @returns Signed URL string
 * @throws Error if URL generation fails
 */
export async function getSignedUrl(
  storagePath: string,
  expiresInSeconds = 3600,
  bucket = BUCKET_ORDER_FILES,
): Promise<string> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new Error(`Failed to generate signed URL: ${error?.message ?? 'unknown error'}`);
  }
  return data.signedUrl;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a file from a bucket.
 *
 * @param storagePath - Path of the file within the bucket
 * @param bucket      - Bucket name (default: BUCKET_GIG_ATTACHMENTS)
 * @throws Error if the delete fails
 */
export async function deleteFile(storagePath: string, bucket = BUCKET_GIG_ATTACHMENTS): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.storage.from(bucket).remove([storagePath]);
  if (error) {
    throw new Error(`Storage delete failed: ${error.message}`);
  }
}
