import { Router, Response } from "express";
import { getSupabaseAdminClient } from "../config/supabase.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/authMiddleware.js";
import { fetchActiveAnnouncementsUser } from "../services/announcementsService.js";

const router = Router();

/**
 * GET /api/announcements/active
 * Active published announcements for normal users
 */
router.get("/announcements/active", async (req, res) => {
  try {
    const active = await fetchActiveAnnouncementsUser();
    res.json({ success: true, announcements: active });
  } catch {
    res.json({ success: true, announcements: [] });
  }
});

/**
 * POST /api/reports
 * Submit abuse report for a shared file or folder
 */
router.post("/reports", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });

  const userId = req.user?.id;
  const { fileId, folderId, shareId, reason, details } = req.body;

  if (!reason) {
    return res.status(400).json({ success: false, message: "Reason is required for submitting a report." });
  }

  try {
    const reportData = {
      id: crypto.randomUUID(),
      reported_by: userId || null,
      file_id: fileId || null,
      folder_id: folderId || null,
      share_id: shareId || null,
      reason,
      details: details || null,
      status: "open",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("reports").insert(reportData);

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    res.json({ success: true, message: "Report submitted successfully. Thank you." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/system/settings/public
 * Check system public state (e.g., maintenance mode)
 */
router.get("/system/settings/public", async (req, res) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.json({ success: true, maintenanceMode: false, allowPublicShares: true });
  }

  try {
    const { data: rows } = await supabase.from("system_settings").select("*");
    let maintenanceMode = false;
    let allowPublicShares = true;

    (rows || []).forEach((r) => {
      if (r.key === "maintenance_mode") maintenanceMode = Boolean(r.value);
      if (r.key === "allow_public_shares") allowPublicShares = Boolean(r.value);
    });

    res.json({ success: true, maintenanceMode, allowPublicShares });
  } catch {
    res.json({ success: true, maintenanceMode: false, allowPublicShares: true });
  }
});

export default router;
