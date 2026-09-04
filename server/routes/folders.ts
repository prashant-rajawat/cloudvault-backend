import { Router, Response } from "express";
import { getSupabaseAdminClient } from "../config/supabase.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/authMiddleware.js";

const router = Router();

/**
 * Cleanup expired trash items (older than 30 days)
 */
async function cleanupExpiredTrash(userId: string) {
  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) return;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    // Find expired folders
    const { data: expiredFolders, error: folderErr } = await supabase
      .from("folders")
      .select("id")
      .eq("owner_id", userId)
      .eq("is_trash", true)
      .lt("updated_at", thirtyDaysAgo.toISOString());

    if (!folderErr && expiredFolders && expiredFolders.length > 0) {
      for (const folder of expiredFolders) {
        await supabase.from("folders").delete().eq("id", folder.id);
      }
    }

    // Find expired files
    const { data: expiredFiles, error: fileErr } = await supabase
      .from("files")
      .select("id, storage_path")
      .eq("owner_id", userId)
      .eq("is_trash", true)
      .lt("updated_at", thirtyDaysAgo.toISOString());

    if (!fileErr && expiredFiles && expiredFiles.length > 0) {
      for (const file of expiredFiles) {
        if (file.storage_path) {
          try {
            await supabase.storage.from("cloudvault-files").remove([file.storage_path]);
          } catch {
            // Ignore storage removal errors during cleanup
          }
        }
        await supabase.from("files").delete().eq("id", file.id);
      }
    }
  } catch (err) {
    console.warn("Background trash cleanup notice:", err);
  }
}

/**
 * POST /api/folders/cleanup
 * Manually trigger cleanup of expired trash items for the user
 */
router.post("/cleanup", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (userId) {
      await cleanupExpiredTrash(userId);
    }
    res.json({ success: true, message: "Trash cleanup completed" });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || "Trash cleanup skipped" });
  }
});

/**
 * POST /api/folders
 * Creates a new folder with server-side validation
 */
router.post("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { name, parentId, color } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: "Folder name is required." });
  }

  const trimmedName = name.trim();
  const INVALID_CHARS_REGEX = /[\\/:*?"<>|]/;
  if (INVALID_CHARS_REGEX.test(trimmedName)) {
    return res.status(400).json({
      success: false,
      message: 'Folder name cannot contain any of the following characters: \\ / : * ? " < > |',
    });
  }

  if (trimmedName.length > 255) {
    return res.status(400).json({ success: false, message: "Folder name cannot exceed 255 characters." });
  }

  try {
    // Check for duplicate name in the same parent (case-insensitive)
    let checkQuery = supabase
      .from("folders")
      .select("id")
      .eq("owner_id", userId)
      .ilike("name", trimmedName)
      .eq("is_trash", false);

    if (parentId) {
      checkQuery = checkQuery.eq("parent_id", parentId);
    } else {
      checkQuery = checkQuery.is("parent_id", null);
    }

    const { data: existing, error: checkError } = await checkQuery.maybeSingle();

    if (checkError) throw checkError;
    if (existing) {
      return res.status(400).json({ success: false, message: "A folder with this name already exists in this location." });
    }

    const { data: folder, error } = await supabase
      .from("folders")
      .insert({
        owner_id: userId,
        name: trimmedName,
        parent_id: parentId || null,
        color: color || "blue",
        is_starred: false,
        is_trash: false,
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, folder });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/folders/:id
 * Renames or moves a folder
 */
router.patch("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { id } = req.params;
  const { name, parentId } = req.body;

  try {
    // Verify ownership
    const { data: folder, error: fetchErr } = await supabase
      .from("folders")
      .select("*")
      .eq("id", id)
      .eq("owner_id", userId)
      .single();

    if (fetchErr || !folder) {
      return res.status(404).json({ success: false, message: "Folder not found or unauthorized." });
    }

    const updates: any = {};
    let finalName = folder.name;
    let finalParentId = folder.parent_id;

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) return res.status(400).json({ success: false, message: "Folder name cannot be empty." });
      
      const INVALID_CHARS_REGEX = /[\\/:*?"<>|]/;
      if (INVALID_CHARS_REGEX.test(trimmed)) {
        return res.status(400).json({
          success: false,
          message: 'Folder name cannot contain any of the following characters: \\ / : * ? " < > |',
        });
      }

      if (trimmed.length > 255) {
        return res.status(400).json({ success: false, message: "Folder name cannot exceed 255 characters." });
      }

      finalName = trimmed;
      updates.name = trimmed;
    }

    if (parentId !== undefined) {
      const targetParent = parentId || null;
      if (targetParent === id) {
        return res.status(400).json({ success: false, message: "Cannot move a folder into itself." });
      }
      
      // Check destination folder validity and ownership if not moving to root
      if (targetParent !== null) {
        const { data: destFolder, error: destErr } = await supabase
          .from("folders")
          .select("id, parent_id, is_trash")
          .eq("id", targetParent)
          .eq("owner_id", userId)
          .single();

        if (destErr || !destFolder) {
          return res.status(400).json({ success: false, message: "Destination folder not found or unauthorized." });
        }

        // Check for circular reference (moving into a descendant)
        let currentParentId: string | null = targetParent;
        const visited = new Set<string>();
        while (currentParentId) {
          if (currentParentId === id) {
            return res.status(400).json({ success: false, message: "Cannot move a folder into one of its subfolders." });
          }
          if (visited.has(currentParentId)) break;
          visited.add(currentParentId);
          
          const { data: pFolder }: { data: { parent_id: string | null } | null } = await supabase
            .from("folders")
            .select("parent_id")
            .eq("id", currentParentId)
            .single();
          
          if (!pFolder) break;
          currentParentId = pFolder.parent_id;
        }
      }
      finalParentId = targetParent;
      updates.parent_id = targetParent;
    }

    // Check for duplicate name in the target parent
    if (name !== undefined || parentId !== undefined) {
      let dupQuery = supabase
        .from("folders")
        .select("id")
        .eq("owner_id", userId)
        .ilike("name", finalName)
        .eq("is_trash", false)
        .neq("id", id);

      if (finalParentId) {
        dupQuery = dupQuery.eq("parent_id", finalParentId);
      } else {
        dupQuery = dupQuery.is("parent_id", null);
      }

      const { data: existing } = await dupQuery.maybeSingle();
      if (existing) {
        return res.status(400).json({ success: false, message: "A folder with this name already exists in the destination." });
      }
    }

    const { data: updated, error: updateErr } = await supabase
      .from("folders")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (updateErr) throw updateErr;

    res.json({ success: true, folder: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/folders/:id/trash
 * Moves a folder and all its contents to trash recursively
 */
router.post("/:id/trash", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { id } = req.params;

  try {
    // 1. Get all recursive children
    const allFolderIds = new Set<string>([id]);
    const queue = [id];
    
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const { data: children } = await supabase
        .from("folders")
        .select("id")
        .eq("parent_id", currentId)
        .eq("owner_id", userId);
      
      if (children) {
        for (const child of children) {
          if (!allFolderIds.has(child.id)) {
            allFolderIds.add(child.id);
            queue.push(child.id);
          }
        }
      }
    }

    const folderIdList = Array.from(allFolderIds);

    // 2. Update folders to is_trash = true
    const { error: fErr } = await supabase
      .from("folders")
      .update({ is_trash: true })
      .in("id", folderIdList)
      .eq("owner_id", userId);
    
    if (fErr) throw fErr;

    // 3. Update files in these folders to is_trash = true
    const { error: fileErr } = await supabase
      .from("files")
      .update({ is_trash: true })
      .in("folder_id", folderIdList)
      .eq("owner_id", userId);
    
    if (fileErr) throw fileErr;

    res.json({ success: true, message: "Folder and contents moved to trash." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/folders/:id/restore
 * Restores a folder and its contents
 */
router.post("/:id/restore", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { id } = req.params;

  try {
    // Recursive restore
    const allFolderIds = new Set<string>([id]);
    const queue = [id];
    
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const { data: children } = await supabase
        .from("folders")
        .select("id")
        .eq("parent_id", currentId)
        .eq("owner_id", userId);
      
      if (children) {
        for (const child of children) {
          if (!allFolderIds.has(child.id)) {
            allFolderIds.add(child.id);
            queue.push(child.id);
          }
        }
      }
    }

    const folderIdList = Array.from(allFolderIds);

    // Update folders
    const { error: fErr } = await supabase
      .from("folders")
      .update({ is_trash: false })
      .in("id", folderIdList)
      .eq("owner_id", userId);
    
    if (fErr) throw fErr;

    // Update files
    const { error: fileErr } = await supabase
      .from("files")
      .update({ is_trash: false })
      .in("folder_id", folderIdList)
      .eq("owner_id", userId);
    
    if (fileErr) throw fileErr;

    res.json({ success: true, message: "Folder and contents restored." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/folders/:id
 * Permanently deletes a folder and all its contents
 */
router.delete("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { id } = req.params;

  try {
    // 1. Recursive gather all children
    const allFolderIds = new Set<string>([id]);
    const queue = [id];
    
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const { data: children } = await supabase
        .from("folders")
        .select("id")
        .eq("parent_id", currentId)
        .eq("owner_id", userId);
      
      if (children) {
        for (const child of children) {
          if (!allFolderIds.has(child.id)) {
            allFolderIds.add(child.id);
            queue.push(child.id);
          }
        }
      }
    }

    const folderIdList = Array.from(allFolderIds);

    // 2. Get all files in these folders to delete from storage
    const { data: filesToDelete } = await supabase
      .from("files")
      .select("id, storage_path")
      .in("folder_id", folderIdList)
      .eq("owner_id", userId);

    if (filesToDelete && filesToDelete.length > 0) {
      const paths = filesToDelete.map(f => f.storage_path).filter(Boolean);
      if (paths.length > 0) {
        await supabase.storage.from("cloudvault-files").remove(paths);
      }
      
      // Delete file records
      const { error: fileDeleteErr } = await supabase
        .from("files")
        .delete()
        .in("id", filesToDelete.map(f => f.id));
      if (fileDeleteErr) throw fileDeleteErr;
    }

    // 3. Delete folder records
    const { error: folderDeleteErr } = await supabase
      .from("folders")
      .delete()
      .in("id", folderIdList)
      .eq("owner_id", userId);
    
    if (folderDeleteErr) throw folderDeleteErr;

    res.json({ success: true, message: "Folder and all contents permanently deleted." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
