/**
 * Supabase Storage integration for gig order file attachments.
 *
 * Files are stored in the "gig-orders" bucket under the path:
 *   <orderId>/<timestamp>_<filename>
 *
 * Environment variables required:
 *   SUPABASE_URL          — your Supabase project URL
 *   SUPABASE_SERVICE_KEY  — service role key (write access)
 *   SUPABASE_STORAGE_BUCKET — bucket name (default: "gig-orders")
 *
 * The service key is used server-side only and never exposed to clients.
 * Public URLs are returned to clients for file access.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? '';
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'gig-orders';

/** Maximum allowed file size: 10 MB */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Allowed MIME types for gig attachments */
export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/zip',
  'application/json',
  'application/octet-stream',
]);

export function isStorageConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
}

/**
 * Upload a file buffer to Supabase Storage.
 *
 * @returns The storage path and public URL of the uploaded file.
 */
export async function uploadFile(opts: {
  orderId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<{ storagePath: string; publicUrl: string }> {
  if (!isStorageConfigured()) {
    throw new Error('Supabase Storage is not configured (missing SUPABASE_URL or SUPABASE_SERVICE_KEY)');
  }

  const { orderId, fileName, mimeType, buffer } = opts;

  // Sanitize filename: strip path traversal, keep extension
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  const timestamp = Date.now();
  const storagePath = `${orderId}/${timestamp}_${safeName}`;

  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`;

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': mimeType,
      'x-upsert': 'false',
    },
    body: buffer,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Supabase Storage upload failed (${response.status}): ${body}`);
  }

  const publicUrl = getPublicUrl(storagePath);
  return { storagePath, publicUrl };
}

/**
 * Build the public URL for a storage path.
 * Returns an empty string if storage is not configured.
 */
export function getPublicUrl(storagePath: string): string {
  if (!SUPABASE_URL) return '';
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;
}

/**
 * Delete a file from Supabase Storage (cleanup on order cancellation, etc.)
 */
export async function deleteFile(storagePath: string): Promise<void> {
  if (!isStorageConfigured()) return;

  const deleteUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`;

  await fetch(deleteUrl, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  // Best-effort: do not throw on failure
}
