import { Router, Response } from "express";
import { getSupabaseAdminClient } from "../config/supabase.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/authMiddleware.js";
import { uploadLimiter, bulkLimiter } from "../middleware/security.js";
import { DEFAULT_STORAGE_QUOTA_BYTES } from "../config/constants.js";

const router = Router();

/**
 * GET /api/files/stats
 * Returns user file counts, category breakdowns, and storage usage
 */
router.get("/stats", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;

  try {
    const { data: files, error } = await supabase
      .from("files")
      .select("id, size_bytes, category, is_trash, is_starred")
      .eq("owner_id", userId);

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    const { data: folders, error: folderErr } = await supabase
      .from("folders")
      .select("id, is_trash")
      .eq("owner_id", userId);

    if (folderErr) {
      return res.status(400).json({ success: false, message: folderErr.message });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("storage_quota_bytes")
      .eq("id", userId)
      .single();

    const activeFiles = (files || []).filter((f) => !f.is_trash);
    const trashedFiles = (files || []).filter((f) => f.is_trash);
    const activeFolders = (folders || []).filter((f) => !f.is_trash);

    const totalUsedBytes = activeFiles.reduce((acc, curr) => acc + Number(curr.size_bytes || 0), 0);
    const totalQuotaBytes = profile?.storage_quota_bytes || DEFAULT_STORAGE_QUOTA_BYTES; // 15 GB default

    const categories: Record<string, number> = {
      image: 0,
      video: 0,
      audio: 0,
      document: 0,
      archive: 0,
      other: 0,
    };

    activeFiles.forEach((file) => {
      const cat = file.category || "other";
      categories[cat] = (categories[cat] || 0) + 1;
    });

    res.json({
      success: true,
      stats: {
        totalFiles: activeFiles.length,
        totalFolders: activeFolders.length,
        trashedCount: trashedFiles.length + ((folders || []).filter((f) => f.is_trash).length),
        starredCount: activeFiles.filter((f) => f.is_starred).length,
        usedBytes: totalUsedBytes,
        quotaBytes: totalQuotaBytes,
        percentUsed: Math.min(100, Math.round((totalUsedBytes / totalQuotaBytes) * 100)),
        categories,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/files/permanent-delete
 * Permanently deletes a file from both Supabase Storage and public.files
 */
router.post("/permanent-delete", requireAuth, bulkLimiter, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  const { fileId } = req.body;

  if (!fileId) {
    return res.status(400).json({ success: false, message: "fileId is required." });
  }

  try {
    // 1. Get file record to find storage path
    const { data: file, error: fetchErr } = await supabase
      .from("files")
      .select("id, storage_path, owner_id")
      .eq("id", fileId)
      .eq("owner_id", userId)
      .single();

    if (fetchErr || !file) {
      return res.status(404).json({ success: false, message: "File not found or unauthorized." });
    }

    // 2. Remove from Storage
    if (file.storage_path) {
      await supabase.storage.from("cloudvault-files").remove([file.storage_path]);
    }

    // 3. Remove metadata from public.files
    const { error: deleteErr } = await supabase
      .from("files")
      .delete()
      .eq("id", fileId)
      .eq("owner_id", userId);

    if (deleteErr) {
      return res.status(400).json({ success: false, message: deleteErr.message });
    }

    res.json({ success: true, message: "File permanently deleted from storage and database." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/files/:id/trash
 * Moves a file to trash with authorization & activity history
 */
router.post("/:id/trash", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { id } = req.params;

  try {
    // 1. Fetch target file record
    const { data: file, error: fetchErr } = await supabase
      .from("files")
      .select("id, name, owner_id, folder_id, is_trash")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr || !file) {
      return res.status(404).json({ success: false, message: "File not found or has already been deleted." });
    }

    if (file.is_trash) {
      return res.status(400).json({ success: false, message: "File is already in Trash." });
    }

    // 2. Authorization Check (Owner or Editor)
    let hasPermission = false;
    if (file.owner_id === userId) {
      hasPermission = true;
    } else if (userId) {
      const userEmail = req.user?.email;
      const userEmailClean = userEmail ? userEmail.trim().toLowerCase() : "";

      const { data: shares } = await supabase
        .from("shares")
        .select("permission, file_id, folder_id")
        .or(`shared_with_user_id.eq.${userId}${userEmailClean ? `,granted_to_email.eq.${userEmailClean}` : ""}`);

      if (shares && shares.length > 0) {
        const isFileEditor = shares.some((s) => s.file_id === id && s.permission === "editor");
        const isFolderEditor = file.folder_id
          ? shares.some((s) => s.folder_id === file.folder_id && s.permission === "editor")
          : false;

        if (isFileEditor || isFolderEditor) {
          hasPermission = true;
        }
      }
    }

    if (!hasPermission) {
      return res.status(403).json({ success: false, message: "You don't have permission to move this file to Trash. Only owners and editors can move files to Trash." });
    }

    // 3. Mark file as trashed (soft delete)
    const { error: updateErr } = await supabase
      .from("files")
      .update({ is_trash: true, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (updateErr) throw updateErr;

    // 4. Log activity event
    if (userId) {
      try {
        await supabase.from("activity_logs").insert({
          id: crypto.randomUUID(),
          user_id: userId,
          action: "trash",
          entity_type: "file",
          entity_id: id,
          entity_name: file.name,
          metadata: {
            folder_id: file.folder_id,
          },
          created_at: new Date().toISOString(),
        });
      } catch (e) {
        // Ignore table or log errors
      }
    }

    res.json({ success: true, message: "File moved to trash." });
  } catch (err: any) {
    console.error("[TrashFileRoute] Error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to move file to trash." });
  }
});

/**
 * POST /api/files/:id/restore
 * Restores a file from trash, returning it to its original folder if valid
 */
router.post("/:id/restore", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { id } = req.params;

  try {
    // 1. Fetch target file record
    const { data: file, error: fetchErr } = await supabase
      .from("files")
      .select("id, name, owner_id, folder_id, is_trash")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr || !file) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    if (!file.is_trash) {
      return res.status(400).json({ success: false, message: "File is not in Trash." });
    }

    // 2. Authorization Check (Owner or Editor)
    let hasPermission = false;
    if (file.owner_id === userId) {
      hasPermission = true;
    } else if (userId) {
      const userEmail = req.user?.email;
      const userEmailClean = userEmail ? userEmail.trim().toLowerCase() : "";

      const { data: shares } = await supabase
        .from("shares")
        .select("permission, file_id, folder_id")
        .or(`shared_with_user_id.eq.${userId}${userEmailClean ? `,granted_to_email.eq.${userEmailClean}` : ""}`);

      if (shares && shares.length > 0) {
        const isFileEditor = shares.some((s) => s.file_id === id && s.permission === "editor");
        const isFolderEditor = file.folder_id
          ? shares.some((s) => s.folder_id === file.folder_id && s.permission === "editor")
          : false;

        if (isFileEditor || isFolderEditor) {
          hasPermission = true;
        }
      }
    }

    if (!hasPermission) {
      return res.status(403).json({ success: false, message: "You don't have permission to restore this file." });
    }

    // 3. Original folder validation (Requirement 4)
    let targetFolderId = file.folder_id;
    if (targetFolderId) {
      const { data: parentFolder } = await supabase
        .from("folders")
        .select("id, is_trash")
        .eq("id", targetFolderId)
        .maybeSingle();

      if (!parentFolder || parentFolder.is_trash) {
        // Parent folder missing or in trash -> place in root (My Drive)
        targetFolderId = null;
      }
    }

    // 4. Update file as active
    const { data: restoredFile, error: updateErr } = await supabase
      .from("files")
      .update({
        is_trash: false,
        folder_id: targetFolderId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (updateErr) throw updateErr;

    // 5. Activity log
    if (userId) {
      try {
        await supabase.from("activity_logs").insert({
          id: crypto.randomUUID(),
          user_id: userId,
          action: "restore",
          entity_type: "file",
          entity_id: id,
          entity_name: file.name,
          metadata: {
            folder_id: targetFolderId,
          },
          created_at: new Date().toISOString(),
        });
      } catch (e) {
        // Ignore
      }
    }

    res.json({ success: true, message: "File restored.", file: restoredFile });
  } catch (err: any) {
    console.error("[RestoreFileRoute] Error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to restore file." });
  }
});

/**
 * Helper to determine category from mime type
 */
function getCategoryFromMimeType(mimeType: string): string {
  if (!mimeType) return "other";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.includes("pdf") || mimeType.includes("word") || mimeType.includes("document") || mimeType.includes("text/")) return "document";
  if (mimeType.includes("zip") || mimeType.includes("rar") || mimeType.includes("tar") || mimeType.includes("gzip")) return "archive";
  return "other";
}

/**
 * POST /api/files/init
 * Initializes a file upload by creating a file record after validating storage quota
 */
router.post("/init", requireAuth, uploadLimiter, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { name, mimeType, sizeBytes, folderId } = req.body;

  if (!name) return res.status(400).json({ success: false, message: "name is required." });

  try {
    // 1. Fetch user's profile quota (default 15 GB = 16,106,127,360 bytes)
    const { data: profile } = await supabase
      .from("profiles")
      .select("storage_quota_bytes")
      .eq("id", userId)
      .single();

    const userQuotaBytes = profile?.storage_quota_bytes || DEFAULT_STORAGE_QUOTA_BYTES;

    // 2. Fetch current total used storage across all active non-trash files
    const { data: userFiles, error: filesErr } = await supabase
      .from("files")
      .select("size_bytes, is_trash")
      .eq("owner_id", userId);

    if (filesErr) throw filesErr;

    const totalUsedBytes = (userFiles || [])
      .filter((f) => !f.is_trash)
      .reduce((acc, curr) => acc + Number(curr.size_bytes || 0), 0);

    const uploadSizeBytes = Number(sizeBytes || 0);

    // 3. Enforce 15 GB quota server-side
    if (totalUsedBytes + uploadSizeBytes > userQuotaBytes) {
      return res.status(400).json({
        success: false,
        message: "Storage limit reached. You don't have enough storage space to upload this file. Please delete some files or upgrade your storage plan.",
      });
    }

    const category = getCategoryFromMimeType(mimeType);
    const extension = name.includes(".") ? name.split(".").pop() || "" : "";
    const storagePath = `${userId}/${Date.now()}-${name}`;

    const { data: file, error } = await supabase
      .from("files")
      .insert({
        name,
        original_name: name,
        extension,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        storage_path: storagePath,
        owner_id: userId,
        folder_id: folderId || null,
        category,
        is_starred: false,
        is_trash: false
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, file, storagePath });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/files/complete
 * Finalizes a file upload
 */
router.post("/complete", requireAuth, uploadLimiter, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { fileId } = req.body;

  if (!fileId) return res.status(400).json({ success: false, message: "fileId is required." });

  try {
    const { data: file, error } = await supabase
      .from("files")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", fileId)
      .eq("owner_id", userId)
      .select()
      .single();

    if (error) throw error;

    // Ensure Version 1 exists in file_versions
    try {
      const { data: existingVers } = await supabase
        .from("file_versions")
        .select("id")
        .eq("file_id", fileId);
      if (!existingVers || existingVers.length === 0) {
        const { data: newVer } = await supabase
          .from("file_versions")
          .insert({
            file_id: fileId,
            version_number: 1,
            storage_key: file.storage_path,
            size_bytes: file.size_bytes,
            checksum: null,
            created_at: file.created_at || new Date().toISOString()
          })
          .select()
          .single();
        if (newVer) {
          await supabase
            .from("files")
            .update({ version_id: newVer.id })
            .eq("id", fileId);
          file.version_id = newVer.id;
        }
      }
    } catch (verErr) {
      // Non-fatal if table doesn't exist yet
    }

    res.json({ success: true, file });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/files/:id
 * Renames or moves a file with permission check, extension preservation, and duplicate handling
 */
router.patch("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const userEmail = req.user?.email;
  const { id } = req.params;
  const { name, folderId } = req.body;

  try {
    // 1. Fetch file record to verify existence
    const { data: file, error: fetchErr } = await supabase
      .from("files")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchErr || !file || file.is_trash) {
      return res.status(404).json({ success: false, message: "File not found or has been moved to trash." });
    }

    // 2. Authorization Check:
    // User must be the owner OR have Editor permission via share grants
    let hasEditPermission = file.owner_id === userId;

    if (!hasEditPermission && userId) {
      // Check if file or parent folder is shared with user with 'editor' permission
      const userEmailClean = userEmail ? userEmail.trim().toLowerCase() : "";
      const { data: shares } = await supabase
        .from("shares")
        .select("permission, file_id, folder_id")
        .or(`shared_with_user_id.eq.${userId}${userEmailClean ? `,granted_to_email.eq.${userEmailClean}` : ""}`);

      if (shares && shares.length > 0) {
        const isFileEditor = shares.some(
          (s) => s.file_id === id && s.permission === "editor"
        );
        const isFolderEditor = file.folder_id
          ? shares.some((s) => s.folder_id === file.folder_id && s.permission === "editor")
          : false;

        if (isFileEditor || isFolderEditor) {
          hasEditPermission = true;
        }
      }
    }

    if (!hasEditPermission) {
      return res.status(403).json({
        success: false,
        message: "You don't have permission to rename or modify this file.",
      });
    }

    const updates: any = { updated_at: new Date().toISOString() };
    let finalName = file.name;

    // 3. Renaming Logic & Validation
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, message: "File name cannot be empty." });
      }

      const INVALID_CHARS_REGEX = /[\\/:*?"<>|]/;
      if (INVALID_CHARS_REGEX.test(trimmed)) {
        return res.status(400).json({
          success: false,
          message: 'File name cannot contain any of the following characters: \\ / : * ? " < > |',
        });
      }

      if (trimmed.length > 255) {
        return res.status(400).json({ success: false, message: "File name cannot exceed 255 characters." });
      }

      // Preserve file extension:
      let finalExtension = file.extension || "";
      const origExt = file.extension || (file.name.includes(".") ? file.name.split(".").pop() || "" : "");

      if (origExt) {
        const extWithDot = `.${origExt.toLowerCase()}`;
        if (trimmed.toLowerCase().endsWith(extWithDot)) {
          finalName = trimmed;
          finalExtension = origExt;
        } else if (trimmed.includes(".")) {
          finalExtension = trimmed.split(".").pop() || origExt;
          finalName = trimmed;
        } else {
          finalName = `${trimmed}.${origExt}`;
          finalExtension = origExt;
        }
      } else {
        if (trimmed.includes(".")) {
          finalExtension = trimmed.split(".").pop() || "";
        }
        finalName = trimmed;
      }

      updates.name = finalName;
      updates.original_name = finalName;
      updates.extension = finalExtension;
    }

    // 4. Moving Logic & Destination Folder Validation
    let targetFolderId = file.folder_id;
    let isFolderMoved = false;

    if (folderId !== undefined) {
      targetFolderId = folderId || null;
      isFolderMoved = targetFolderId !== file.folder_id;

      if (targetFolderId !== null) {
        // Fetch destination folder
        const { data: destFolder, error: destErr } = await supabase
          .from("folders")
          .select("id, name, owner_id, is_trash")
          .eq("id", targetFolderId)
          .maybeSingle();

        if (destErr || !destFolder) {
          return res.status(404).json({ success: false, message: "Destination folder not found." });
        }

        if (destFolder.is_trash) {
          return res.status(400).json({ success: false, message: "Cannot move file into a folder that is in Trash." });
        }

        // Destination Folder Authorization Check: Owner OR Shared Editor
        let hasDestPermission = destFolder.owner_id === userId;
        if (!hasDestPermission && userId) {
          const userEmailClean = userEmail ? userEmail.trim().toLowerCase() : "";
          const { data: destShares } = await supabase
            .from("shares")
            .select("permission, folder_id")
            .or(`shared_with_user_id.eq.${userId}${userEmailClean ? `,granted_to_email.eq.${userEmailClean}` : ""}`);

          if (destShares && destShares.some((s) => s.folder_id === targetFolderId && s.permission === "editor")) {
            hasDestPermission = true;
          }
        }

        if (!hasDestPermission) {
          return res.status(403).json({
            success: false,
            message: "You don't have permission to move files into this destination folder.",
          });
        }
      }

      updates.folder_id = targetFolderId;
    }

    // 5. Duplicate Filename Check in Target Folder
    if (name !== undefined || folderId !== undefined) {
      let dupQuery = supabase
        .from("files")
        .select("id, name")
        .eq("owner_id", file.owner_id)
        .eq("is_trash", false)
        .ilike("name", finalName)
        .neq("id", id);

      if (targetFolderId) {
        dupQuery = dupQuery.eq("folder_id", targetFolderId);
      } else {
        dupQuery = dupQuery.is("folder_id", null);
      }

      const { data: duplicates } = await dupQuery;
      if (duplicates && duplicates.length > 0) {
        const folderLabel = targetFolderId ? "the destination folder" : "My Drive root";
        return res.status(409).json({
          success: false,
          errorType: "duplicate_filename",
          message: `A file named "${finalName}" already exists in ${folderLabel}. Please choose a different destination or rename the file.`,
        });
      }
    }

    // 6. Update File Metadata in Database
    const { data: updatedFile, error: updateErr } = await supabase
      .from("files")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (updateErr) throw updateErr;

    // 7. Activity History Log
    if (userId) {
      try {
        if (isFolderMoved) {
          await supabase.from("activity_logs").insert({
            id: crypto.randomUUID(),
            user_id: userId,
            action: "move",
            entity_type: "file",
            entity_id: id,
            entity_name: updatedFile.name,
            metadata: {
              previous_folder_id: file.folder_id,
              new_folder_id: targetFolderId,
            },
            created_at: new Date().toISOString(),
          });
        } else if (name !== undefined && finalName !== file.name) {
          await supabase.from("activity_logs").insert({
            id: crypto.randomUUID(),
            user_id: userId,
            action: "rename",
            entity_type: "file",
            entity_id: id,
            entity_name: updatedFile.name,
            metadata: {
              previousName: file.name,
              newName: updatedFile.name,
            },
            created_at: new Date().toISOString(),
          });
        }
      } catch (e) {
        // Table may be absent or fails silently
      }
    }

    res.json({ success: true, file: updatedFile });
  } catch (err: any) {
    console.error("[PatchFileRoute] Error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to update file." });
  }
});

/**
 * POST /api/files/:id/star
 * Toggles starred status for a file
 */
router.post("/:id/star", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { id } = req.params;
  const { isStarred } = req.body;

  try {
    const { data: file, error } = await supabase
      .from("files")
      .update({ is_starred: isStarred })
      .eq("id", id)
      .eq("owner_id", userId)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, file });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/files/:id/copy
 * Creates an independent copy of a file in storage and database with duplicate filename resolution.
 */
router.post("/:id/copy", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const userEmail = req.user?.email;
  const { id } = req.params;
  const { folderId } = req.body;

  try {
    // 1. Fetch source file record
    const { data: file, error: fetchErr } = await supabase
      .from("files")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchErr || !file || file.is_trash) {
      return res.status(404).json({ success: false, message: "File not found or has been moved to trash." });
    }

    // 2. Authorization Check (Owner or Editor)
    let hasPermission = file.owner_id === userId;
    if (!hasPermission && userId) {
      const userEmailClean = userEmail ? userEmail.trim().toLowerCase() : "";
      const { data: shares } = await supabase
        .from("shares")
        .select("permission, file_id, folder_id")
        .or(`shared_with_user_id.eq.${userId}${userEmailClean ? `,granted_to_email.eq.${userEmailClean}` : ""}`);

      if (shares && shares.length > 0) {
        const isFileEditor = shares.some((s) => s.file_id === id && (s.permission === "editor" || s.permission === "viewer"));
        const isFolderEditor = file.folder_id
          ? shares.some((s) => s.folder_id === file.folder_id && (s.permission === "editor" || s.permission === "viewer"))
          : false;
        if (isFileEditor || isFolderEditor) {
          hasPermission = true;
        }
      }
    }

    if (!hasPermission) {
      return res.status(403).json({ success: false, message: "You do not have permission to copy this file." });
    }

    // 3. Validate Destination Folder if specified
    const targetFolderId = folderId || null;
    if (targetFolderId !== null) {
      const { data: destFolder, error: destErr } = await supabase
        .from("folders")
        .select("id, is_trash, owner_id")
        .eq("id", targetFolderId)
        .maybeSingle();

      if (destErr || !destFolder || destFolder.is_trash) {
        return res.status(404).json({ success: false, message: "Destination folder not found or unavailable." });
      }

      // Verify user has access to destination folder
      let hasDestPermission = destFolder.owner_id === userId;
      if (!hasDestPermission && userId) {
        const userEmailClean = userEmail ? userEmail.trim().toLowerCase() : "";
        const { data: destShares } = await supabase
          .from("shares")
          .select("permission, folder_id")
          .or(`shared_with_user_id.eq.${userId}${userEmailClean ? `,granted_to_email.eq.${userEmailClean}` : ""}`);

        if (destShares && destShares.some((s) => s.folder_id === targetFolderId)) {
          hasDestPermission = true;
        }
      }
      if (!hasDestPermission) {
        return res.status(403).json({ success: false, message: "You do not have permission to copy files into this destination folder." });
      }
    }

    // 4. Check Storage Quota Allowance (15GB default = 16106127360 bytes)
    const { data: profile } = await supabase
      .from("profiles")
      .select("storage_quota_bytes")
      .eq("id", userId)
      .single();

    const quotaBytes = profile?.storage_quota_bytes || DEFAULT_STORAGE_QUOTA_BYTES;

    const { data: userFiles } = await supabase
      .from("files")
      .select("size_bytes, is_trash")
      .eq("owner_id", userId);

    const totalUsedBytes = (userFiles || []).filter((f) => !f.is_trash).reduce((acc, curr) => acc + Number(curr.size_bytes || 0), 0);
    const fileSize = Number(file.size_bytes || 0);

    if (totalUsedBytes + fileSize > quotaBytes) {
      return res.status(400).json({
        success: false,
        message: "Storage limit reached. You don't have enough storage space to create this copy. Please delete some files or upgrade your storage plan.",
      });
    }

    // 5. Duplicate Filename Resolution in Target Folder
    // Extract base name and extension
    const origName = file.name || "Untitled";
    let baseName = origName;
    let ext = file.extension || "";
    if (origName.includes(".") && !ext) {
      ext = origName.split(".").pop() || "";
    }
    if (ext && baseName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
      baseName = baseName.slice(0, baseName.length - ext.length - 1);
    }

    let candidateName = origName;
    let counter = 1;

    while (true) {
      let query = supabase
        .from("files")
        .select("id")
        .eq("owner_id", userId)
        .eq("is_trash", false)
        .ilike("name", candidateName);

      if (targetFolderId) {
        query = query.eq("folder_id", targetFolderId);
      } else {
        query = query.is("folder_id", null);
      }

      const { data: existingMatches } = await query;
      if (!existingMatches || existingMatches.length === 0) {
        break;
      }

      candidateName = ext ? `${baseName} (${counter}).${ext}` : `${baseName} (${counter})`;
      counter++;
    }

    // 6. Independent Storage Object Copy in Supabase Storage ("cloudvault-files")
    const newStoragePath = `${userId}/${Date.now()}-${candidateName}`;
    const { error: storageCopyErr } = await supabase.storage
      .from("cloudvault-files")
      .copy(file.storage_path, newStoragePath);

    if (storageCopyErr) {
      console.error("[CopyFileRoute] Storage copy error:", storageCopyErr);
      return res.status(500).json({ success: false, message: "Failed to create independent storage copy." });
    }

    // 7. Create New Independent File Record in Database
    const { data: newFile, error: insertErr } = await supabase
      .from("files")
      .insert({
        id: crypto.randomUUID(),
        name: candidateName,
        original_name: candidateName,
        extension: ext || file.extension,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
        storage_path: newStoragePath,
        owner_id: userId,
        folder_id: targetFolderId,
        category: file.category,
        is_starred: false, // Default unstarred
        is_trash: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertErr) {
      // Rollback storage object if DB insert fails
      await supabase.storage.from("cloudvault-files").remove([newStoragePath]).catch(() => {});
      throw insertErr;
    }

    // 8. Log Activity History ("File copied")
    try {
      await supabase.from("activity_logs").insert({
        id: crypto.randomUUID(),
        user_id: userId,
        action: "copy",
        entity_type: "file",
        entity_id: newFile.id,
        entity_name: newFile.name,
        metadata: {
          original_file_id: file.id,
          original_file_name: file.name,
          new_file_id: newFile.id,
          new_file_name: newFile.name,
          destination_folder_id: targetFolderId,
        },
        created_at: new Date().toISOString(),
      });
    } catch (e) {
      // Ignore log error if table missing
    }

    res.json({ success: true, file: newFile, message: "File copied successfully" });
  } catch (err: any) {
    console.error("[CopyFileRoute] Error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to copy file." });
  }
});

/**
 * POST /api/files/bulk-trash
 * Moves multiple files to trash with individual permission validation and partial success handling.
 */
router.post("/bulk-trash", requireAuth, bulkLimiter, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const userEmail = req.user?.email;
  const { fileIds } = req.body;

  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ success: false, message: "No file IDs provided for bulk deletion." });
  }

  try {
    // 1. Fetch target file records that are not already in trash
    const { data: files, error: fetchErr } = await supabase
      .from("files")
      .select("id, name, owner_id, folder_id, is_trash")
      .in("id", fileIds)
      .eq("is_trash", false);

    if (fetchErr) {
      return res.status(400).json({ success: false, message: fetchErr.message });
    }

    if (!files || files.length === 0) {
      return res.status(404).json({ success: false, message: "None of the selected files were found or they are already in trash." });
    }

    // 2. Fetch user's shares for editor permission checks
    let userShares: any[] = [];
    if (userId) {
      const userEmailClean = userEmail ? userEmail.trim().toLowerCase() : "";
      const { data: shares } = await supabase
        .from("shares")
        .select("permission, file_id, folder_id")
        .or(`shared_with_user_id.eq.${userId}${userEmailClean ? `,granted_to_email.eq.${userEmailClean}` : ""}`);
      userShares = shares || [];
    }

    const authorizedIds: string[] = [];
    const authorizedFiles: any[] = [];
    let unauthorizedCount = (fileIds.length - files.length); // includes missing or already trashed

    for (const file of files) {
      let hasPermission = false;
      if (file.owner_id === userId) {
        hasPermission = true;
      } else if (userId) {
        const isFileEditor = userShares.some((s) => s.file_id === file.id && s.permission === "editor");
        const isFolderEditor = file.folder_id
          ? userShares.some((s) => s.folder_id === file.folder_id && s.permission === "editor")
          : false;
        if (isFileEditor || isFolderEditor) {
          hasPermission = true;
        }
      }

      if (hasPermission) {
        authorizedIds.push(file.id);
        authorizedFiles.push(file);
      } else {
        unauthorizedCount++;
      }
    }

    if (authorizedIds.length === 0) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to delete any of the selected files.",
      });
    }

    // 3. Mark authorized files as trashed
    const { error: updateErr } = await supabase
      .from("files")
      .update({ is_trash: true, updated_at: new Date().toISOString() })
      .in("id", authorizedIds);

    if (updateErr) throw updateErr;

    // 4. Log activity history for each successfully trashed file
    if (userId) {
      for (const file of authorizedFiles) {
        try {
          await supabase.from("activity_logs").insert({
            id: crypto.randomUUID(),
            user_id: userId,
            action: "trash",
            entity_type: "file",
            entity_id: file.id,
            entity_name: file.name,
            metadata: {
              folder_id: file.folder_id,
            },
            created_at: new Date().toISOString(),
          });
        } catch (e) {
          // Ignore log errors
        }
      }
    }

    const trashedCount = authorizedIds.length;
    let message = `${trashedCount} file${trashedCount === 1 ? "" : "s"} moved to Trash.`;
    if (unauthorizedCount > 0) {
      message += ` ${unauthorizedCount} file${unauthorizedCount === 1 ? "" : "s"} could not be deleted because you don't have permission or they were unavailable.`;
    }

    res.json({
      success: true,
      trashedCount,
      unauthorizedCount,
      message,
    });
  } catch (err: any) {
    console.error("[BulkTrashRoute] Error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to complete bulk delete." });
  }
});

/**
 * GET /api/files/:id/versions
 * Returns all versions for a file
 */
router.get("/:id/versions", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  const userId = req.user?.id;
  const userEmail = req.user?.email;
  const fileId = req.params.id;

  try {
    const { data: file, error: fetchErr } = await supabase
      .from("files")
      .select("*")
      .eq("id", fileId)
      .single();
    if (fetchErr || !file) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    let hasAccess = file.owner_id === userId;
    if (!hasAccess && userEmail) {
      const { data: share } = await supabase
        .from("shares")
        .select("permission")
        .eq("file_id", fileId)
        .eq("granted_to_email", userEmail)
        .single();
      if (share) hasAccess = true;
    }
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    let { data: versions, error: verErr } = await supabase
      .from("file_versions")
      .select("*")
      .eq("file_id", fileId)
      .order("version_number", { ascending: false });

    if (verErr || !versions || versions.length === 0) {
      // Auto-create Version 1 if none exist yet
      const { data: newVer, error: insErr } = await supabase
        .from("file_versions")
        .insert({
          file_id: fileId,
          version_number: 1,
          storage_key: file.storage_path,
          size_bytes: file.size_bytes,
          checksum: null,
          created_at: file.created_at || new Date().toISOString()
        })
        .select()
        .single();
      if (!insErr && newVer) {
        versions = [newVer];
        await supabase
          .from("files")
          .update({ version_id: newVer.id })
          .eq("id", fileId);
      } else {
        versions = [];
      }
    }

    res.json({
      success: true,
      currentVersionId: file.version_id || (versions[versions.length - 1]?.id || null),
      versions: versions.map((v: any) => ({
        id: v.id,
        fileId: v.file_id,
        versionNumber: v.version_number,
        storageKey: v.storage_key,
        sizeBytes: v.size_bytes,
        checksum: v.checksum,
        createdAt: v.created_at,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/files/:id/versions
 * Uploads a new version of an existing file
 */
router.post("/:id/versions", requireAuth, uploadLimiter, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  const userId = req.user?.id;
  const userEmail = req.user?.email;
  const fileId = req.params.id;
  const { base64Data, fileName, mimeType, sizeBytes } = req.body;

  if (!base64Data) {
    return res.status(400).json({ success: false, message: "File content is required." });
  }

  try {
    const { data: file, error: fetchErr } = await supabase
      .from("files")
      .select("*")
      .eq("id", fileId)
      .single();
    if (fetchErr || !file) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    let hasEdit = file.owner_id === userId;
    if (!hasEdit && userEmail) {
      const { data: share } = await supabase
        .from("shares")
        .select("permission")
        .eq("file_id", fileId)
        .eq("granted_to_email", userEmail)
        .single();
      if (share && share.permission === "editor") hasEdit = true;
    }
    if (!hasEdit) {
      return res.status(403).json({ success: false, message: "You don't have permission to modify this file." });
    }

    const { data: existingVers } = await supabase
      .from("file_versions")
      .select("version_number")
      .eq("file_id", fileId)
      .order("version_number", { ascending: false });

    const nextVerNum = existingVers && existingVers.length > 0 ? existingVers[0].version_number + 1 : 1;
    const name = fileName || file.name;
    const storagePath = `${userId}/v${nextVerNum}-${Date.now()}-${name}`;
    const buffer = Buffer.from(base64Data, "base64");
    const actualSize = sizeBytes || buffer.length;

    // Check storage quota before accepting version upload
    const { data: profile } = await supabase
      .from("profiles")
      .select("storage_quota_bytes")
      .eq("id", userId)
      .single();

    const quotaBytes = profile?.storage_quota_bytes || DEFAULT_STORAGE_QUOTA_BYTES;
    const { data: userFiles } = await supabase
      .from("files")
      .select("size_bytes, is_trash")
      .eq("owner_id", userId);

    const totalUsedBytes = (userFiles || []).filter((f) => !f.is_trash).reduce((acc, curr) => acc + Number(curr.size_bytes || 0), 0);
    if (totalUsedBytes + actualSize > quotaBytes) {
      return res.status(400).json({
        success: false,
        message: "Storage limit reached. You don't have enough storage space to upload this version. Please delete some files or upgrade your storage plan.",
      });
    }

    const { error: uploadErr } = await supabase.storage
      .from("cloudvault-files")
      .upload(storagePath, buffer, {
        contentType: mimeType || file.mime_type || "application/octet-stream",
        upsert: true,
      });

    if (uploadErr) {
      return res.status(500).json({ success: false, message: uploadErr.message });
    }

    const { data: newVer, error: verErr } = await supabase
      .from("file_versions")
      .insert({
        file_id: fileId,
        version_number: nextVerNum,
        storage_key: storagePath,
        size_bytes: actualSize,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (verErr) throw verErr;

    const { data: updatedFile, error: updateErr } = await supabase
      .from("files")
      .update({
        version_id: newVer.id,
        storage_path: storagePath,
        size_bytes: actualSize,
        mime_type: mimeType || file.mime_type,
        updated_at: new Date().toISOString(),
      })
      .eq("id", fileId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    await supabase.from("activity_logs").insert({
      id: crypto.randomUUID(),
      user_id: userId,
      action: "upload",
      entity_type: "file",
      entity_id: fileId,
      entity_name: updatedFile.name,
      metadata: { version_number: nextVerNum },
      created_at: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: `Version ${nextVerNum} uploaded successfully.`,
      file: updatedFile,
      version: newVer,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/files/:id/versions/:versionId/restore
 * Restores a specific version as the current version
 */
router.post("/:id/versions/:versionId/restore", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  const userId = req.user?.id;
  const userEmail = req.user?.email;
  const fileId = req.params.id;
  const versionId = req.params.versionId;

  try {
    const { data: file, error: fetchErr } = await supabase
      .from("files")
      .select("*")
      .eq("id", fileId)
      .single();
    if (fetchErr || !file) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    let hasEdit = file.owner_id === userId;
    if (!hasEdit && userEmail) {
      const { data: share } = await supabase
        .from("shares")
        .select("permission")
        .eq("file_id", fileId)
        .eq("granted_to_email", userEmail)
        .single();
      if (share && share.permission === "editor") hasEdit = true;
    }
    if (!hasEdit) {
      return res.status(403).json({ success: false, message: "You don't have permission to modify this file." });
    }

    const { data: targetVersion, error: verErr } = await supabase
      .from("file_versions")
      .select("*")
      .eq("id", versionId)
      .eq("file_id", fileId)
      .single();

    if (verErr || !targetVersion) {
      return res.status(404).json({ success: false, message: "Target version not found." });
    }

    const { data: updatedFile, error: updateErr } = await supabase
      .from("files")
      .update({
        version_id: targetVersion.id,
        storage_path: targetVersion.storage_key,
        size_bytes: targetVersion.size_bytes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", fileId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    await supabase.from("activity_logs").insert({
      id: crypto.randomUUID(),
      user_id: userId,
      action: "restore",
      entity_type: "file",
      entity_id: fileId,
      entity_name: updatedFile.name,
      metadata: { restored_version_number: targetVersion.version_number },
      created_at: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: `Restored Version ${targetVersion.version_number} as current.`,
      file: updatedFile,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/files/:id/versions/:versionId/download
 * Generates a download signed URL for a specific historical version
 */
router.get("/:id/versions/:versionId/download", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  const userId = req.user?.id;
  const userEmail = req.user?.email;
  const fileId = req.params.id;
  const versionId = req.params.versionId;

  try {
    const { data: file, error: fetchErr } = await supabase
      .from("files")
      .select("*")
      .eq("id", fileId)
      .single();
    if (fetchErr || !file) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    let hasAccess = file.owner_id === userId;
    if (!hasAccess && userEmail) {
      const { data: share } = await supabase
        .from("shares")
        .select("permission")
        .eq("file_id", fileId)
        .eq("granted_to_email", userEmail)
        .single();
      if (share) hasAccess = true;
    }
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const { data: targetVersion, error: verErr } = await supabase
      .from("file_versions")
      .select("*")
      .eq("id", versionId)
      .eq("file_id", fileId)
      .single();

    if (verErr || !targetVersion) {
      return res.status(404).json({ success: false, message: "Version not found." });
    }

    const { data: signed, error: signErr } = await supabase.storage
      .from("cloudvault-files")
      .createSignedUrl(targetVersion.storage_key, 3600);

    if (signErr || !signed?.signedUrl) {
      return res.status(500).json({ success: false, message: "Failed to generate download URL for version." });
    }

    res.json({
      success: true,
      downloadUrl: signed.signedUrl,
      versionNumber: targetVersion.version_number,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
