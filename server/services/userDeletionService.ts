import { getSupabaseAdminClient } from "../config/supabase.js";
import { deleteShareProtection } from "./shareProtectionService.js";

/**
 * Recursively scans Supabase Storage bucket `cloudvault-files` under prefix
 * to gather all storage file paths for a user.
 */
async function getStoragePathsForPrefix(supabase: any, prefix: string): Promise<string[]> {
  const paths: string[] = [];
  try {
    const { data: items, error } = await supabase.storage.from("cloudvault-files").list(prefix, { limit: 1000 });
    if (error || !items) return paths;

    for (const item of items) {
      const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id) {
        // It is a file object
        paths.push(fullPath);
      } else {
        // It is a subfolder/directory (e.g., avatars, root)
        const subPaths = await getStoragePathsForPrefix(supabase, fullPath);
        paths.push(...subPaths);
      }
    }
  } catch (err) {
    console.warn(`[UserDeletion] Error listing storage path ${prefix}:`, err);
  }
  return paths;
}

/**
 * Completely and securely deletes a user account and all owned data from CloudVault:
 * 1. Storage files in `cloudvault-files` (user files, root files, nested subfolder files, avatar photos).
 * 2. In-memory and persisted share tokens & password protection.
 * 3. Database records (shares owned or received, notifications, activity logs, starred items, files, folders, profiles).
 * 4. Supabase Auth user record and active session tokens.
 */
export async function deleteUserAccountAndData(userId: string, userEmail?: string): Promise<{ success: boolean; message: string }> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    throw new Error("Backend Supabase client unavailable.");
  }

  // 1. Gather storage paths to delete
  const storagePaths = new Set<string>();

  // A. Get files owned by user from `files` DB table
  const { data: dbFiles } = await supabase
    .from("files")
    .select("storage_path")
    .eq("owner_id", userId);

  if (dbFiles && dbFiles.length > 0) {
    for (const f of dbFiles) {
      if (f.storage_path) storagePaths.add(f.storage_path);
    }
  }

  // B. Gather recursively all objects stored under user directory in bucket `cloudvault-files`
  const userDirectoryPaths = await getStoragePathsForPrefix(supabase, userId);
  for (const p of userDirectoryPaths) {
    storagePaths.add(p);
  }

  // C. Execute bulk removal from Supabase Storage
  const allPathsArray = Array.from(storagePaths);
  if (allPathsArray.length > 0) {
    // Delete in chunks of 100
    for (let i = 0; i < allPathsArray.length; i += 100) {
      const chunk = allPathsArray.slice(i, i + 100);
      const { error: storageErr } = await supabase.storage.from("cloudvault-files").remove(chunk);
      if (storageErr) {
        console.warn("[UserDeletion] Warning during storage file removal:", storageErr.message);
      }
    }
  }

  // 2. Clear share protection tokens for user's created shares
  const { data: userShares } = await supabase
    .from("shares")
    .select("id, share_token")
    .eq("owner_id", userId);

  if (userShares && userShares.length > 0) {
    for (const s of userShares) {
      if (s.share_token) {
        deleteShareProtection(s.share_token);
      }
    }
  }

  // 3. Delete database records in correct sequence to respect foreign keys & access limits
  // A. Delete shares created by user
  await supabase.from("shares").delete().eq("owner_id", userId);

  // B. Delete shares received by user
  if (userEmail) {
    try {
      await supabase.from("shares").delete().eq("granted_to_email", userEmail.trim().toLowerCase());
    } catch (e) {}
  }
  try {
    await supabase.from("shares").delete().eq("shared_with_user_id", userId);
  } catch (e) {}

  // C. Delete notifications
  await supabase.from("notifications").delete().eq("user_id", userId);

  // D. Delete activity logs
  await supabase.from("activity_logs").delete().eq("user_id", userId);

  // E. Delete starred items, user settings, reports (if tables exist)
  try { await supabase.from("starred_items").delete().eq("user_id", userId); } catch (e) {}
  try { await supabase.from("user_settings").delete().eq("user_id", userId); } catch (e) {}
  try { await supabase.from("reports").delete().or(`reporter_id.eq.${userId},user_id.eq.${userId}`); } catch (e) {}

  // F. Delete files owned by user
  await supabase.from("files").delete().eq("owner_id", userId);

  // G. Delete folders owned by user
  await supabase.from("folders").delete().eq("owner_id", userId);

  // H. Delete profile record
  await supabase.from("profiles").delete().eq("id", userId);

  // 4. Delete Supabase Auth User record via Admin API
  const { error: authDeleteErr } = await supabase.auth.admin.deleteUser(userId);
  if (authDeleteErr) {
    console.error("[UserDeletion] Failed to delete Supabase Auth record:", authDeleteErr.message);
    throw new Error(`Failed to remove authentication record: ${authDeleteErr.message}`);
  }

  return {
    success: true,
    message: "User account and all associated data permanently deleted.",
  };
}
