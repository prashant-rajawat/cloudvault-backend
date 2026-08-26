import { Router, Response } from "express";
import { getSupabaseAdminClient } from "../config/supabase.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/authMiddleware.js";
import {
  fetchAllAnnouncementsAdmin,
  createAnnouncementRecord,
  updateAnnouncementRecord,
  deleteAnnouncementRecord,
} from "../services/announcementsService.js";

const router = Router();

/**
 * Helper: Log Admin Audit Action
 */
async function logAdminAudit(
  adminId: string,
  action: string,
  targetId?: string | null,
  targetType?: string | null,
  metadata?: Record<string, any>
) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return;
  try {
    await supabase.from("admin_audit_logs").insert({
      admin_id: adminId,
      action,
      target_id: targetId || null,
      target_type: targetType || null,
      metadata: metadata || {},
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("Could not write admin_audit_logs:", err);
  }
}

/**
 * Middleware: requireAdmin
 * Validates authenticated user token and checks if user is an admin in profiles table.
 */
export const requireAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
  next: () => void
) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized. Login required." });
  }

  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id, role, email")
      .eq("id", userId)
      .single();

    if (error && error.code !== "PGRST116") {
      console.warn("Error checking admin profile:", error.message);
    }

    const isUserAdmin = profile && profile.role === "admin";

    if (!isUserAdmin) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin authorization required.",
        code: "FORBIDDEN_NOT_ADMIN",
      });
    }

    (req as any).adminProfile = profile;
    next();
  } catch (err: any) {
    return res.status(500).json({ success: false, message: "Failed to verify admin status.", error: err.message });
  }
};

/**
 * GET /api/admin/check-access
 * Verifies if current user has admin access
 */
router.get("/check-access", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, email, full_name, role")
      .eq("id", userId)
      .single();

    const isAdmin = Boolean(profile && profile.role === "admin");

    res.json({
      success: true,
      isAdmin,
      isSuspended: false,
      role: profile?.role || "user",
      status: "active",
      profile: profile || null,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/admin/schema-status
 * Diagnostics endpoint to verify table and column existence in Supabase
 */
router.get("/schema-status", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const checks: Record<string, boolean> = {};
  const errors: Record<string, string> = {};

  try {
    const { error } = await supabase.from("profiles").select("role, storage_quota_bytes").limit(1);
    checks["profiles_columns"] = !error;
    if (error) errors["profiles_columns"] = error.message;
  } catch (e: any) {
    checks["profiles_columns"] = false;
    errors["profiles_columns"] = e.message;
  }

  try {
    const { error } = await supabase.from("announcements").select("id").limit(1);
    checks["announcements_table"] = !error;
    if (error) errors["announcements_table"] = error.message;
  } catch (e: any) {
    checks["announcements_table"] = false;
    errors["announcements_table"] = e.message;
  }

  try {
    const { error } = await supabase.from("reports").select("id").limit(1);
    checks["reports_table"] = !error;
    if (error) errors["reports_table"] = error.message;
  } catch (e: any) {
    checks["reports_table"] = false;
    errors["reports_table"] = e.message;
  }

  try {
    const { error } = await supabase.from("admin_audit_logs").select("id").limit(1);
    checks["admin_audit_logs_table"] = !error;
    if (error) errors["admin_audit_logs_table"] = error.message;
  } catch (e: any) {
    checks["admin_audit_logs_table"] = false;
    errors["admin_audit_logs_table"] = e.message;
  }

  try {
    const { error } = await supabase.from("system_settings").select("key").limit(1);
    checks["system_settings_table"] = !error;
    if (error) errors["system_settings_table"] = error.message;
  } catch (e: any) {
    checks["system_settings_table"] = false;
    errors["system_settings_table"] = e.message;
  }

  const allReady = Object.values(checks).every(Boolean);

  res.json({
    success: true,
    allReady,
    checks,
    errors,
  });
});

/**
 * GET /api/admin/dashboard-stats
 * Real Supabase statistics overview
 */
router.get("/dashboard-stats", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  try {
    // 1. Users count from profiles and auth
    const { data: profiles, error: userErr } = await supabase.from("profiles").select("id, created_at");
    if (userErr && userErr.code !== "PGRST116") {
      throw new Error(`Profiles query failed: ${userErr.message}`);
    }

    const { data: authUsersData } = await supabase.auth.admin.listUsers();
    const totalUsers = Math.max((profiles || []).length, (authUsersData?.users || []).length);
    const activeUsers = totalUsers;

    // 2. Files count and total storage used
    const { data: files, error: fileErr } = await supabase
      .from("files")
      .select("id, size_bytes, is_trash, owner_id");

    if (fileErr && fileErr.code !== "PGRST116") {
      throw new Error(`Files query failed: ${fileErr.message}`);
    }

    const activeFiles = (files || []).filter((f) => !f.is_trash);
    const totalFiles = activeFiles.length;
    const totalStorageUsed = activeFiles.reduce((sum, file) => sum + Number(file.size_bytes || 0), 0);

    // 3. Folders count
    const { data: folders } = await supabase.from("folders").select("id, is_trash");
    const totalFolders = (folders || []).filter((f) => !f.is_trash).length;

    // 4. Shared files and folders
    const { data: shares } = await supabase.from("shares").select("id, file_id, folder_id");
    const sharedFiles = (shares || []).filter((s) => Boolean(s.file_id)).length;
    const sharedFolders = (shares || []).filter((s) => Boolean(s.folder_id)).length;

    // 5. Unresolved abuse reports count
    let unresolvedReports = 0;
    try {
      const { data: reports } = await supabase.from("reports").select("id, status").eq("status", "open");
      unresolvedReports = (reports || []).length;
    } catch {
      // reports table might not exist yet
    }

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        totalFiles,
        totalFolders,
        totalStorageUsed,
        sharedFiles,
        sharedFolders,
        unresolvedReports,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/admin/users
 * Returns all registered users with storage consumption and metadata
 */
router.get("/users", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  try {
    // Fetch profiles
    const { data: profiles, error: profErr } = await supabase.from("profiles").select("*");
    if (profErr && profErr.code !== "PGRST116") {
      throw new Error(profErr.message);
    }

    // Fetch Auth users list for email fallback and created_at
    const { data: authList } = await supabase.auth.admin.listUsers();
    const authUsers = authList?.users || [];

    // Fetch files grouped by owner to calculate exact usage
    const { data: files } = await supabase.from("files").select("owner_id, size_bytes, is_trash");
    const usageMap: Record<string, { bytes: number; count: number }> = {};

    (files || []).forEach((file) => {
      if (!file.is_trash) {
        if (!usageMap[file.owner_id]) {
          usageMap[file.owner_id] = { bytes: 0, count: 0 };
        }
        usageMap[file.owner_id].bytes += Number(file.size_bytes || 0);
        usageMap[file.owner_id].count += 1;
      }
    });

    // Merge profiles and auth records
    const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
    const allUserIds = new Set([
      ...(profiles || []).map((p) => p.id),
      ...authUsers.map((u) => u.id),
    ]);

    const usersList = Array.from(allUserIds).map((id) => {
      const prof = profileMap.get(id);
      const authUser = authUsers.find((u) => u.id === id);
      const usage = usageMap[id] || { bytes: 0, count: 0 };

      return {
        id,
        email: prof?.email || authUser?.email || "Unknown User",
        fullName: prof?.full_name || prof?.fullName || authUser?.user_metadata?.full_name || "CloudVault User",
        avatarUrl: prof?.avatar_url || prof?.avatarUrl || authUser?.user_metadata?.avatar_url || "",
        role: prof?.role || "user",
        status: prof?.status || "active",
        storageQuotaBytes: prof?.storage_quota_bytes || 5368709120, // 5 GB
        storageUsedBytes: usage.bytes,
        fileCount: usage.count,
        createdAt: prof?.created_at || authUser?.created_at || new Date().toISOString(),
      };
    });

    res.json({
      success: true,
      users: usersList,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/admin/users/:id
 * User Details Endpoint
 */
router.get("/users/:id", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const targetUserId = req.params.id;

  try {
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", targetUserId).single();
    const { data: authUser } = await supabase.auth.admin.getUserById(targetUserId).catch(() => ({ data: null }));

    // User files and folders metadata
    const { data: files } = await supabase.from("files").select("id, size_bytes, category, is_trash").eq("owner_id", targetUserId);
    const { data: folders } = await supabase.from("folders").select("id, is_trash").eq("owner_id", targetUserId);

    const activeFiles = (files || []).filter((f) => !f.is_trash);
    const activeFolders = (folders || []).filter((f) => !f.is_trash);
    const storageUsedBytes = activeFiles.reduce((sum, f) => sum + Number(f.size_bytes || 0), 0);

    // Recent activity logs for target user
    let recentActivity: any[] = [];
    try {
      const { data: logs } = await supabase
        .from("activity_logs")
        .select("*")
        .eq("user_id", targetUserId)
        .order("created_at", { ascending: false })
        .limit(10);
      recentActivity = logs || [];
    } catch {
      recentActivity = [];
    }

    res.json({
      success: true,
      user: {
        id: targetUserId,
        email: profile?.email || authUser?.user?.email || "",
        fullName: profile?.full_name || profile?.fullName || "CloudVault User",
        avatarUrl: profile?.avatar_url || profile?.avatarUrl || "",
        role: profile?.role || "user",
        status: profile?.status || "active",
        storageQuotaBytes: profile?.storage_quota_bytes || 5368709120,
        storageUsedBytes,
        fileCount: activeFiles.length,
        folderCount: activeFolders.length,
        createdAt: profile?.created_at || authUser?.user?.created_at || new Date().toISOString(),
        recentActivity,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/admin/users/:id/role
 * Admin update user role
 */
router.patch("/users/:id/role", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const targetUserId = req.params.id;
  const { role } = req.body;

  if (!role || !["user", "admin"].includes(role)) {
    return res.status(400).json({ success: false, message: "Role must be 'user' or 'admin'." });
  }

  try {
    const { error } = await supabase
      .from("profiles")
      .update({ role, updated_at: new Date().toISOString() })
      .eq("id", targetUserId);

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    await logAdminAudit(req.user!.id, "change_role", targetUserId, "user", { newRole: role });

    res.json({ success: true, message: `User role updated to ${role}.` });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/admin/users/:id/quota
 * Admin update user storage quota
 */
router.patch("/users/:id/quota", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const targetUserId = req.params.id;
  const { quotaBytes } = req.body;

  const quotaNum = Number(quotaBytes);
  if (isNaN(quotaNum) || quotaNum <= 0) {
    return res.status(400).json({ success: false, message: "Storage quota must be a positive number of bytes." });
  }

  if (quotaNum > 1099511627776) { // Max 1 TB
    return res.status(400).json({ success: false, message: "Storage quota exceeds maximum allowed limit (1 TB)." });
  }

  try {
    const { error } = await supabase
      .from("profiles")
      .update({ storage_quota_bytes: quotaNum, updated_at: new Date().toISOString() })
      .eq("id", targetUserId);

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    await logAdminAudit(req.user!.id, "change_quota", targetUserId, "user", { quotaBytes: quotaNum });

    res.json({ success: true, message: "User storage quota updated successfully." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/admin/users/:id/status
 * Admin update user account status (active or suspended)
 */
router.patch("/users/:id/status", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const targetUserId = req.params.id;
  const { status } = req.body;

  if (!status || !["active", "suspended"].includes(status)) {
    return res.status(400).json({ success: false, message: "Status must be 'active' or 'suspended'." });
  }

  if (targetUserId === req.user!.id && status === "suspended") {
    return res.status(400).json({ success: false, message: "Administrators cannot suspend their own account." });
  }

  try {
    const { error } = await supabase
      .from("profiles")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", targetUserId);

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    await logAdminAudit(req.user!.id, "suspend_user", targetUserId, "user", { newStatus: status });

    res.json({ success: true, message: `User status changed to ${status}.` });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/admin/users/:id
 * Admin delete user account and data
 */
router.delete("/users/:id", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const targetUserId = req.params.id;

  if (targetUserId === req.user!.id) {
    return res.status(400).json({ success: false, message: "Administrators cannot delete their own account from Admin panel." });
  }

  try {
    // 1. Remove files from storage
    const { data: userFiles } = await supabase.from("files").select("storage_path").eq("owner_id", targetUserId);
    if (userFiles && userFiles.length > 0) {
      const paths = userFiles.map((f: any) => f.storage_path).filter(Boolean);
      if (paths.length > 0) {
        await supabase.storage.from("media-files").remove(paths);
      }
    }

    // 2. Remove database rows
    await supabase.from("shares").delete().eq("owner_id", targetUserId);
    await supabase.from("notifications").delete().eq("user_id", targetUserId);
    await supabase.from("activity_logs").delete().eq("user_id", targetUserId);
    await supabase.from("files").delete().eq("owner_id", targetUserId);
    await supabase.from("folders").delete().eq("owner_id", targetUserId);
    await supabase.from("profiles").delete().eq("id", targetUserId);

    // 3. Delete from Supabase Auth
    await supabase.auth.admin.deleteUser(targetUserId);

    await logAdminAudit(req.user!.id, "delete_user", targetUserId, "user");

    res.json({ success: true, message: "User account and files permanently deleted." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/admin/storage/stats
 * Storage Breakdown and Top Users
 */
router.get("/storage/stats", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  try {
    const { data: files } = await supabase.from("files").select("id, owner_id, size_bytes, category, is_trash");
    const { data: profiles } = await supabase.from("profiles").select("id, email, full_name, storage_quota_bytes");

    const activeFiles = (files || []).filter((f) => !f.is_trash);

    // Category breakdown
    const categories: Record<string, { bytes: number; count: number }> = {
      image: { bytes: 0, count: 0 },
      document: { bytes: 0, count: 0 },
      video: { bytes: 0, count: 0 },
      audio: { bytes: 0, count: 0 },
      archive: { bytes: 0, count: 0 },
      other: { bytes: 0, count: 0 },
    };

    let totalUsedBytes = 0;

    activeFiles.forEach((f) => {
      const cat = f.category && categories[f.category] ? f.category : "other";
      const bytes = Number(f.size_bytes || 0);
      categories[cat].bytes += bytes;
      categories[cat].count += 1;
      totalUsedBytes += bytes;
    });

    // Top users by storage consumption
    const userStorageMap: Record<string, number> = {};
    activeFiles.forEach((f) => {
      userStorageMap[f.owner_id] = (userStorageMap[f.owner_id] || 0) + Number(f.size_bytes || 0);
    });

    const profileMap = new Map((profiles || []).map((p) => [p.id, p]));

    const topUsers = Object.entries(userStorageMap)
      .map(([userId, usedBytes]) => {
        const prof = profileMap.get(userId);
        return {
          userId,
          email: prof?.email || "Unknown User",
          fullName: prof?.full_name || "CloudVault User",
          usedBytes,
          quotaBytes: prof?.storage_quota_bytes || 5368709120,
        };
      })
      .sort((a, b) => b.usedBytes - a.usedBytes)
      .slice(0, 10);

    res.json({
      success: true,
      storage: {
        totalUsedBytes,
        categories,
        topUsers,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/admin/reports/stats
 * Visual metrics for user growth, storage growth, activity trends
 */
router.get("/reports/stats", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  try {
    const { data: profiles } = await supabase.from("profiles").select("created_at");
    const { data: files } = await supabase.from("files").select("created_at, size_bytes, is_trash");
    const { data: shares } = await supabase.from("shares").select("created_at");

    // Grouping by date string YYYY-MM-DD
    const userGrowth: Record<string, number> = {};
    (profiles || []).forEach((p) => {
      const date = p.created_at ? p.created_at.split("T")[0] : "Unknown";
      userGrowth[date] = (userGrowth[date] || 0) + 1;
    });

    const uploadActivity: Record<string, number> = {};
    const storageGrowth: Record<string, number> = {};
    let runningStorage = 0;

    const sortedFiles = [...(files || [])].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    sortedFiles.forEach((f) => {
      const date = f.created_at ? f.created_at.split("T")[0] : "Unknown";
      uploadActivity[date] = (uploadActivity[date] || 0) + 1;
      runningStorage += Number(f.size_bytes || 0);
      storageGrowth[date] = runningStorage;
    });

    const shareActivity: Record<string, number> = {};
    (shares || []).forEach((s) => {
      const date = s.created_at ? s.created_at.split("T")[0] : "Unknown";
      shareActivity[date] = (shareActivity[date] || 0) + 1;
    });

    const trashedCount = (files || []).filter((f) => f.is_trash).length;

    res.json({
      success: true,
      reports: {
        userGrowth,
        uploadActivity,
        storageGrowth,
        shareActivity,
        trashedCount,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/admin/activity
 * System-level Activity Log Monitoring with Filters
 */
router.get("/activity", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  try {
    const { action, userId, entityType, limit = 50 } = req.query;

    let query = supabase
      .from("activity_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(Number(limit) || 50);

    if (action && typeof action === "string") {
      query = query.eq("action", action);
    }
    if (userId && typeof userId === "string") {
      query = query.eq("user_id", userId);
    }
    if (entityType && typeof entityType === "string") {
      query = query.eq("entity_type", entityType);
    }

    const { data: logs, error } = await query;
    if (error && error.code !== "PGRST116") {
      throw new Error(error.message);
    }

    // Enrich logs with user emails if available
    const { data: profiles } = await supabase.from("profiles").select("id, email, full_name");
    const profMap = new Map((profiles || []).map((p) => [p.id, p]));

    const enrichedLogs = (logs || []).map((log) => {
      const prof = profMap.get(log.user_id);
      return {
        id: log.id,
        userId: log.user_id,
        userEmail: prof?.email || "Unknown User",
        userName: prof?.full_name || "CloudVault User",
        action: log.action,
        entityType: log.entity_type,
        entityName: log.entity_name,
        metadata: log.metadata,
        createdAt: log.created_at,
      };
    });

    res.json({
      success: true,
      logs: enrichedLogs,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/admin/announcements
 * Admin list all announcements
 */
router.get("/announcements", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const list = await fetchAllAnnouncementsAdmin();
    res.json({ success: true, announcements: list });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/admin/announcements
 * Create a system announcement
 */
router.post("/announcements", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { title, message, type = "info", status = "draft", expires_at = null } = req.body;

  if (!title || !message) {
    return res.status(400).json({ success: false, message: "Title and message are required." });
  }

  try {
    const data = await createAnnouncementRecord({
      title,
      message,
      type,
      status,
      expires_at: expires_at || null,
      created_by: req.user!.id,
    });

    await logAdminAudit(req.user!.id, "publish_announcement", data.id, "announcement", { title, type, status });

    res.json({ success: true, announcement: data });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/admin/announcements/:id
 */
router.patch("/announcements/:id", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    const data = await updateAnnouncementRecord(id, updates);
    if (!data) {
      return res.status(404).json({ success: false, message: "Announcement not found." });
    }

    res.json({ success: true, announcement: data });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/admin/announcements/:id
 */
router.delete("/announcements/:id", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const ok = await deleteAnnouncementRecord(id);
    if (!ok) return res.status(400).json({ success: false, message: "Failed to delete announcement." });

    res.json({ success: true, message: "Announcement deleted." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/admin/abuse-reports
 */
router.get("/abuse-reports", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  try {
    const { data: reports, error } = await supabase
      .from("reports")
      .select("*")
      .order("created_at", { ascending: false });

    if (error && error.code !== "PGRST116") {
      return res.json({ success: true, reports: [] });
    }

    res.json({ success: true, reports: reports || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/admin/abuse-reports/:id
 */
router.patch("/abuse-reports/:id", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const { id } = req.params;
  const { status } = req.body; // 'open' | 'reviewing' | 'resolved' | 'rejected'

  if (!status || !["open", "reviewing", "resolved", "rejected"].includes(status)) {
    return res.status(400).json({ success: false, message: "Invalid report status." });
  }

  try {
    const { data, error } = await supabase
      .from("reports")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    await logAdminAudit(req.user!.id, "resolve_report", id, "report", { status });

    res.json({ success: true, report: data });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/admin/audit-logs
 */
router.get("/audit-logs", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  try {
    const { data: logs, error } = await supabase
      .from("admin_audit_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error && error.code !== "PGRST116") {
      return res.json({ success: true, auditLogs: [] });
    }

    res.json({ success: true, auditLogs: logs || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/admin/settings
 */
router.get("/settings", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  try {
    const { data: rows } = await supabase.from("system_settings").select("*");
    const settingsMap: Record<string, any> = {
      default_user_quota_bytes: 5368709120, // 5 GB
      max_upload_size_bytes: 1073741824, // 1 GB
      maintenance_mode: false,
      allow_public_shares: true,
    };

    (rows || []).forEach((row) => {
      settingsMap[row.key] = row.value;
    });

    res.json({ success: true, settings: settingsMap });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/admin/settings
 */
router.patch("/settings", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const settingsUpdates: Record<string, any> = req.body;

  try {
    for (const [key, val] of Object.entries(settingsUpdates)) {
      await supabase.from("system_settings").upsert({
        key,
        value: val,
        updated_at: new Date().toISOString(),
      });
    }

    await logAdminAudit(req.user!.id, "update_settings", null, "settings", settingsUpdates);

    res.json({ success: true, message: "System settings updated successfully." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
