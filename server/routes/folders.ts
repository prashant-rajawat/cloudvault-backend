import { Router, Response } from "express";
import { getSupabaseAdminClient } from "../config/supabase.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/authMiddleware.js";

const router = Router();

/**
 * Cleanup expired trash items (older than 30 days)
 */
async function cleanupExpiredTrash(userId: string) {
  const supabase = getSupabaseAdminClient();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  // Find expired folders
  const { data: expiredFolders } = await supabase
    .from("folders")
    .select("id")
    .eq("owner_id", userId)
    .eq("is_trash", true)
    .lt("updated_at", thirtyDaysAgo.toISOString());

  if (expiredFolders && expiredFolders.length > 0) {
    for (const folder of expiredFolders) {
      // In a simple setup, we just delete the folder record.
      // A more robust system would recursively delete contents.
      await supabase.from("folders").delete().eq("id", folder.id);
    }
  }

  // Find expired files
  const { data: expiredFiles } = await supabase
    .from("files")
    .select("id, storage_path")
    .eq("owner_id", userId)
    .eq("is_trash", true)
    .lt("updated_at", thirtyDaysAgo.toISOString());

  if (expiredFiles && expiredFiles.length > 0) {
    for (const file of expiredFiles) {
      await supabase.storage.from("cloudvault-files").remove([file.storage_path]);
      await supabase.from("files").delete().eq("id", file.id);
    }
  }
}

/**
 * POST /api/folders/cleanup
 * Manually trigger cleanup of expired trash items for the user
 */
router.post("/cleanup", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user.id;
    await cleanupExpiredTrash(userId);
    res.json({ success: true, message: "Trash cleanup completed" });
  } catch (err: any) {
    console.error("Cleanup error:", err);
    res.status(500).json({ success: false, message: err.message });
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

  try {
    // Check for duplicate name in the same parent
    const { data: existing, error: checkError } = await supabase
      .from("folders")
      .select("id")
      .eq("owner_id", userId)
      .eq("name", trimmedName)
      .eq("parent_id", parentId || null)
      .eq("is_trash", false)
      .maybeSingle();

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
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) return res.status(400).json({ success: false, message: "Name cannot be empty." });
      
      // Check for duplicate
      const { data: existing } = await supabase
        .from("folders")
        .select("id")
        .eq("owner_id", userId)
        .eq("name", trimmed)
        .eq("parent_id", parentId !== undefined ? parentId : folder.parent_id)
        .eq("is_trash", false)
        .neq("id", id)
        .maybeSingle();
      
      if (existing) {
        return res.status(400).json({ success: false, message: "A folder with this name already exists in the destination." });
      }
      updates.name = trimmed;
    }

    if (parentId !== undefined) {
      if (parentId === id) {
        return res.status(400).json({ success: false, message: "Cannot move a folder into itself." });
      }
      // Check for circular reference (moving into a child)
      if (parentId !== null) {
        let currentParentId = parentId;
        const visited = new Set();
        while (currentParentId) {
          if (currentParentId === id) {
            return res.status(400).json({ success: false, message: "Cannot move a folder into one of its children." });
          }
          if (visited.has(currentParentId)) break; // Prevent infinite loop in case of existing corruption
          visited.add(currentParentId);
          
          const { data: parent } = await supabase
            .from("folders")
            .select("parent_id")
            .eq("id", currentParentId)
            .single();
          
          if (!parent) break;
          currentParentId = parent.parent_id;
        }
      }
      updates.parent_id = parentId;
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
