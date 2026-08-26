import { Router, Response } from "express";
import { getSupabaseAdminClient } from "../config/supabase.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/authMiddleware.js";

const router = Router();

/**
 * GET /api/auth/me
 * Returns authenticated user info and public.profiles details
 */
router.get("/me", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;

  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    if (error) {
      console.warn("Profile query warning in /me:", error.message);
    }

    const resolvedProfile = profile || {
      id: userId,
      email: req.user?.email || "",
      full_name: req.user?.email?.split("@")[0] || "User",
      avatar_url: null,
      role: req.user?.role || "user",
      status: "active",
    };

    res.json({
      success: true,
      user: req.user,
      profile: resolvedProfile,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/auth/delete-account
 * Safely deletes user's Storage objects, DB records, and Supabase Auth account
 */
router.post("/delete-account", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  try {
    // 1. Fetch user files to remove from Supabase Storage
    const { data: userFiles } = await supabase
      .from("files")
      .select("storage_path")
      .eq("owner_id", userId);

    if (userFiles && userFiles.length > 0) {
      const paths = userFiles.map((f: any) => f.storage_path).filter(Boolean);
      if (paths.length > 0) {
        await supabase.storage.from("media-files").remove(paths);
      }
    }

    // 2. Delete database records associated with user
    await supabase.from("shares").delete().eq("owner_id", userId);
    await supabase.from("notifications").delete().eq("user_id", userId);
    await supabase.from("activity_logs").delete().eq("user_id", userId);
    await supabase.from("files").delete().eq("owner_id", userId);
    await supabase.from("folders").delete().eq("owner_id", userId);
    await supabase.from("profiles").delete().eq("id", userId);

    // 3. Delete Auth User using admin API
    const { error: authErr } = await supabase.auth.admin.deleteUser(userId);
    if (authErr) {
      console.warn("Could not delete auth user record:", authErr.message);
    }

    res.json({ success: true, message: "Account and user data permanently deleted." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || "Failed to delete account" });
  }
});

export default router;
