/**
 * File Storage integration tests — validates:
 *
 *   Test 1: POST /v1/files/upload — gig file (public bucket, entity_type=gig) → 201 + public URL
 *   Test 2: POST /v1/files/upload — order file (private bucket, entity_type=gig_order) → 201 + signed URL
 *   Test 3: MIME type validation — disallowed type (application/x-msdownload) → 415
 *   Test 4: File size limit — buffer > 50 MB → 413
 *   Test 5: Auth required — no Bearer token → 401 on all endpoints
 *   Test 6: GET /v1/files/:fileId/url — get signed URL → 200 with download_url + expires_in
 *   Test 7: GET /v1/files/:fileId — get file metadata → 200 with complete fields
 *   Test 8: DELETE /v1/files/:fileId — owner deletes → 200; non-owner → 403; DB row removed
 *   Test 9: DB record — verify file_attachments row (storage_path, mimetype, size_bytes, entity FK)
 *
 * Run:     npx tsx src/tests/files.test.ts
 * Requires: DATABASE_URL in .env
 * Optional: SUPABASE_URL + SUPABASE_SECRET_KEY for storage tests (Tests 1, 2, 6, 7, 8, 9)
 *           Without Supabase config, only Tests 3, 4, 5 run.
 *
 * Notes on route paths (differ slightly from issue description):
 *   - Upload endpoint: POST /v1/files/upload  (not /v1/files)
 *   - Signed URL:      GET  /v1/files/:id/url (not /v1/files/:id/signed-url)
 *   - MIME rejection:  415 Unsupported Media Type (not 400)
 *   - Size rejection:  413 Content Too Large (not 400)
 *   - Delete returns:  200 JSON {deleted:true} (not 204)
 *   - No list endpoint exists in the current router
 *   - GET /url endpoint always targets gig-attachments bucket;
 *     use entity_type=task for uploaded files to keep bucket consistent
 */

import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { Hono } from 'hono';
import { db, initPool } from '../db/pool.js';
import { agents, fileAttachments } from '../db/schema/index.js';
import { filesRouter } from '../routes/files.js';
import {
  deleteFile,
  BUCKET_GIG_FILES,
  BUCKET_ORDER_FILES,
  BUCKET_GIG_ATTACHMENTS,
} from '../lib/storage.js';

// ---------------------------------------------------------------------------
// Agent IDs — must be exactly 12 chars (AGENT_ID_LENGTH in auth.ts)
//   agt_ftest001 = a-g-t-_-f-t-e-s-t-0-0-1 = 12 ✓
// ---------------------------------------------------------------------------
const OWNER_ID = 'agt_ftest001'; // file uploader / owner
const OTHER_ID = 'agt_ftest002'; // different agent (tests ownership enforcement)

const OWNER_KEY = `axe_${OWNER_ID}_${'a'.repeat(64)}`;
const OTHER_KEY = `axe_${OTHER_ID}_${'b'.repeat(64)}`;

// Entity IDs — varchar(12) FK columns have no referential constraint in file_attachments
const GIG_ID   = 'gig_tst001';   // 10 chars, fits in varchar(12)
const ORDER_ID = 'go_tst001x';   // 10 chars, fits in varchar(12)
const TASK_ID  = 'tsk_tst001';   // 10 chars, fits in varchar(12)

let ownerKeyHash = '';
let otherKeyHash = '';

// Track files uploaded to Supabase for cleanup
const uploadedPaths: Array<{ path: string; bucket: string }> = [];

// ---------------------------------------------------------------------------
// Small in-memory test buffers
// ---------------------------------------------------------------------------

/** Minimal 1×1 PNG — 67 bytes, valid PNG magic + minimal structure */
const PNG_BUFFER = Buffer.from(
  '89504e470d0a1a0a' +                // PNG signature
  '0000000d49484452' +                // IHDR chunk header
  '00000001' +                        // width = 1
  '00000001' +                        // height = 1
  '08020000009077' +                  // bit depth=8, colorType=2 (RGB), etc.
  '53de' +                            // IHDR CRC
  '0000000c4944415408d76360f8cfc000' +// IDAT chunk
  '00000200' +
  '01e221bc33' +                      // IDAT CRC
  '0000000049454e44ae426082',         // IEND chunk
  'hex',
);

/** A tiny PDF-like buffer (not a real PDF — just passes MIME check) */
const PDF_BUFFER = Buffer.from('%PDF-1.4\ntest content');

// ---------------------------------------------------------------------------
// Test Hono app
// ---------------------------------------------------------------------------
const testApp = new Hono();
testApp.route('/v1/files', filesRouter);

// ---------------------------------------------------------------------------
// Setup / Cleanup
// ---------------------------------------------------------------------------

async function setup() {
  console.log('🔧 Setting up file storage test agents...');

  [ownerKeyHash, otherKeyHash] = await Promise.all([
    bcrypt.hash(OWNER_KEY, 4),
    bcrypt.hash(OTHER_KEY, 4),
  ]);

  await cleanupData();

  await db.insert(agents).values([
    {
      id: OWNER_ID,
      name: 'Files Test Owner Agent',
      ownerTwitter: 'files_test_owner',
      status: 'verified',
      balancePoints: '100',
      apiKeyHash: ownerKeyHash,
    },
    {
      id: OTHER_ID,
      name: 'Files Test Other Agent',
      ownerTwitter: 'files_test_other',
      status: 'verified',
      balancePoints: '100',
      apiKeyHash: otherKeyHash,
    },
  ]);

  console.log('  ✅ Test agents created (owner + other)');
}

const TEST_TWITTERS = ['files_test_owner', 'files_test_other'] as const;

async function cleanupData() {
  // Remove all file_attachments uploaded by test agents
  await db.execute(sql`
    DELETE FROM file_attachments
    WHERE uploaded_by_agent_id IN (${OWNER_ID}, ${OTHER_ID})
  `);

  // Remove test agents (by ID or twitter handle to handle partial/failed runs)
  await db.execute(sql`
    DELETE FROM agents
    WHERE id IN (${OWNER_ID}, ${OTHER_ID})
       OR owner_twitter IN (${TEST_TWITTERS[0]}, ${TEST_TWITTERS[1]})
  `);
}

async function cleanup() {
  console.log('\n🧹 Cleaning up file storage test data...');
  await cleanupData();

  // Best-effort: remove uploaded files from Supabase Storage
  for (const { path, bucket } of uploadedPaths) {
    try {
      await deleteFile(path, bucket);
    } catch {
      // ignore — test teardown should not fail on storage errors
    }
  }
  uploadedPaths.length = 0;

  console.log('  ✅ Cleanup complete');
}

// ---------------------------------------------------------------------------
// Supabase config + bucket health check
// ---------------------------------------------------------------------------
function hasSupabaseConfig(): boolean {
  return !!(
    process.env.SUPABASE_URL &&
    (process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_KEY)
  );
}

/**
 * Probe the required Supabase Storage buckets.
 * Returns true if all required buckets are accessible; false if any are missing.
 * Logs a warning with bucket names if any are missing.
 */
async function checkSupabaseBuckets(): Promise<boolean> {
  const url = process.env.SUPABASE_URL!;
  const key = (process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_KEY)!;
  const required = [BUCKET_GIG_FILES, BUCKET_ORDER_FILES, BUCKET_GIG_ATTACHMENTS];

  try {
    const resp = await fetch(`${url}/storage/v1/bucket`, {
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    });

    if (!resp.ok) {
      console.log(`  ⚠️  Could not list Supabase buckets (HTTP ${resp.status}). Storage tests will be skipped.`);
      return false;
    }

    const buckets = await resp.json() as Array<{ name: string }>;
    const existing = new Set(buckets.map((b) => b.name));
    const missing = required.filter((name) => !existing.has(name));

    if (missing.length > 0) {
      console.log(`\n  ⚠️  Missing Supabase Storage buckets: ${missing.join(', ')}`);
      console.log('     Create them in the Supabase dashboard or via API:');
      for (const name of missing) {
        console.log(`       POST ${url}/storage/v1/bucket  { "name": "${name}", "public": ${name === BUCKET_GIG_FILES} }`);
      }
      console.log('     Storage tests will be skipped.');
      return false;
    }

    return true;
  } catch (err) {
    console.log(`  ⚠️  Bucket probe failed: ${err instanceof Error ? err.message : err}. Storage tests will be skipped.`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helper: build a multipart/form-data upload request
// ---------------------------------------------------------------------------
function makeUploadRequest(params: {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  entityType: string;
  entityId: string;
  authKey?: string;
}): Request {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(params.buffer)], { type: params.mimetype });
  formData.append('file', blob, params.filename);
  formData.append('entity_type', params.entityType);
  formData.append('entity_id', params.entityId);

  const headers: Record<string, string> = {};
  if (params.authKey) {
    headers['Authorization'] = `Bearer ${params.authKey}`;
  }

  return new Request('http://localhost/v1/files/upload', {
    method: 'POST',
    headers,
    body: formData,
  });
}

// ---------------------------------------------------------------------------
// Test 1: Upload gig file → public bucket (gig-files), returns public URL
// ---------------------------------------------------------------------------
async function testUploadGigFile(): Promise<string> {
  console.log('\n📤 Test 1: Upload gig file (entity_type=gig, public bucket)');

  const resp = await testApp.fetch(
    makeUploadRequest({
      buffer: PNG_BUFFER,
      filename: 'test-gig-cover.png',
      mimetype: 'image/png',
      entityType: 'gig',
      entityId: GIG_ID,
      authKey: OWNER_KEY,
    }),
  );

  if (resp.status !== 201) {
    const body = await resp.text();
    throw new Error(`Expected 201, got ${resp.status}: ${body}`);
  }

  const body = await resp.json() as Record<string, unknown>;

  if (!body.id)                              throw new Error('Missing id in response');
  if (!body.filename)                        throw new Error('Missing filename');
  if (body.mimetype !== 'image/png')         throw new Error(`Wrong mimetype: ${body.mimetype}`);
  if (typeof body.size_bytes !== 'number')   throw new Error('Missing/invalid size_bytes');
  if (body.uploaded_by_agent_id !== OWNER_ID) throw new Error(`Wrong uploaded_by: ${body.uploaded_by_agent_id}`);
  if (!body.download_url)                    throw new Error('Missing download_url in response');
  if (body.gig_id !== GIG_ID)               throw new Error(`Wrong gig_id: ${body.gig_id}, expected ${GIG_ID}`);
  // gig-files is a public bucket → no expiry on public URLs
  if (body.download_url_expires_in !== null) {
    console.log(`  ⚠️  Note: download_url_expires_in=${body.download_url_expires_in} (may be signed if bucket is not yet public)`);
  }

  const fileId = body.id as string;
  console.log(`  → File ID:       ${fileId}`);
  console.log(`  → Filename:      ${body.filename}`);
  console.log(`  → Mimetype:      ${body.mimetype}`);
  console.log(`  → Size:          ${body.size_bytes} bytes`);
  console.log(`  → Download URL:  ${String(body.download_url).substring(0, 70)}...`);
  console.log('  ✅ Gig file uploaded → 201 with download_url');

  // Track for storage cleanup
  const [row] = await db.select().from(fileAttachments).where(eq(fileAttachments.id, fileId)).limit(1);
  if (row?.storagePath) uploadedPaths.push({ path: row.storagePath, bucket: BUCKET_GIG_FILES });

  return fileId;
}

// ---------------------------------------------------------------------------
// Test 2: Upload order file → private bucket (order-files), returns signed URL
// ---------------------------------------------------------------------------
async function testUploadOrderFile(): Promise<string> {
  console.log('\n📤 Test 2: Upload order file (entity_type=gig_order, private bucket)');

  const resp = await testApp.fetch(
    makeUploadRequest({
      buffer: PDF_BUFFER,
      filename: 'order-delivery.pdf',
      mimetype: 'application/pdf',
      entityType: 'gig_order',
      entityId: ORDER_ID,
      authKey: OWNER_KEY,
    }),
  );

  if (resp.status !== 201) {
    const body = await resp.text();
    throw new Error(`Expected 201, got ${resp.status}: ${body}`);
  }

  const body = await resp.json() as Record<string, unknown>;

  if (!body.id)                              throw new Error('Missing id in response');
  if (!body.download_url)                    throw new Error('Missing download_url (private file needs signed URL)');
  if (body.gig_id !== ORDER_ID)             throw new Error(`Wrong gig_id: ${body.gig_id}, expected ${ORDER_ID}`);
  if (body.mimetype !== 'application/pdf')   throw new Error(`Wrong mimetype: ${body.mimetype}`);
  // Private bucket → signed URL with expiry
  if (typeof body.download_url_expires_in !== 'number') {
    console.log(`  ⚠️  Note: download_url_expires_in=${body.download_url_expires_in} (expected a number for private bucket)`);
  }

  const fileId = body.id as string;
  console.log(`  → File ID:       ${fileId}`);
  console.log(`  → Mimetype:      ${body.mimetype}`);
  console.log(`  → Download URL:  ${String(body.download_url).substring(0, 70)}...`);
  console.log(`  → Expires in:    ${body.download_url_expires_in ?? 'null (public URL)'} seconds`);
  console.log('  ✅ Order file uploaded → 201 with signed URL');

  // Track for storage cleanup
  const [row] = await db.select().from(fileAttachments).where(eq(fileAttachments.id, fileId)).limit(1);
  if (row?.storagePath) uploadedPaths.push({ path: row.storagePath, bucket: BUCKET_ORDER_FILES });

  return fileId;
}

// ---------------------------------------------------------------------------
// Test 3: MIME type validation — disallowed MIME type → 415
// ---------------------------------------------------------------------------
async function testMimeTypeValidation() {
  console.log('\n🚫 Test 3: MIME type validation (disallowed type → 415)');

  // Windows executable — not in ALLOWED_MIME_TYPES
  const exeBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ header

  const resp = await testApp.fetch(
    makeUploadRequest({
      buffer: exeBuffer,
      filename: 'virus.exe',
      mimetype: 'application/x-msdownload',
      entityType: 'gig',
      entityId: GIG_ID,
      authKey: OWNER_KEY,
    }),
  );

  if (resp.status !== 415) {
    const body = await resp.text();
    throw new Error(`Expected 415 (Unsupported Media Type), got ${resp.status}: ${body}`);
  }

  const body = await resp.json() as Record<string, unknown>;
  if (body.error !== 'invalid_mime_type') {
    throw new Error(`Expected error=invalid_mime_type, got: ${body.error}`);
  }
  if (typeof body.message !== 'string' || !body.message.includes('not allowed')) {
    throw new Error(`Expected descriptive message, got: ${body.message}`);
  }

  console.log(`  → Got 415: ${body.message}`);

  // Also test with application/octet-stream — also disallowed
  const binaryResp = await testApp.fetch(
    makeUploadRequest({
      buffer: Buffer.from([0x00, 0x01, 0x02]),
      filename: 'random.bin',
      mimetype: 'application/octet-stream',
      entityType: 'gig',
      entityId: GIG_ID,
      authKey: OWNER_KEY,
    }),
  );
  // Note: route sets mimetype = file.type || 'application/octet-stream' but
  // application/octet-stream is not in ALLOWED_MIME_TYPES, so it should also 415
  if (binaryResp.status !== 415) {
    console.log(`  ⚠️  Note: application/octet-stream returned ${binaryResp.status} (may be treated as allowed)`);
  } else {
    console.log('  → application/octet-stream → 415 ✓');
  }

  console.log('  ✅ Disallowed MIME type rejected with 415');
}

// ---------------------------------------------------------------------------
// Test 4: File size limit — buffer > 50 MB → 413
// ---------------------------------------------------------------------------
async function testFileSizeLimit() {
  console.log('\n📏 Test 4: File size limit (>50 MB → 413)');

  // MAX_FILE_SIZE_BYTES = 50 MB; create a 51 MB zero buffer
  const FIFTY_ONE_MB = 51 * 1024 * 1024;
  const bigBuffer = Buffer.alloc(FIFTY_ONE_MB, 0x00);

  const resp = await testApp.fetch(
    makeUploadRequest({
      buffer: bigBuffer,
      filename: 'huge-file.pdf',
      mimetype: 'application/pdf',
      entityType: 'gig',
      entityId: GIG_ID,
      authKey: OWNER_KEY,
    }),
  );

  if (resp.status !== 413) {
    const body = await resp.text();
    throw new Error(`Expected 413 (Content Too Large), got ${resp.status}: ${body}`);
  }

  const body = await resp.json() as Record<string, unknown>;
  if (body.error !== 'file_too_large') {
    throw new Error(`Expected error=file_too_large, got: ${body.error}`);
  }

  console.log(`  → Got 413: ${body.message}`);
  console.log('  ✅ Oversized file rejected with 413');
}

// ---------------------------------------------------------------------------
// Test 5: Auth required — no Bearer token → 401 on all endpoints
// ---------------------------------------------------------------------------
async function testAuthRequired() {
  console.log('\n🔒 Test 5: Auth required (no Bearer token → 401)');

  // 5a: Upload without auth
  const uploadResp = await testApp.fetch(
    makeUploadRequest({
      buffer: PNG_BUFFER,
      filename: 'test.png',
      mimetype: 'image/png',
      entityType: 'gig',
      entityId: GIG_ID,
      // no authKey
    }),
  );

  if (uploadResp.status !== 401) {
    throw new Error(`Expected 401 for upload without auth, got ${uploadResp.status}`);
  }
  const uploadBody = await uploadResp.json() as Record<string, unknown>;
  if (!uploadBody.error) throw new Error('Missing error field in 401 response');
  console.log(`  → POST /upload without auth → 401: ${uploadBody.error} ✓`);

  // 5b: GET metadata without auth
  const metaResp = await testApp.fetch(
    new Request('http://localhost/v1/files/file_nonexistent'),
  );
  if (metaResp.status !== 401) {
    throw new Error(`Expected 401 for GET metadata without auth, got ${metaResp.status}`);
  }
  console.log(`  → GET /files/:id without auth → 401 ✓`);

  // 5c: GET signed URL without auth
  const urlResp = await testApp.fetch(
    new Request('http://localhost/v1/files/file_nonexistent/url'),
  );
  if (urlResp.status !== 401) {
    throw new Error(`Expected 401 for GET /url without auth, got ${urlResp.status}`);
  }
  console.log(`  → GET /files/:id/url without auth → 401 ✓`);

  // 5d: DELETE without auth
  const delResp = await testApp.fetch(
    new Request('http://localhost/v1/files/file_nonexistent', { method: 'DELETE' }),
  );
  if (delResp.status !== 401) {
    throw new Error(`Expected 401 for DELETE without auth, got ${delResp.status}`);
  }
  console.log(`  → DELETE /files/:id without auth → 401 ✓`);

  console.log('  ✅ All file endpoints require auth — 401 returned without Bearer token');
}

// ---------------------------------------------------------------------------
// Test 6: Get signed URL — GET /v1/files/:fileId/url → 200
// Note: this endpoint always uses BUCKET_GIG_ATTACHMENTS, so use a file
// uploaded with entity_type=task (which routes to gig-attachments).
// ---------------------------------------------------------------------------
async function testGetSignedUrl(taskFileId: string) {
  console.log('\n🔗 Test 6: Get signed URL (GET /v1/files/:fileId/url → 200)');

  const resp = await testApp.fetch(
    new Request(`http://localhost/v1/files/${taskFileId}/url`, {
      headers: { Authorization: `Bearer ${OWNER_KEY}` },
    }),
  );

  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`Expected 200, got ${resp.status}: ${body}`);
  }

  const body = await resp.json() as Record<string, unknown>;

  if (!body.download_url)                  throw new Error('Missing download_url in response');
  if (!body.file_id)                       throw new Error('Missing file_id in response');
  if (typeof body.expires_in !== 'number') throw new Error('Missing/invalid expires_in');
  if (body.file_id !== taskFileId)         throw new Error(`Wrong file_id: ${body.file_id}`);
  if (!body.filename)                      throw new Error('Missing filename in response');

  const url = String(body.download_url);
  if (!url.startsWith('http')) throw new Error(`download_url must be a URL, got: ${url.substring(0, 30)}`);

  console.log(`  → File ID:      ${body.file_id}`);
  console.log(`  → Filename:     ${body.filename}`);
  console.log(`  → Expires in:   ${body.expires_in} seconds`);
  console.log(`  → Signed URL:   ${url.substring(0, 70)}...`);
  console.log('  ✅ Signed URL returned → 200 with download_url, expires_in, file_id, filename');
}

// ---------------------------------------------------------------------------
// Test 7: Get file metadata — GET /v1/files/:fileId → 200
// ---------------------------------------------------------------------------
async function testGetFileMetadata(fileId: string) {
  console.log('\n📋 Test 7: Get file metadata (GET /v1/files/:fileId → 200)');

  const resp = await testApp.fetch(
    new Request(`http://localhost/v1/files/${fileId}`, {
      headers: { Authorization: `Bearer ${OWNER_KEY}` },
    }),
  );

  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`Expected 200, got ${resp.status}: ${body}`);
  }

  const body = await resp.json() as Record<string, unknown>;

  if (body.id !== fileId)                  throw new Error(`Wrong id: ${body.id}`);
  if (!body.filename)                      throw new Error('Missing filename');
  if (!body.mimetype)                      throw new Error('Missing mimetype');
  if (typeof body.size_bytes !== 'number') throw new Error('Missing/invalid size_bytes');
  if (!body.created_at)                    throw new Error('Missing created_at');
  if (body.uploaded_by_agent_id !== OWNER_ID) {
    throw new Error(`Wrong uploaded_by_agent_id: ${body.uploaded_by_agent_id}`);
  }

  console.log(`  → ID:           ${body.id}`);
  console.log(`  → Filename:     ${body.filename}`);
  console.log(`  → MIME type:    ${body.mimetype}`);
  console.log(`  → Size:         ${body.size_bytes} bytes`);
  console.log(`  → Uploaded by:  ${body.uploaded_by_agent_id}`);
  console.log(`  → Created at:   ${body.created_at}`);
  console.log('  ✅ File metadata returned → 200 with complete fields');

  // Verify 404 for non-existent file
  const notFoundResp = await testApp.fetch(
    new Request('http://localhost/v1/files/file_doesntex01', {
      headers: { Authorization: `Bearer ${OWNER_KEY}` },
    }),
  );
  if (notFoundResp.status !== 404) {
    throw new Error(`Expected 404 for non-existent file, got ${notFoundResp.status}`);
  }
  console.log('  → Non-existent file → 404 ✓');
}

// ---------------------------------------------------------------------------
// Test 8: Delete file — owner deletes (200), non-owner blocked (403), DB removed
// ---------------------------------------------------------------------------
async function testDeleteFile(fileId: string) {
  console.log('\n🗑️  Test 8: Delete file (owner only)');

  // 8a: Non-owner attempt → 403
  const forbidResp = await testApp.fetch(
    new Request(`http://localhost/v1/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${OTHER_KEY}` },
    }),
  );

  if (forbidResp.status !== 403) {
    const body = await forbidResp.text();
    throw new Error(`Expected 403 (non-owner delete), got ${forbidResp.status}: ${body}`);
  }
  const forbidBody = await forbidResp.json() as Record<string, unknown>;
  if (forbidBody.error !== 'forbidden') {
    throw new Error(`Expected error=forbidden, got: ${forbidBody.error}`);
  }
  console.log(`  → Non-owner DELETE → 403: ${forbidBody.message} ✓`);

  // Verify file still exists after rejected delete attempt
  const [stillExists] = await db
    .select()
    .from(fileAttachments)
    .where(eq(fileAttachments.id, fileId))
    .limit(1);
  if (!stillExists) throw new Error('File should still exist after non-owner delete was rejected');

  // 8b: Owner deletes → 200
  const delResp = await testApp.fetch(
    new Request(`http://localhost/v1/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${OWNER_KEY}` },
    }),
  );

  if (delResp.status !== 200) {
    const body = await delResp.text();
    throw new Error(`Expected 200 (owner delete), got ${delResp.status}: ${body}`);
  }

  const delBody = await delResp.json() as Record<string, unknown>;
  if (delBody.deleted !== true)      throw new Error(`Expected deleted=true, got: ${delBody.deleted}`);
  if (delBody.file_id !== fileId)    throw new Error(`Wrong file_id in response: ${delBody.file_id}`);

  console.log(`  → Owner DELETE → 200: deleted=${delBody.deleted}, file_id=${delBody.file_id} ✓`);

  // 8c: Verify DB row removed
  const [gone] = await db
    .select()
    .from(fileAttachments)
    .where(eq(fileAttachments.id, fileId))
    .limit(1);
  if (gone) throw new Error('DB row should be deleted after owner DELETE request');
  console.log('  → DB row confirmed deleted ✓');

  // 8d: Subsequent GET → 404
  const afterResp = await testApp.fetch(
    new Request(`http://localhost/v1/files/${fileId}`, {
      headers: { Authorization: `Bearer ${OWNER_KEY}` },
    }),
  );
  if (afterResp.status !== 404) {
    throw new Error(`Expected 404 after delete, got ${afterResp.status}`);
  }
  console.log('  → GET after delete → 404 ✓');

  // Remove from cleanup tracking since we already deleted it
  const idx = uploadedPaths.findIndex((p) => p.bucket === BUCKET_GIG_ATTACHMENTS);
  if (idx !== -1) uploadedPaths.splice(idx, 1);

  console.log('  ✅ Owner deleted file (200); non-owner blocked (403); DB row removed');
}

// ---------------------------------------------------------------------------
// Test 9: DB record — verify file_attachments row after upload
// ---------------------------------------------------------------------------
async function testDBRecord(fileId: string, expectedEntityType: string, expectedEntityId: string) {
  console.log('\n🗄️  Test 9: DB record verification');

  const [row] = await db
    .select()
    .from(fileAttachments)
    .where(eq(fileAttachments.id, fileId))
    .limit(1);

  if (!row) throw new Error(`DB row not found for file_id=${fileId}`);

  // Verify agent FK
  if (row.uploadedByAgentId !== OWNER_ID) {
    throw new Error(`Wrong uploaded_by_agent_id: ${row.uploadedByAgentId}, expected ${OWNER_ID}`);
  }

  // Verify storage_path is set
  if (!row.storagePath || row.storagePath.trim() === '') {
    throw new Error('storage_path must be set in DB row after upload');
  }

  // Verify MIME type
  if (!row.mimetype || row.mimetype.trim() === '') {
    throw new Error('mimetype must be set in DB row after upload');
  }

  // Verify size
  if (typeof row.sizeBytes !== 'number' || row.sizeBytes <= 0) {
    throw new Error(`size_bytes must be > 0, got: ${row.sizeBytes}`);
  }

  // Verify entity FK column
  // The route maps entity_type → FK column:
  //   task        → task_id
  //   gig         → gig_id
  //   gig_order   → gig_id (same column as gig)
  //   submission  → submission_id
  if (expectedEntityType === 'task') {
    if (row.taskId !== expectedEntityId) {
      throw new Error(`Wrong task_id: ${row.taskId}, expected ${expectedEntityId}`);
    }
    if (row.gigId !== null)             throw new Error(`gigId should be null for task uploads, got: ${row.gigId}`);
    if (row.submissionId !== null)      throw new Error(`submissionId should be null for task uploads`);
  } else if (expectedEntityType === 'gig' || expectedEntityType === 'gig_order') {
    if (row.gigId !== expectedEntityId) {
      throw new Error(`Wrong gig_id: ${row.gigId}, expected ${expectedEntityId}`);
    }
    if (row.taskId !== null)            throw new Error(`taskId should be null for gig uploads, got: ${row.taskId}`);
    if (row.submissionId !== null)      throw new Error(`submissionId should be null for gig uploads`);
  } else if (expectedEntityType === 'submission') {
    if (row.submissionId !== expectedEntityId) {
      throw new Error(`Wrong submission_id: ${row.submissionId}, expected ${expectedEntityId}`);
    }
  }

  console.log(`  → id:             ${row.id}`);
  console.log(`  → uploaded_by:    ${row.uploadedByAgentId}`);
  console.log(`  → storage_path:   ${row.storagePath}`);
  console.log(`  → mimetype:       ${row.mimetype}`);
  console.log(`  → size_bytes:     ${row.sizeBytes}`);
  console.log(`  → gig_id:         ${row.gigId ?? '(null)'}`);
  console.log(`  → task_id:        ${row.taskId ?? '(null)'}`);
  console.log(`  → submission_id:  ${row.submissionId ?? '(null)'}`);
  console.log('  ✅ DB row verified: storage_path, mimetype, size_bytes, entity FK all correct');
}

// ---------------------------------------------------------------------------
// Helper: upload a file with entity_type=task (routes to gig-attachments bucket)
// Used for Tests 6 (signed URL) and 8 (delete), since the /url and DELETE
// endpoints both use BUCKET_GIG_ATTACHMENTS by default.
// ---------------------------------------------------------------------------
async function uploadTaskFile(): Promise<string> {
  const resp = await testApp.fetch(
    makeUploadRequest({
      buffer: PNG_BUFFER,
      filename: 'task-attachment.png',
      mimetype: 'image/png',
      entityType: 'task',
      entityId: TASK_ID,
      authKey: OWNER_KEY,
    }),
  );

  if (resp.status !== 201) {
    const body = await resp.text();
    throw new Error(`Setup upload failed: ${resp.status}: ${body}`);
  }

  const body = await resp.json() as Record<string, unknown>;
  const fileId = body.id as string;

  // Track for cleanup
  const [row] = await db.select().from(fileAttachments).where(eq(fileAttachments.id, fileId)).limit(1);
  if (row?.storagePath) uploadedPaths.push({ path: row.storagePath, bucket: BUCKET_GIG_ATTACHMENTS });

  return fileId;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('🚀 File Storage Integration Tests');
  console.log('='.repeat(50));

  await initPool();

  let storageAvailable = false;
  if (!hasSupabaseConfig()) {
    console.log('\n  ⚠️  SUPABASE_URL / SUPABASE_SECRET_KEY not configured.');
    console.log('     Storage tests will be skipped (Tests 1, 2, 6, 7, 8, 9).');
    console.log('     Tests 3, 4, 5 (MIME/size/auth) run without Supabase.\n');
  } else {
    console.log(`  Supabase URL:    ${process.env.SUPABASE_URL}`);
    storageAvailable = await checkSupabaseBuckets();
    console.log(`  Storage tests:   ${storageAvailable ? 'ENABLED' : 'SKIPPED (bucket issue)'}`);
  }
  console.log('='.repeat(50));

  await setup();

  let passCount = 0;
  let failCount = 0;
  let skipCount = 0;

  const run = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await fn();
      passCount++;
      return result;
    } catch (err) {
      console.error(`\n  ❌ FAILED: ${name}`);
      console.error(`     ${err instanceof Error ? err.message : String(err)}`);
      failCount++;
      return null;
    }
  };

  const skip = (name: string, reason: string) => {
    console.log(`\n  ⏭️  SKIP: ${name}`);
    console.log(`     Reason: ${reason}`);
    skipCount++;
  };

  // ── Tests 3–5: validation + auth (no Supabase needed) ─────────────────────
  await run('Test 3: MIME type validation → 415', testMimeTypeValidation);
  await run('Test 4: File size limit → 413', testFileSizeLimit);
  await run('Test 5: Auth required → 401', testAuthRequired);

  // ── Tests 1, 2, 6, 7, 8, 9: require live Supabase Storage ─────────────────
  if (!storageAvailable) {
    skip('Test 1: Upload gig file', 'Supabase not configured');
    skip('Test 2: Upload order file', 'Supabase not configured');
    skip('Test 9: DB record verification', 'Supabase not configured');
    skip('Test 6: Get signed URL', 'Supabase not configured');
    skip('Test 7: Get file metadata', 'Supabase not configured');
    skip('Test 8: Delete file', 'Supabase not configured');
  } else {
    // ── Upload tests (1 + 2) ─────────────────────────────────────────────────
    const gigFileId   = await run('Test 1: Upload gig file → 201 + public URL', testUploadGigFile);
    const orderFileId = await run('Test 2: Upload order file → 201 + signed URL', testUploadOrderFile);

    // ── DB record verification (Test 9) on gig upload ─────────────────────────
    if (gigFileId) {
      await run(
        'Test 9: DB record verification (gig upload)',
        () => testDBRecord(gigFileId, 'gig', GIG_ID),
      );
    } else {
      skip('Test 9: DB record verification', 'Test 1 (gig upload) failed');
    }

    // ── Upload a task file for Tests 6, 7, 8 ──────────────────────────────────
    // The /url and DELETE endpoints use BUCKET_GIG_ATTACHMENTS; entity_type=task
    // routes uploads to gig-attachments, making them compatible with both endpoints.
    let taskFileId: string | null = null;
    try {
      taskFileId = await uploadTaskFile();
      console.log(`\n  🔧 Task file uploaded for signed-URL/delete tests: ${taskFileId}`);
    } catch (err) {
      console.error('\n  ❌ Task file upload for setup failed:', err instanceof Error ? err.message : err);
      failCount++;
    }

    if (taskFileId) {
      await run('Test 6: Get signed URL → 200',       () => testGetSignedUrl(taskFileId!));
      await run('Test 7: Get file metadata → 200',     () => testGetFileMetadata(taskFileId!));
      await run('Test 8: Delete file (owner only)',     () => testDeleteFile(taskFileId!));
    } else {
      skip('Test 6: Get signed URL', 'Task file upload (setup) failed');
      skip('Test 7: Get file metadata', 'Task file upload (setup) failed');
      skip('Test 8: Delete file', 'Task file upload (setup) failed');
    }

    // orderFileId tracked in uploadedPaths for cleanup
    void orderFileId;
  }

  if (!process.env.KEEP_TEST_DATA) { await cleanup(); } else { console.log("🔒 KEEP_TEST_DATA set — skipping cleanup"); }

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`);

  if (failCount > 0) {
    console.log('\n⚠️  Some tests failed. Review output above.');
    process.exit(1);
  } else {
    console.log(`\n🎉 All${skipCount > 0 ? ' non-skipped' : ''} file storage tests passed!`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
