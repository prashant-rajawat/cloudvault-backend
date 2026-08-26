import { Router, Response } from "express";
import { getSupabaseAdminClient } from "../config/supabase.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/authMiddleware.js";

const router = Router();

/**
 * POST /api/storage/signed-url
 * Generates a temporary signed download URL for private files
 */
router.post("/signed-url", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  const userEmail = req.user?.email;
  const userRole = req.user?.role;
  const { path, expiresIn = 3600 } = req.body;

  if (!path) {
    return res.status(400).json({ success: false, message: "path is required." });
  }

  // 1. Owner check
  let isAuthorized = Boolean(userId && path.startsWith(`${userId}/`));

  // 2. Admin check
  if (!isAuthorized && userRole === "admin") {
    isAuthorized = true;
  }

  // 3. Shared recipient check
  if (!isAuthorized && userEmail) {
    try {
      const { data: file } = await supabase
        .from("files")
        .select("id")
        .eq("storage_path", path)
        .maybeSingle();

      if (file) {
        const { data: share } = await supabase
          .from("shares")
          .select("id, expires_at")
          .eq("file_id", file.id)
          .eq("granted_to_email", userEmail)
          .maybeSingle();

        if (share) {
          const isExpired = share.expires_at && new Date(share.expires_at) < new Date();
          if (!isExpired) {
            isAuthorized = true;
          }
        }
      }
    } catch {
      // Query error
    }
  }

  if (!isAuthorized) {
    return res.status(403).json({ success: false, message: "Access denied. You are not authorized to access this storage path." });
  }

  try {
    const { data, error } = await supabase.storage
      .from("cloudvault-files")
      .createSignedUrl(path, expiresIn);

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    res.json({ success: true, signedUrl: data.signedUrl });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
