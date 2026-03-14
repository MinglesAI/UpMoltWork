/**
 * Supabase Storage integration for gig file attachments.
 *
 * Requires env vars:
 *   SUPABASE_URL        — your Supabase project URL
 *   SUPABASE_SERVICE_KEY — service role key (bypasses RLS)
 *
 * Bucket: gig-attachments (must be created in Supabase dashboard or via migration)
 *
 * File size limit: 10 MB per attachment.
 * Allowed MIME types: image/*, application/pdf, text/plain, application/zip,
 *   application/octet-stream, video/mp4.
 */

const BUCKET = 'gig-attachments';
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
  'application/json',
  'application/octet-stream',
  'video/mp4',
]);

export { MAX_FILE_SIZE_BYTES };

function getSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL env var is not set');
  return url.replace(/\/$/, '');
}

function getServiceKey(): string {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY env var is not set');
  return key;
}

/**
 * Upload a file buffer to Supabase Storage.
 *
 * @param storageKey  Path within the bucket (e.g. "orders/go_abc/att_xyz.pdf")
 * @param fileBuffer  Raw file data as Buffer
 * @param mimeType    MIME type of the file
 * @returns Public URL of the uploaded file
 */
export async function uploadToStorage(
  storageKey: string,
  fileBuffer: Buffer,
  mimeType: string,
): Promise<string> {
  const base = getSupabaseUrl();
  const key = getServiceKey();

  const uploadUrl = `${base}/storage/v1/object/${BUCKET}/${storageKey}`;
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': mimeType,
      'x-upsert': 'false',
    },
    body: new Uint8Array(fileBuffer),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Storage upload failed (${res.status}): ${body}`);
  }

  // Build public URL
  return `${base}/storage/v1/object/public/${BUCKET}/${storageKey}`;
}

/**
 * Delete a file from Supabase Storage.
 *
 * @param storageKey  Path within the bucket
 */
export async function deleteFromStorage(storageKey: string): Promise<void> {
  const base = getSupabaseUrl();
  const key = getServiceKey();

  const deleteUrl = `${base}/storage/v1/object/${BUCKET}/${storageKey}`;
  const res = await fetch(deleteUrl, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${key}` },
  });

  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`Storage delete failed (${res.status}): ${body}`);
  }
}

/**
 * Check whether storage is configured (env vars present).
 * Used to return helpful errors when storage is not set up.
 */
export function isStorageConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}
