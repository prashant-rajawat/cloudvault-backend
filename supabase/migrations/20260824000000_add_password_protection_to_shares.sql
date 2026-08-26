-- CloudVault Schema Migration
-- Migration: 20260824000000_add_password_protection_to_shares.sql
-- Description: Adds password_enabled and password_hash columns to public.shares table

DO $$
BEGIN
    -- 1. Add password_enabled column if not exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'shares' 
          AND column_name = 'password_enabled'
    ) THEN
        ALTER TABLE public.shares 
        ADD COLUMN password_enabled BOOLEAN NOT NULL DEFAULT false;
    END IF;

    -- 2. Add password_hash column if not exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'shares' 
          AND column_name = 'password_hash'
    ) THEN
        ALTER TABLE public.shares 
        ADD COLUMN password_hash TEXT NULL;
    END IF;
END $$;

-- Comments
COMMENT ON COLUMN public.shares.password_enabled IS 'Flag indicating whether a password is required to access this share';
COMMENT ON COLUMN public.shares.password_hash IS 'Bcrypt password hash for password-protected shares';

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
