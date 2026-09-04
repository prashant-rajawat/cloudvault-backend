-- CloudVault Schema Migration
-- Migration: 20260829000000_update_storage_quota_default_15gb.sql
-- Description: Updates the default user storage quota to 15 GB (16,106,127,360 bytes)

DO $$
BEGIN
    -- 1. Ensure storage_quota_bytes column exists on profiles table with 15GB default
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'profiles' 
          AND column_name = 'storage_quota_bytes'
    ) THEN
        ALTER TABLE public.profiles 
        ALTER COLUMN storage_quota_bytes SET DEFAULT 16106127360;

        -- Update existing users who have the old 5GB default (5368709120) or NULL
        UPDATE public.profiles
        SET storage_quota_bytes = 16106127360
        WHERE storage_quota_bytes IS NULL OR storage_quota_bytes = 5368709120;
    ELSIF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'profiles' 
          AND column_name = 'storage_quota'
    ) THEN
        ALTER TABLE public.profiles 
        ALTER COLUMN storage_quota SET DEFAULT 16106127360;

        UPDATE public.profiles
        SET storage_quota = 16106127360
        WHERE storage_quota IS NULL OR storage_quota = 5368709120;
    END IF;

    -- 2. Update default_user_quota_bytes in system_settings if the table exists
    IF EXISTS (
        SELECT 1 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name = 'system_settings'
    ) THEN
        INSERT INTO public.system_settings (key, value, updated_at)
        VALUES ('default_user_quota_bytes', 16106127360, NOW())
        ON CONFLICT (key) 
        DO UPDATE SET value = 16106127360, updated_at = NOW()
        WHERE public.system_settings.value = 5368709120 OR public.system_settings.value IS NULL;
    END IF;
END $$;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
