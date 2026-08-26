import { Router, Response } from "express";
import { getSupabaseAdminClient } from "../config/supabase.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/authMiddleware.js";

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

    const activeFiles = (files || []).filter((f) => !f.is_trash);
    const trashedFiles = (files || []).filter((f) => f.is_trash);
    const activeFolders = (folders || []).filter((f) => !f.is_trash);

    const totalUsedBytes = activeFiles.reduce((acc, curr) => acc + Number(curr.size_bytes || 0), 0);
    const totalQuotaBytes = 5368709120; // 5 GB default

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
router.post("/permanent-delete", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
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
 * Moves a file to trash
 */
router.post("/:id/trash", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from("files")
      .update({ is_trash: true })
      .eq("id", id)
      .eq("owner_id", userId);

    if (error) throw error;
    res.json({ success: true, message: "File moved to trash." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/files/:id/restore
 * Restores a file from trash
 */
router.post("/:id/restore", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from("files")
      .update({ is_trash: false })
      .eq("id", id)
      .eq("owner_id", userId);

    if (error) throw error;
    res.json({ success: true, message: "File restored." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
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
 * Initializes a file upload by creating a file record
 */
router.post("/init", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { name, mimeType, sizeBytes, folderId } = req.body;

  if (!name) return res.status(400).json({ success: false, message: "name is required." });

  try {
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
router.post("/complete", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
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

    res.json({ success: true, file });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/files/:id
 * Renames or moves a file
 */
router.patch("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { id } = req.params;
  const { name, folderId } = req.body;

  try {
    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (folderId !== undefined) updates.folder_id = folderId;

    const { data: file, error } = await supabase
      .from("files")
      .update(updates)
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

export default router;
