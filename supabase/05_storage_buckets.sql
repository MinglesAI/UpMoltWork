-- ============================================================
-- Supabase Storage: bucket provisioning for UpMoltWork
--
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor)
-- after completing schema migrations 01–04.
--
-- Buckets created:
--   gig-files             — attachments on gig listings (PUBLIC)
--   order-files           — delivery files uploaded by sellers (PRIVATE — signed URLs)
--   gig-attachments       — general entity attachments via /v1/files API (PRIVATE)
--   order-message-files   — per-message file attachments in order chat (PRIVATE)
-- ============================================================

-- ── gig-files (public) ──────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'gig-files',
  'gig-files',
  true,
  5242880,   -- 5 MB
  ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── order-files (private) ────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'order-files',
  'order-files',
  false,
  52428800,  -- 50 MB
  ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'application/zip', 'application/x-zip-compressed',
    'text/plain', 'text/html', 'text/csv',
    'application/json',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── gig-attachments (private) ────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'gig-attachments',
  'gig-attachments',
  false,
  52428800,  -- 50 MB
  ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'application/zip', 'application/x-zip-compressed',
    'text/plain', 'text/html', 'text/csv',
    'application/json',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── order-message-files (private) ────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'order-message-files',
  'order-message-files',
  false,
  52428800,  -- 50 MB
  ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'application/zip', 'application/x-zip-compressed',
    'text/plain', 'text/html', 'text/csv',
    'application/json',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- RLS Policies
-- The service role key (SUPABASE_SECRET_KEY) used by the API
-- bypasses RLS by default. The policies below cover additional
-- access patterns (e.g. authenticated users reading public files).
-- ============================================================

-- gig-files: public read (bucket is public, but explicit policy is good practice)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'gig-files public read'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "gig-files public read"
        ON storage.objects FOR SELECT
        TO public
        USING (bucket_id = 'gig-files');
    $policy$;
  END IF;
END$$;

-- order-files: only the service role may insert/delete (API enforces order ownership)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'order-files service insert'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "order-files service insert"
        ON storage.objects FOR INSERT
        TO service_role
        WITH CHECK (bucket_id = 'order-files');
    $policy$;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'order-files service delete'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "order-files service delete"
        ON storage.objects FOR DELETE
        TO service_role
        USING (bucket_id = 'order-files');
    $policy$;
  END IF;
END$$;

-- gig-attachments: service role full access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'gig-attachments service insert'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "gig-attachments service insert"
        ON storage.objects FOR INSERT
        TO service_role
        WITH CHECK (bucket_id = 'gig-attachments');
    $policy$;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'gig-attachments service delete'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "gig-attachments service delete"
        ON storage.objects FOR DELETE
        TO service_role
        USING (bucket_id = 'gig-attachments');
    $policy$;
  END IF;
END$$;

-- order-message-files: service role full access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'order-message-files service insert'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "order-message-files service insert"
        ON storage.objects FOR INSERT
        TO service_role
        WITH CHECK (bucket_id = 'order-message-files');
    $policy$;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'order-message-files service delete'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "order-message-files service delete"
        ON storage.objects FOR DELETE
        TO service_role
        USING (bucket_id = 'order-message-files');
    $policy$;
  END IF;
END$$;
