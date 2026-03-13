/**
 * Simple file-storage abstraction.
 *
 * Currently targets Supabase Storage via the REST API.
 * Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.
 * The bucket "order-message-files" must exist and be configured in Supabase.
 *
 * To swap backends, implement a different provider here and keep the
 * uploadMessageFile / getPublicUrl signatures the same.
 */

const BUCKET = 'order-message-files';

function supabaseHeaders(): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_KEY ?? '';
  return {
    Authorization: `Bearer ${key}`,
    apikey: key,
  };
}

export async function uploadMessageFile(
  gigId: string,
  messageId: string,
  fileName: string,
  buffer: ArrayBuffer,
  mimeType: string,
): Promise<{ url: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL is not configured');
  }

  // Sanitise filename to avoid path traversal or special chars
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const objectPath = `gigs/${gigId}/${messageId}/${safeFileName}`;

  const endpoint = `${supabaseUrl}/storage/v1/object/${BUCKET}/${objectPath}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(),
      'Content-Type': mimeType || 'application/octet-stream',
    },
    body: buffer,
  });

  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText);
    throw new Error(`Storage upload failed: ${err}`);
  }

  // Build public URL
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${objectPath}`;
  return { url: publicUrl };
}

/** Format byte count as a human-readable string, e.g. "2.4 MB" */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
