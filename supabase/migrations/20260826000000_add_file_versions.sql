-- Migration: Add file_versions table and version_id on files table
CREATE TABLE IF NOT EXISTS file_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  checksum TEXT NULLABLE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'files' AND column_name = 'version_id') THEN
    ALTER TABLE files ADD COLUMN version_id UUID REFERENCES file_versions(id) ON DELETE SET NULL;
  END IF;
END $$;
