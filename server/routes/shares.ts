import { Router, Request, Response } from "express";
import { getSupabaseAdminClient } from "../config/supabase.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/authMiddleware.js";
import crypto from "crypto";
import { sendShareEmail } from "../services/emailService.js";
import {
  hashSharePassword,
  verifySharePassword,
  saveShareProtection,
  getShareProtection,
  deleteShareProtection,
} from "../services/shareProtectionService.js";

const router = Router();

/**
 * POST /api/shares
 * Create a new share record for a file or folder (requires authentication)
 */
router.post("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  const userName = req.user?.email?.split("@")[0] || "Someone";
  const { 
    file_id, 
    folder_id, 
    permission, 
    is_public_link, 
    expires_at,
    password,
    password_enabled 
  } = req.body;

  const rawGrantedEmail = req.body.granted_to_email || req.body.grantedToEmail;
  const granted_to_email = rawGrantedEmail ? String(rawGrantedEmail).trim().toLowerCase() : null;

  if (!file_id && !folder_id) {
    return res.status(400).json({ success: false, message: "Either file_id or folder_id is required." });
  }

  try {
    let itemName = "Item";
    let itemSize = null;

    // Verify user owns the file or folder
    if (file_id) {
      const { data: file, error: fileErr } = await supabase
        .from("files")
        .select("id, owner_id, name, size_bytes")
        .eq("id", file_id)
        .eq("owner_id", userId)
        .single();

      if (fileErr || !file) {
        return res.status(403).json({ success: false, message: "Access denied. File not found or not owned by user." });
      }
      itemName = file.name;
      itemSize = file.size_bytes;
    }

    if (folder_id) {
      const { data: folder, error: folderErr } = await supabase
        .from("folders")
        .select("id, owner_id, name")
        .eq("id", folder_id)
        .eq("owner_id", userId)
        .single();

      if (folderErr || !folder) {
        return res.status(403).json({ success: false, message: "Access denied. Folder not found or not owned by user." });
      }
      itemName = folder.name;
    }

    // Handle password hashing
    let passwordHash: string | null = null;
    const isPasswordEnabled = Boolean(password_enabled && password);
    if (isPasswordEnabled) {
      if (password.length < 6) {
        return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
      }
      passwordHash = await hashSharePassword(password);
    }

    // Generate secure token
    const shareToken = crypto.randomBytes(16).toString("hex");

    // Attempt insert with password fields first; fallback gracefully if schema cache does not have columns
    let share: any = null;
    let shareErr: any = null;

    // 1. Try insert with full fields (if database has columns)
    const fullPayload = {
      owner_id: userId,
      file_id: file_id || null,
      folder_id: folder_id || null,
      granted_to_email: granted_to_email || null,
      permission: permission || "viewer",
      is_public_link: is_public_link !== false,
      share_token: shareToken,
      expires_at: expires_at || null,
      password_hash: passwordHash,
      password_enabled: isPasswordEnabled,
    };

    const tryFull = await supabase.from("shares").insert(fullPayload).select().single();
    
    if (tryFull.error) {
      // If error is about missing password columns in schema cache, fallback to standard schema insert
      if (
        tryFull.error.message.includes("password_enabled") || 
        tryFull.error.message.includes("password_hash") ||
        tryFull.error.message.includes("schema cache")
      ) {
        const standardPayload = {
          owner_id: userId,
          file_id: file_id || null,
          folder_id: folder_id || null,
          granted_to_email: granted_to_email || null,
          permission: permission || "viewer",
          is_public_link: is_public_link !== false,
          share_token: shareToken,
          expires_at: expires_at || null,
        };
        const tryStandard = await supabase.from("shares").insert(standardPayload).select().single();
        share = tryStandard.data;
        shareErr = tryStandard.error;
      } else {
        shareErr = tryFull.error;
      }
    } else {
      share = tryFull.data;
    }

    if (shareErr || !share) {
      return res.status(400).json({ success: false, message: shareErr?.message || "Failed to create share" });
    }

    // Save protection metadata to persistent service (ensures consistency across all layers)
    saveShareProtection(shareToken, share.id, passwordHash, isPasswordEnabled);

    // Format safe response (never return password_hash)
    const safeShare = {
      ...share,
      password_enabled: isPasswordEnabled,
    };
    delete safeShare.password_hash;

    // Handle email sending if recipient email is provided
    let emailSent = false;
    let emailError: string | null = null;
    let emailDetails: any = null;

    if (granted_to_email) {
      console.log(`[Shares] Processing share email notification to: ${granted_to_email} (Share ID: ${share.id}, Token: ${shareToken})`);
      
      // Determine application base URL dynamically from request headers or environment
      const originHeader = req.get("origin") || req.get("referer");
      let appBaseUrl = process.env.APP_URL;
      if (!appBaseUrl && originHeader) {
        try {
          const parsed = new URL(originHeader);
          appBaseUrl = parsed.origin;
        } catch {
          // fallback
        }
      }
      if (!appBaseUrl) {
        const host = req.get("host") || "localhost:3000";
        const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
        appBaseUrl = `${protocol}://${host}`;
      }

      const shareUrl = `${appBaseUrl}/share/${shareToken}`;

      const emailResult = await sendShareEmail({
        recipientEmail: granted_to_email,
        to: granted_to_email,
        senderName: userName,
        senderEmail: req.user?.email,
        fileName: itemName,
        fileSize: itemSize,
        permission: permission === "editor" ? "Editor" : "Viewer",
        expiresAt: expires_at || null,
        shareUrl,
        passwordProtected: isPasswordEnabled,
      });

      emailDetails = {
        accepted: emailResult.accepted || [],
        rejected: emailResult.rejected || [],
        messageId: emailResult.messageId || null,
        response: emailResult.response || null,
      };

      if (emailResult.success) {
        emailSent = true;
        emailError = null;
        console.log(`[Shares] Email dispatched successfully to ${granted_to_email}. MessageId: ${emailResult.messageId}`);
      } else {
        emailSent = false;
        emailError = emailResult.error || "Unable to send sharing email.";
        console.error(`[Shares] Email dispatch failed for ${granted_to_email}: ${emailError}`);
      }
    }

    res.json({ 
      success: true, 
      share: safeShare, 
      emailSent,
      emailError,
      emailDetails,
      message: emailSent 
        ? "Shared successfully and email sent." 
        : (granted_to_email ? "Share created, but email could not be sent." : "Share link created successfully!")
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/shares/my
 * List all shares created by the authenticated user
 */
router.get("/my", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  try {
    const { data: shares, error } = await supabase
      .from("shares")
      .select("*, files(*), folders(*)")
      .eq("owner_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    // Mask password hashes and enrich with password protection status
    const safeShares = (shares || []).map((s: any) => {
      const protection = getShareProtection(s.share_token, s);
      const row = { ...s, password_enabled: protection.passwordEnabled };
      delete row.password_hash;
      return row;
    });

    res.json({ success: true, shares: safeShares });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/shares/shared-with-me
 * List all shares granted to the authenticated user's email
 */
router.get("/shared-with-me", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userEmail = req.user?.email;
  if (!userEmail) {
    return res.json({ success: true, shares: [] });
  }

  try {
    const { data: shares, error } = await supabase
      .from("shares")
      .select("*, files(*), folders(*)")
      .eq("granted_to_email", userEmail)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    // Filter out expired shares
    const now = new Date();
    const activeShares = (shares || [])
      .filter((s) => !s.expires_at || new Date(s.expires_at) > now)
      .map((s) => {
        const protection = getShareProtection(s.share_token, s);
        const row = { ...s, password_enabled: protection.passwordEnabled };
        delete row.password_hash;
        return row;
      });

    res.json({ success: true, shares: activeShares });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/shares/:id
 * Update an existing share permission (Viewer <-> Editor), expiration, or public status
 */
router.patch("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  const shareId = req.params.id;
  const { permission, expires_at, is_public_link } = req.body;

  try {
    const updateData: any = {};
    if (permission) updateData.permission = permission;
    if (expires_at !== undefined) updateData.expires_at = expires_at;
    if (is_public_link !== undefined) updateData.is_public_link = is_public_link;

    const { data: updated, error } = await supabase
      .from("shares")
      .update(updateData)
      .eq("id", shareId)
      .eq("owner_id", userId)
      .select("*, files(*), folders(*)")
      .single();

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    const protection = getShareProtection(updated.share_token, updated);
    const safeShare = { ...updated, password_enabled: protection.passwordEnabled };
    delete safeShare.password_hash;

    res.json({ success: true, share: safeShare, message: "Share updated successfully." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/shares/:id
 * Revoke/delete a share
 */
router.delete("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  const shareId = req.params.id;

  try {
    // Get the share first to know its share_token
    const { data: existing } = await supabase
      .from("shares")
      .select("id, share_token, owner_id")
      .eq("id", shareId)
      .eq("owner_id", userId)
      .single();

    const { error } = await supabase
      .from("shares")
      .delete()
      .eq("id", shareId)
      .eq("owner_id", userId);

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    if (existing?.share_token) {
      deleteShareProtection(existing.share_token);
    }

    res.json({ success: true, message: "Share revoked successfully." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/shares/public/:token
 * Public endpoint to resolve and view a shared file/folder by share token
 */
router.get("/public/:token", async (req: Request, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const token = req.params.token;

  try {
    const { data: share, error } = await supabase
      .from("shares")
      .select("*, files(*), folders(*)")
      .eq("share_token", token)
      .single();

    if (error || !share) {
      return res.status(404).json({ success: false, message: "Invalid or unavailable share link." });
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: "This share link has expired." });
    }

    // Check if password is required
    const protection = getShareProtection(token, share);
    if (protection.passwordEnabled) {
      return res.json({
        success: true,
        passwordRequired: true,
        share: {
          id: share.id,
          shareToken: share.share_token,
          permission: share.permission,
          isPublic: share.is_public_link,
          expiresAt: share.expires_at,
          itemName: share.files?.name || share.folders?.name || "Shared Item",
        }
      });
    }

    let downloadUrl: string | null = null;
    if (share.files?.storage_path) {
      // Generate a signed download URL (valid for 1 hour)
      const { data: signed } = await supabase.storage
        .from("cloudvault-files")
        .createSignedUrl(share.files.storage_path, 3600);
      downloadUrl = signed?.signedUrl || null;
    }

    res.json({
      success: true,
      passwordRequired: false,
      share: {
        id: share.id,
        shareToken: share.share_token,
        permission: share.permission || "viewer",
        isPublic: share.is_public_link,
        expiresAt: share.expires_at,
        file: share.files
          ? {
              id: share.files.id,
              name: share.files.name,
              originalName: share.files.original_name,
              sizeBytes: share.files.size_bytes,
              mimeType: share.files.mime_type,
              category: share.files.category,
              extension: share.files.extension,
              downloadUrl,
              updatedAt: share.files.updated_at,
            }
          : null,
        folder: share.folders
          ? {
              id: share.folders.id,
              name: share.folders.name,
            }
          : null,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/shares/public/:token/unlock
 * Verify password and return share data with download URL
 */
router.post("/public/:token/unlock", async (req: Request, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const token = req.params.token;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ success: false, message: "Password is required." });
  }

  try {
    const { data: share, error } = await supabase
      .from("shares")
      .select("*, files(*), folders(*)")
      .eq("share_token", token)
      .single();

    if (error || !share) {
      return res.status(404).json({ success: false, message: "Invalid or unavailable share link." });
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: "This share link has expired." });
    }

    const protection = getShareProtection(token, share);
    if (!protection.passwordEnabled) {
      return res.status(400).json({ success: false, message: "This share is not password protected." });
    }

    const isMatch = await verifySharePassword(token, password, share);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Incorrect password. Please try again." });
    }

    let downloadUrl: string | null = null;
    if (share.files?.storage_path) {
      const { data: signed } = await supabase.storage
        .from("cloudvault-files")
        .createSignedUrl(share.files.storage_path, 3600);
      downloadUrl = signed?.signedUrl || null;
    }

    res.json({
      success: true,
      share: {
        id: share.id,
        shareToken: share.share_token,
        permission: share.permission || "viewer",
        isPublic: share.is_public_link,
        expiresAt: share.expires_at,
        file: share.files
          ? {
              id: share.files.id,
              name: share.files.name,
              originalName: share.files.original_name,
              sizeBytes: share.files.size_bytes,
              mimeType: share.files.mime_type,
              category: share.files.category,
              extension: share.files.extension,
              downloadUrl,
              updatedAt: share.files.updated_at,
            }
          : null,
        folder: share.folders
          ? {
              id: share.folders.id,
              name: share.folders.name,
            }
          : null,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/shares/public/:token/rename
 * Allows an Editor (verified via share_token) to rename the shared file
 */
router.patch("/public/:token/rename", async (req: Request, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const token = req.params.token;
  const { newName, password } = req.body;

  if (!newName || !newName.trim()) {
    return res.status(400).json({ success: false, message: "New file name is required." });
  }

  try {
    const { data: share, error } = await supabase
      .from("shares")
      .select("*, files(*), folders(*)")
      .eq("share_token", token)
      .single();

    if (error || !share) {
      return res.status(404).json({ success: false, message: "Invalid or unavailable share link." });
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: "This share link has expired." });
    }

    const protection = getShareProtection(token, share);
    if (protection.passwordEnabled) {
      if (!password) {
        return res.status(401).json({ success: false, message: "Password is required to edit this file." });
      }
      const isMatch = await verifySharePassword(token, password, share);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: "Incorrect password. Please try again." });
      }
    }

    if (share.permission !== "editor") {
      return res.status(403).json({ success: false, message: "You do not have permission to edit this file (Viewer only)." });
    }

    if (!share.file_id || !share.files) {
      return res.status(400).json({ success: false, message: "Only files can be renamed." });
    }

    const trimmedName = newName.trim();
    const extension = trimmedName.includes(".") ? trimmedName.split(".").pop() || "" : share.files.extension;

    const { data: updatedFile, error: updateErr } = await supabase
      .from("files")
      .update({
        name: trimmedName,
        original_name: trimmedName,
        extension,
        updated_at: new Date().toISOString(),
      })
      .eq("id", share.file_id)
      .select()
      .single();

    if (updateErr) {
      return res.status(400).json({ success: false, message: updateErr.message });
    }

    // Generate fresh download url if needed
    let downloadUrl: string | null = null;
    if (share.files.storage_path) {
      const { data: signed } = await supabase.storage
        .from("cloudvault-files")
        .createSignedUrl(share.files.storage_path, 3600);
      downloadUrl = signed?.signedUrl || null;
    }

    res.json({
      success: true,
      message: "File renamed successfully.",
      file: {
        id: updatedFile.id,
        name: updatedFile.name,
        originalName: updatedFile.original_name,
        sizeBytes: updatedFile.size_bytes,
        mimeType: updatedFile.mime_type,
        category: updatedFile.category,
        extension: updatedFile.extension,
        downloadUrl,
        updatedAt: updatedFile.updated_at,
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/shares/public/:token/replace
 * Allows an Editor to upload a replacement / updated version of the shared file
 */
router.post("/public/:token/replace", async (req: Request, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const token = req.params.token;
  const { base64Data, fileName, mimeType, sizeBytes, password } = req.body;

  if (!base64Data) {
    return res.status(400).json({ success: false, message: "File content is required." });
  }

  try {
    const { data: share, error } = await supabase
      .from("shares")
      .select("*, files(*)")
      .eq("share_token", token)
      .single();

    if (error || !share) {
      return res.status(404).json({ success: false, message: "Invalid or unavailable share link." });
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: "This share link has expired." });
    }

    const protection = getShareProtection(token, share);
    if (protection.passwordEnabled) {
      if (!password) {
        return res.status(401).json({ success: false, message: "Password is required to edit this file." });
      }
      const isMatch = await verifySharePassword(token, password, share);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: "Incorrect password." });
      }
    }

    if (share.permission !== "editor") {
      return res.status(403).json({ success: false, message: "You do not have permission to edit this file." });
    }

    if (!share.files?.storage_path) {
      return res.status(400).json({ success: false, message: "File storage path not found." });
    }

    const buffer = Buffer.from(base64Data, "base64");
    const { error: uploadErr } = await supabase.storage
      .from("cloudvault-files")
      .upload(share.files.storage_path, buffer, {
        contentType: mimeType || share.files.mime_type || "application/octet-stream",
        upsert: true,
      });

    if (uploadErr) {
      return res.status(500).json({ success: false, message: uploadErr.message });
    }

    const newSize = sizeBytes || buffer.length;
    const newName = fileName || share.files.name;
    const extension = newName.includes(".") ? newName.split(".").pop() || "" : share.files.extension;

    const { data: updatedFile, error: updateErr } = await supabase
      .from("files")
      .update({
        name: newName,
        original_name: newName,
        size_bytes: newSize,
        mime_type: mimeType || share.files.mime_type,
        extension,
        updated_at: new Date().toISOString(),
      })
      .eq("id", share.file_id)
      .select()
      .single();

    if (updateErr) {
      return res.status(400).json({ success: false, message: updateErr.message });
    }

    // Generate fresh download url
    const { data: signed } = await supabase.storage
      .from("cloudvault-files")
      .createSignedUrl(share.files.storage_path, 3600);

    res.json({
      success: true,
      message: "File updated successfully.",
      file: {
        id: updatedFile.id,
        name: updatedFile.name,
        originalName: updatedFile.original_name,
        sizeBytes: updatedFile.size_bytes,
        mimeType: updatedFile.mime_type,
        category: updatedFile.category,
        extension: updatedFile.extension,
        downloadUrl: signed?.signedUrl || null,
        updatedAt: updatedFile.updated_at,
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
