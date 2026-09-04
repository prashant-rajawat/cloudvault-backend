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

    // CHECK FOR EXISTING ACTIVE SHARE (Duplicate Prevention & Clean Upsert)
    let existingQuery = supabase
      .from("shares")
      .select("*")
      .eq("owner_id", userId);

    if (file_id) {
      existingQuery = existingQuery.eq("file_id", file_id);
    } else {
      existingQuery = existingQuery.eq("folder_id", folder_id);
    }

    const isDirectShare = Boolean(granted_to_email);
    const targetPublicStatus = isDirectShare ? false : true;

    if (isDirectShare) {
      existingQuery = existingQuery.ilike("granted_to_email", granted_to_email!);
    } else {
      existingQuery = existingQuery.eq("is_public_link", true).is("granted_to_email", null);
    }

    const { data: existingMatches } = await existingQuery;
    const existingShare = existingMatches && existingMatches.length > 0 ? existingMatches[0] : null;

    // Check duplicate collaborator with identical permission (Requirement 13)
    if (isDirectShare && existingShare) {
      const targetPermission = permission || "viewer";
      const samePerm = existingShare.permission === targetPermission;
      const sameExp = (expires_at || null) === (existingShare.expires_at || null);
      const samePwd = Boolean(password_enabled) === Boolean(existingShare.password_enabled);

      if (samePerm && sameExp && !password) {
        return res.status(409).json({
          success: false,
          errorType: "already_shared",
          message: "This person already has access to this file.",
        });
      }
    }

    let share: any = null;
    let shareErr: any = null;
    let shareToken = existingShare ? existingShare.share_token : crypto.randomBytes(16).toString("hex");

    if (existingShare) {
      // UPDATE EXISTING ACTIVE SHARE WITHOUT GENERATING A NEW TOKEN
      const updatePayload: any = {
        permission: permission || existingShare.permission || "viewer",
        is_public_link: targetPublicStatus,
        expires_at: expires_at !== undefined ? expires_at : existingShare.expires_at,
      };

      const tryUpdate = await supabase
        .from("shares")
        .update(updatePayload)
        .eq("id", existingShare.id)
        .select()
        .single();

      share = tryUpdate.data;
      shareErr = tryUpdate.error;
    } else {
      // 1. Try insert with full fields (if database has columns)
      const fullPayload = {
        owner_id: userId,
        file_id: file_id || null,
        folder_id: folder_id || null,
        granted_to_email: isDirectShare ? granted_to_email : null,
        permission: permission || "viewer",
        is_public_link: targetPublicStatus,
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
            granted_to_email: isDirectShare ? granted_to_email : null,
            permission: permission || "viewer",
            is_public_link: targetPublicStatus,
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
    }

    if (shareErr || !share) {
      return res.status(400).json({ success: false, message: shareErr?.message || "Failed to create share" });
    }

    // Save protection metadata to persistent service (ensures consistency across all layers)
    if (isPasswordEnabled || (existingShare && password_enabled !== undefined)) {
      saveShareProtection(shareToken, share.id, passwordHash, isPasswordEnabled);
    }

    // Format safe response (never return password_hash)
    const currentProtection = getShareProtection(shareToken, share);
    const safeShare = {
      ...share,
      password_enabled: currentProtection.passwordEnabled,
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
        permission: (permission || share.permission) === "editor" ? "Editor" : "Viewer",
        expiresAt: expires_at || share.expires_at || null,
        shareUrl,
        passwordProtected: safeShare.password_enabled,
        resourceType: file_id ? "file" : "folder",
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
      isDuplicateUpdated: Boolean(existingShare),
      message: emailSent 
        ? "Shared successfully and email sent." 
        : (granted_to_email 
            ? (existingShare ? "Collaborator access updated successfully." : "Share created, but email could not be sent.") 
            : "Share link created successfully!")
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
      .ilike("granted_to_email", userEmail)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    // Filter out expired shares and shares whose file or folder is trashed or removed
    const now = new Date();
    const activeShares = (shares || []).filter((s) => {
      // Expiration filter
      if (s.expires_at && new Date(s.expires_at) <= now) return false;
      // Item filter: must have an active file or folder that is not trashed
      if (s.file_id && (!s.files || s.files.is_trash)) return false;
      if (s.folder_id && (!s.folders || s.folders.is_trash)) return false;
      return true;
    });

    // Fetch owner profiles for all unique owner_ids in one single query
    const ownerIds = Array.from(new Set(activeShares.map((s) => s.owner_id).filter(Boolean)));
    const ownerProfilesMap: Record<string, any> = {};
    if (ownerIds.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, email, full_name, avatar_url")
        .in("id", ownerIds);

      (profiles || []).forEach((p) => {
        if (p.id) {
          ownerProfilesMap[p.id] = p;
        }
      });
    }

    const safeShares = activeShares.map((s) => {
      const protection = getShareProtection(s.share_token, s);
      const ownerProfile = ownerProfilesMap[s.owner_id] || null;
      const ownerEmail = ownerProfile?.email || "Unknown Email";
      const ownerName = ownerProfile?.full_name || ownerEmail.split("@")[0] || "Unknown Owner";
      
      const row = {
        ...s,
        password_enabled: protection.passwordEnabled,
        owner: {
          id: s.owner_id,
          email: ownerEmail,
          full_name: ownerName,
          avatar_url: ownerProfile?.avatar_url || null,
        },
      };
      delete row.password_hash;
      return row;
    });

    res.json({ success: true, shares: safeShares });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/shares/shared-with-me/:id
 * Allow a recipient to remove a share from their "Shared with me" view.
 */
router.delete("/shared-with-me/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userEmail = req.user?.email;
  const shareId = req.params.id;

  if (!userEmail) {
    return res.status(401).json({ success: false, message: "Unauthorized: User session required." });
  }

  try {
    const { error } = await supabase
      .from("shares")
      .delete()
      .eq("id", shareId)
      .ilike("granted_to_email", userEmail);

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    res.json({ success: true, message: "Share removed from your Shared with me list." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || "Failed to remove shared item" });
  }
});

/**
 * GET /api/shares/access-list/:type/:id
 * Dedicated Google Drive-style access management endpoint.
 * Returns owner info, list of active collaborators (direct shares), and public link status.
 * Server enforces that only the verified item owner can view and manage access.
 */
router.get("/access-list/:type/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  const userEmail = req.user?.email;
  const { type, id } = req.params;

  if (type !== "file" && type !== "folder") {
    return res.status(400).json({ success: false, message: "Invalid type. Must be 'file' or 'folder'." });
  }

  try {
    let itemName = "Item";

    // 1. Verify item exists and is strictly owned by the authenticated user
    if (type === "file") {
      const { data: file, error: fileErr } = await supabase
        .from("files")
        .select("id, owner_id, name")
        .eq("id", id)
        .single();

      if (fileErr || !file) {
        return res.status(404).json({ success: false, message: "File not found or no longer exists." });
      }
      if (file.owner_id !== userId) {
        return res.status(403).json({ success: false, message: "You don't have permission to manage sharing for this file." });
      }
      itemName = file.name;
    } else {
      const { data: folder, error: folderErr } = await supabase
        .from("folders")
        .select("id, owner_id, name")
        .eq("id", id)
        .single();

      if (folderErr || !folder) {
        return res.status(404).json({ success: false, message: "Folder not found or no longer exists." });
      }
      if (folder.owner_id !== userId) {
        return res.status(403).json({ success: false, message: "You don't have permission to manage sharing for this folder." });
      }
      itemName = folder.name;
    }

    // 2. Fetch owner's user profile details (name, avatar)
    const { data: ownerProfile } = await supabase
      .from("profiles")
      .select("id, email, full_name, avatar_url")
      .eq("id", userId)
      .single();

    const owner = {
      id: userId,
      email: ownerProfile?.email || userEmail || "owner@cloudvault.internal",
      fullName: ownerProfile?.full_name || userEmail?.split("@")[0] || "File Owner",
      avatarUrl: ownerProfile?.avatar_url || null,
      role: "Owner",
    };

    // 3. Fetch all active shares for this specific item
    let sharesQuery = supabase
      .from("shares")
      .select("*")
      .eq("owner_id", userId);

    if (type === "file") {
      sharesQuery = sharesQuery.eq("file_id", id);
    } else {
      sharesQuery = sharesQuery.eq("folder_id", id);
    }

    const { data: shares, error: sharesErr } = await sharesQuery.order("created_at", { ascending: false });

    if (sharesErr) {
      return res.status(400).json({ success: false, message: "Failed to load access list" });
    }

    // 4. Enrich collaborator shares with profile names/avatars
    const collaboratorEmails = (shares || [])
      .map((s: any) => s.granted_to_email?.toLowerCase())
      .filter((email: any): email is string => Boolean(email));

    const profilesMap: Record<string, any> = {};
    if (collaboratorEmails.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, email, full_name, avatar_url")
        .in("email", collaboratorEmails);

      (profiles || []).forEach((p) => {
        if (p.email) {
          profilesMap[p.email.toLowerCase()] = p;
        }
      });
    }

    const now = new Date();
    const collaborators: any[] = [];
    let publicLink: any = null;

    (shares || []).forEach((s: any) => {
      const protection = getShareProtection(s.share_token, s);
      const isExpired = Boolean(s.expires_at && new Date(s.expires_at) < now);

      if (s.granted_to_email && s.granted_to_email.trim() !== "") {
        const emailLower = s.granted_to_email.toLowerCase();
        const p = profilesMap[emailLower];
        collaborators.push({
          id: s.id,
          email: s.granted_to_email,
          fullName: p?.full_name || s.granted_to_email.split("@")[0],
          avatarUrl: p?.avatar_url || null,
          permission: (s.permission || "viewer").toLowerCase(),
          shareToken: s.share_token,
          expiresAt: s.expires_at || null,
          isExpired,
          passwordEnabled: protection.passwordEnabled,
          accessType: "direct",
          createdAt: s.created_at,
        });
      } else if (s.is_public_link) {
        publicLink = {
          id: s.id,
          permission: (s.permission || "viewer").toLowerCase(),
          shareToken: s.share_token,
          expiresAt: s.expires_at || null,
          isExpired,
          passwordEnabled: protection.passwordEnabled,
          accessType: "public",
          createdAt: s.created_at,
        };
      }
    });

    res.json({
      success: true,
      itemName,
      owner,
      collaborators,
      publicLink,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || "Failed to load access list" });
  }
});

/**
 * PATCH /api/shares/:id
 * Update an existing share permission (Viewer <-> Editor), expiration, or public status.
 * Server strictly verifies owner_id to prevent unauthorized collaborator changes.
 */
router.patch("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  const shareId = req.params.id;
  const { permission, expires_at, is_public_link, password_enabled, password } = req.body;

  try {
    // 1. Verify existence and ownership
    const { data: existing, error: existErr } = await supabase
      .from("shares")
      .select("id, owner_id, share_token, permission, expires_at")
      .eq("id", shareId)
      .single();

    if (existErr || !existing) {
      return res.status(404).json({ success: false, message: "Share record not found or no longer exists." });
    }

    if (existing.owner_id !== userId) {
      return res.status(403).json({ success: false, message: "You don't have permission to modify this share." });
    }

    const updateData: any = {};
    if (permission) {
      const cleanPerm = String(permission).toLowerCase();
      if (cleanPerm !== "viewer" && cleanPerm !== "editor") {
        return res.status(400).json({ success: false, message: "Permission must be 'viewer' or 'editor'." });
      }
      updateData.permission = cleanPerm;
    }
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

    // Handle password protection update if specified
    let currentPasswordEnabled = false;
    if (password_enabled !== undefined) {
      if (password_enabled && password) {
        if (password.length < 6) {
          return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
        }
        const pwdHash = await hashSharePassword(password);
        saveShareProtection(existing.share_token, shareId, pwdHash, true);
        currentPasswordEnabled = true;
      } else if (!password_enabled) {
        saveShareProtection(existing.share_token, shareId, null, false);
        currentPasswordEnabled = false;
      }
    } else {
      const prot = getShareProtection(existing.share_token, updated);
      currentPasswordEnabled = prot.passwordEnabled;
    }

    const safeShare = { ...updated, password_enabled: currentPasswordEnabled };
    delete safeShare.password_hash;

    res.json({ success: true, share: safeShare, message: "Share permission updated successfully." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || "Failed to update share permission" });
  }
});

/**
 * DELETE /api/shares/:id
 * Revoke/delete a share. Server strictly verifies owner_id.
 */
router.delete("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  const shareId = req.params.id;

  try {
    // Get the share first to confirm ownership and extract token
    const { data: existing, error: findErr } = await supabase
      .from("shares")
      .select("id, share_token, owner_id")
      .eq("id", shareId)
      .single();

    if (findErr || !existing) {
      return res.status(404).json({ success: false, message: "This access permission no longer exists." });
    }

    if (existing.owner_id !== userId) {
      return res.status(403).json({ success: false, message: "You don't have permission to remove this share." });
    }

    const { error } = await supabase
      .from("shares")
      .delete()
      .eq("id", shareId)
      .eq("owner_id", userId);

    if (error) {
      return res.status(400).json({ success: false, message: "Unable to remove access. Please try again." });
    }

    if (existing?.share_token) {
      deleteShareProtection(existing.share_token);
    }

    res.json({ success: true, message: "Access removed successfully." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || "Unable to remove access. Please try again." });
  }
});

/**
 * POST /api/shares/:id/resend
 * Resend the sharing notification email for an existing share.
 * Strictly verifies ownership of the share.
 */
router.post("/:id/resend", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  const shareId = req.params.id;

  try {
    // 1. Get the share record and verify ownership
    const { data: share, error: findErr } = await supabase
      .from("shares")
      .select("*")
      .eq("id", shareId)
      .single();

    if (findErr || !share) {
      return res.status(404).json({ success: false, message: "Share record not found." });
    }

    if (share.owner_id !== userId) {
      return res.status(403).json({ success: false, message: "You don't have permission to resend this invitation." });
    }

    if (!share.granted_to_email) {
      return res.status(400).json({ success: false, message: "Cannot send emails for general public links." });
    }

    // 2. Fetch sender name/profile
    let userName = req.user?.email || "A CloudVault User";
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", userId)
      .single();
    if (profile?.full_name) {
      userName = profile.full_name;
    }

    // 3. Resolve item details
    let itemName = "";
    let itemSize: number | null = null;

    if (share.file_id) {
      const { data: file } = await supabase
        .from("files")
        .select("name, size_bytes")
        .eq("id", share.file_id)
        .single();
      if (file) {
        itemName = file.name;
        itemSize = file.size_bytes;
      }
    } else if (share.folder_id) {
      const { data: folder } = await supabase
        .from("folders")
        .select("name")
        .eq("id", share.folder_id)
        .single();
      if (folder) {
        itemName = folder.name;
      }
    }

    if (!itemName) {
      return res.status(404).json({ success: false, message: "The shared file or folder could not be found." });
    }

    // 4. Build application base URL
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

    const shareUrl = `${appBaseUrl}/share/${share.share_token}`;
    const protection = getShareProtection(share.share_token, share);

    // 5. Send Email
    const emailResult = await sendShareEmail({
      recipientEmail: share.granted_to_email,
      to: share.granted_to_email,
      senderName: userName,
      senderEmail: req.user?.email,
      fileName: itemName,
      fileSize: itemSize,
      permission: share.permission === "editor" ? "Editor" : "Viewer",
      expiresAt: share.expires_at || null,
      shareUrl,
      passwordProtected: protection.passwordEnabled,
      resourceType: share.file_id ? "file" : "folder",
    });

    if (emailResult.success) {
      res.json({
        success: true,
        message: `Sharing invitation email resent successfully to ${share.granted_to_email}.`,
      });
    } else {
      res.status(500).json({
        success: false,
        message: emailResult.error || "Unable to send sharing email.",
      });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || "Failed to resend invitation." });
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
      return res.status(404).json({
        success: false,
        errorType: "not_found",
        message: "This share link is invalid or has been revoked by the owner."
      });
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({
        success: false,
        errorType: "expired",
        message: "This share link has expired and is no longer available."
      });
    }

    if (share.file_id && (!share.files || share.files.is_trash)) {
      return res.status(404).json({
        success: false,
        errorType: "file_deleted",
        message: "The shared file has been moved to Trash or is no longer available."
      });
    }

    if (share.folder_id && (!share.folders || share.folders.is_trash)) {
      return res.status(404).json({
        success: false,
        errorType: "folder_deleted",
        message: "The shared folder has been moved to Trash or is no longer available."
      });
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
      return res.status(404).json({
        success: false,
        errorType: "not_found",
        message: "This share link is invalid or has been revoked by the owner."
      });
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({
        success: false,
        errorType: "expired",
        message: "This share link has expired and is no longer available."
      });
    }

    if (share.file_id && (!share.files || share.files.is_trash)) {
      return res.status(404).json({
        success: false,
        errorType: "file_deleted",
        message: "The shared file has been moved to Trash or is no longer available."
      });
    }

    if (share.folder_id && (!share.folders || share.folders.is_trash)) {
      return res.status(404).json({
        success: false,
        errorType: "folder_deleted",
        message: "The shared folder has been moved to Trash or is no longer available."
      });
    }

    const protection = getShareProtection(token, share);
    if (!protection.passwordEnabled) {
      return res.status(400).json({ success: false, message: "This share is not password protected." });
    }

    const isMatch = await verifySharePassword(token, password, share);
    if (!isMatch) {
      return res.status(401).json({ success: false, errorType: "wrong_password", message: "Incorrect password. Please try again." });
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
      return res.status(404).json({
        success: false,
        errorType: "not_found",
        message: "This share link is invalid or has been revoked by the owner."
      });
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({
        success: false,
        errorType: "expired",
        message: "This share link has expired and is no longer available."
      });
    }

    if (share.file_id && (!share.files || share.files.is_trash)) {
      return res.status(404).json({
        success: false,
        errorType: "file_deleted",
        message: "The shared file has been moved to Trash or is no longer available."
      });
    }

    if (share.folder_id && (!share.folders || share.folders.is_trash)) {
      return res.status(404).json({
        success: false,
        errorType: "folder_deleted",
        message: "The shared folder has been moved to Trash or is no longer available."
      });
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
      return res.status(403).json({ success: false, message: "You don't have permission to perform this action (Viewer only)." });
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
      return res.status(404).json({
        success: false,
        errorType: "not_found",
        message: "This share link is invalid or has been revoked by the owner."
      });
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({
        success: false,
        errorType: "expired",
        message: "This share link has expired and is no longer available."
      });
    }

    if (share.file_id && (!share.files || share.files.is_trash)) {
      return res.status(404).json({
        success: false,
        errorType: "file_deleted",
        message: "The shared file has been moved to Trash or is no longer available."
      });
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
      return res.status(403).json({ success: false, message: "You don't have permission to perform this action (Viewer only)." });
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

/**
 * GET /api/shares/public/:token/text
 * Allows viewing/loading text content for document/code files
 */
router.get("/public/:token/text", async (req: Request, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const token = req.params.token;
  const password = req.query.password as string | undefined;

  try {
    const { data: share, error } = await supabase
      .from("shares")
      .select("*, files(*)")
      .eq("share_token", token)
      .single();

    if (error || !share || !share.files) {
      return res.status(404).json({ success: false, message: "Share or file not found." });
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: "This share link has expired." });
    }

    const protection = getShareProtection(token, share);
    if (protection.passwordEnabled) {
      if (!password) {
        return res.status(401).json({ success: false, message: "Password required." });
      }
      const isMatch = await verifySharePassword(token, password, share);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: "Incorrect password." });
      }
    }

    if (!share.files.storage_path) {
      return res.status(400).json({ success: false, message: "File storage path not found." });
    }

    const { data: fileData, error: downloadErr } = await supabase.storage
      .from("cloudvault-files")
      .download(share.files.storage_path);

    if (downloadErr || !fileData) {
      return res.status(500).json({ success: false, message: downloadErr?.message || "Failed to download file content." });
    }

    const textContent = await fileData.text();
    res.json({ success: true, content: textContent });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PUT /api/shares/public/:token/text
 * Allows an Editor to save text content changes directly
 */
router.put("/public/:token/text", async (req: Request, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const token = req.params.token;
  const { content, password } = req.body;

  if (content === undefined) {
    return res.status(400).json({ success: false, message: "Content is required." });
  }

  try {
    const { data: share, error } = await supabase
      .from("shares")
      .select("*, files(*)")
      .eq("share_token", token)
      .single();

    if (error || !share || !share.files) {
      return res.status(404).json({ success: false, message: "Share or file not found." });
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: "This share link has expired." });
    }

    const protection = getShareProtection(token, share);
    if (protection.passwordEnabled) {
      if (!password) {
        return res.status(401).json({ success: false, message: "Password required." });
      }
      const isMatch = await verifySharePassword(token, password, share);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: "Incorrect password." });
      }
    }

    if (share.permission !== "editor") {
      return res.status(403).json({ success: false, message: "You don't have permission to perform this action (Viewer only)." });
    }

    if (!share.files.storage_path) {
      return res.status(400).json({ success: false, message: "File storage path not found." });
    }

    const buffer = Buffer.from(content, "utf-8");
    const { error: uploadErr } = await supabase.storage
      .from("cloudvault-files")
      .upload(share.files.storage_path, buffer, {
        contentType: share.files.mime_type || "text/plain",
        upsert: true,
      });

    if (uploadErr) {
      return res.status(500).json({ success: false, message: uploadErr.message });
    }

    const { data: updatedFile, error: updateErr } = await supabase
      .from("files")
      .update({
        size_bytes: buffer.length,
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
      message: "File saved successfully.",
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
