import { Router, Response } from "express";
import { getSupabaseAdminClient, getSupabaseAnonClient } from "../config/supabase.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/authMiddleware.js";
import { deleteUserAccountAndData } from "../services/userDeletionService.js";
import { DEFAULT_STORAGE_QUOTA_BYTES } from "../config/constants.js";

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

    // Default to 15 GB quota if not set or if legacy 5 GB default was present
    const quotaBytes = (!profile?.storage_quota_bytes || profile.storage_quota_bytes === 5368709120)
      ? DEFAULT_STORAGE_QUOTA_BYTES
      : profile.storage_quota_bytes;

    const resolvedProfile = profile ? {
      ...profile,
      storage_quota_bytes: quotaBytes,
    } : {
      id: userId,
      email: req.user?.email || "",
      full_name: req.user?.email?.split("@")[0] || "User",
      avatar_url: null,
      role: req.user?.role || "user",
      status: "active",
      storage_quota_bytes: DEFAULT_STORAGE_QUOTA_BYTES,
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
 * Safely deletes user's Storage objects, DB records, share tokens, and Supabase Auth account
 */
router.post("/delete-account", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  const userEmail = req.user?.email;
  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized: User session invalid." });
  }

  const { confirmText, password } = req.body || {};

  // Require explicit DELETE confirmation string
  if (confirmText !== "DELETE") {
    return res.status(400).json({
      success: false,
      message: 'Confirmation word "DELETE" is required to delete your account.',
    });
  }

  // Secure re-authentication check if password is provided
  if (password && userEmail) {
    const { error: authCheckErr } = await supabase.auth.signInWithPassword({
      email: userEmail,
      password: password,
    });
    if (authCheckErr) {
      return res.status(401).json({
        success: false,
        message: "Re-authentication failed: Invalid account password.",
      });
    }
  }

  try {
    // 1. Invalidate active sessions globally for this user
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
    if (token) {
      await supabase.auth.admin.signOut(token, "global").catch(() => {});
    }

    // 2. Perform complete storage, db records, and auth deletion
    const result = await deleteUserAccountAndData(userId, userEmail);

    res.json({
      success: true,
      message: result.message || "Your CloudVault account and all associated data have been permanently deleted.",
    });
  } catch (err: any) {
    console.error("[DeleteAccountRoute] Account deletion failed:", err);
    res.status(500).json({
      success: false,
      message: err.message || "An unexpected error occurred while deleting your account. Please try again.",
    });
  }
});

/**
 * POST /api/auth/logout-all-devices
 * Invalidates all authentication sessions and tokens globally for the authenticated user.
 */
router.post("/logout-all-devices", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication token required." });
  }

  try {
    // Revoke all active sessions globally for this user on Supabase Auth server
    const { error } = await supabase.auth.admin.signOut(token, "global");

    if (error) {
      console.error("Global logout error:", error.message);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to sign out of all devices.",
      });
    }

    res.json({
      success: true,
      message: "You've been logged out of all devices.",
    });
  } catch (err: any) {
    console.error("Logout all devices exception:", err);
    res.status(500).json({
      success: false,
      message: err.message || "An error occurred while logging out of all devices.",
    });
  }
});

/**
 * GET /api/auth/avatar/:userId
 * Serves the user avatar securely from Supabase storage
 */
router.get("/avatar/:userId", async (req, res) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const { userId } = req.params;
  if (!userId) {
    return res.status(400).json({ success: false, message: "userId is required." });
  }

  try {
    const { data: files, error: listErr } = await supabase.storage
      .from("cloudvault-files")
      .list(`${userId}/avatars`);

    if (listErr || !files || files.length === 0) {
      return res.status(404).json({ success: false, message: "Avatar not found." });
    }

    // Sort by created_at / last_accessed_at descending to pick latest
    const latestFile = files.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())[0];
    const storagePath = `${userId}/avatars/${latestFile.name}`;

    const { data: fileData, error: downloadErr } = await supabase.storage
      .from("cloudvault-files")
      .download(storagePath);

    if (downloadErr || !fileData) {
      return res.status(404).json({ success: false, message: "Avatar file not found in storage." });
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = latestFile.metadata?.mimetype || (latestFile.name.endsWith(".png") ? "image/png" : latestFile.name.endsWith(".webp") ? "image/webp" : latestFile.name.endsWith(".gif") ? "image/gif" : "image/jpeg");

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || "Error serving avatar." });
  }
});

/**
 * PATCH /api/auth/profile
 * Updates user display name and profile details safely with server-side validation & authorization
 */
router.patch("/profile", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }

  const { fullName, avatarUrl, removeAvatar } = req.body;

  try {
    const updatePayload: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (fullName !== undefined) {
      const trimmedName = String(fullName).trim();
      if (!trimmedName || trimmedName.length < 2) {
        return res.status(400).json({ success: false, message: "Full name must be at least 2 characters long." });
      }
      if (trimmedName.length > 50) {
        return res.status(400).json({ success: false, message: "Full name cannot exceed 50 characters." });
      }
      updatePayload.full_name = trimmedName;

      // Also update auth user metadata if possible
      await supabase.auth.admin.updateUserById(userId, {
        user_metadata: { full_name: trimmedName },
      }).catch(() => {});
    }

    if (removeAvatar === true) {
      updatePayload.avatar_url = null;
      // Cleanup existing avatar files from storage
      const { data: existingFiles } = await supabase.storage
        .from("cloudvault-files")
        .list(`${userId}/avatars`);

      if (existingFiles && existingFiles.length > 0) {
        const paths = existingFiles.map((f) => `${userId}/avatars/${f.name}`);
        await supabase.storage.from("cloudvault-files").remove(paths).catch(() => {});
      }
    } else if (avatarUrl !== undefined) {
      updatePayload.avatar_url = avatarUrl ? String(avatarUrl).trim() : null;
    }

    const { data: updatedProfile, error } = await supabase
      .from("profiles")
      .update(updatePayload)
      .eq("id", userId)
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      message: "Profile updated successfully.",
      profile: updatedProfile,
    });
  } catch (err: any) {
    console.error("Profile update error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to update profile." });
  }
});

/**
 * POST /api/auth/avatar
 * Securely uploads, validates, and stores user avatar in Supabase Storage with old avatar cleanup
 */
router.post("/avatar", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }

  const { avatarData, mimeType: providedMime, fileName } = req.body;

  if (!avatarData || typeof avatarData !== "string") {
    return res.status(400).json({ success: false, message: "Avatar image data is required." });
  }

  try {
    // 1. Extract base64 and mime type
    let mimeType = providedMime || "image/png";
    let base64String = avatarData;

    if (avatarData.startsWith("data:")) {
      const parts = avatarData.split(",");
      const match = parts[0].match(/data:(.*?);base64/);
      if (match && match[1]) {
        mimeType = match[1];
      }
      base64String = parts[1] || "";
    }

    // 2. Validate MIME Type
    const validMimes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
    if (!validMimes.includes(mimeType.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: "Invalid file type. Please upload a JPEG, PNG, WEBP, or GIF image.",
      });
    }

    // 3. Decode base64 buffer and validate size (Max 5MB = 5,242,880 bytes)
    const imageBuffer = Buffer.from(base64String, "base64");
    const maxSizeBytes = 5 * 1024 * 1024;

    if (imageBuffer.length > maxSizeBytes) {
      return res.status(400).json({
        success: false,
        message: "Image size exceeds the 5MB limit. Please choose a smaller image.",
      });
    }

    // 4. Cleanup old avatar files so unused files do not accumulate in storage
    const { data: existingFiles } = await supabase.storage
      .from("cloudvault-files")
      .list(`${userId}/avatars`);

    if (existingFiles && existingFiles.length > 0) {
      const pathsToDelete = existingFiles.map((f) => `${userId}/avatars/${f.name}`);
      await supabase.storage.from("cloudvault-files").remove(pathsToDelete).catch(() => {});
    }

    // 5. Determine file extension
    let ext = "png";
    if (mimeType.includes("jpeg") || mimeType.includes("jpg")) ext = "jpg";
    else if (mimeType.includes("webp")) ext = "webp";
    else if (mimeType.includes("gif")) ext = "gif";
    else if (fileName && fileName.includes(".")) ext = fileName.split(".").pop() || "png";

    const newPath = `${userId}/avatars/avatar-${Date.now()}.${ext}`;

    // 6. Upload new avatar buffer to storage
    const { error: uploadErr } = await supabase.storage
      .from("cloudvault-files")
      .upload(newPath, imageBuffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadErr) {
      console.error("Avatar storage upload error:", uploadErr);
      return res.status(500).json({ success: false, message: uploadErr.message || "Failed to upload avatar image to storage." });
    }

    // 7. Format server avatar endpoint URL
    const avatarUrl = `/api/auth/avatar/${userId}?t=${Date.now()}`;

    // 8. Update profiles DB record
    const { data: updatedProfile, error: dbErr } = await supabase
      .from("profiles")
      .update({
        avatar_url: avatarUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId)
      .select("*")
      .single();

    if (dbErr) {
      throw dbErr;
    }

    res.json({
      success: true,
      message: "Avatar uploaded successfully.",
      avatarUrl,
      profile: updatedProfile,
    });
  } catch (err: any) {
    console.error("Avatar upload exception:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to upload avatar." });
  }
});

// =============================================================================
// CloudVault - Production Registration & Email Verification API
// =============================================================================

import { sendVerificationOtpEmail, sendPasswordResetEmail } from "../services/emailService.js";
import { getSupabaseServerClient } from "../config/supabase.js";

interface OtpRegistrationState {
  email: string;
  fullName: string;
  lastSentAt: number;
  expiresAt: number;
  otpLength: number;
}

const otpRegistrationStore = new Map<string, OtpRegistrationState>();

/**
 * Common weak password blacklist
 */
const WEAK_PASSWORDS = new Set([
  "12345678",
  "123456789",
  "1234567890",
  "password",
  "password1",
  "password123",
  "Password123",
  "Password123!",
  "qwerty123",
  "admin123",
  "welcome123",
  "cloudvault123",
  "iloveyou",
  "letmein123",
  "sunshine",
]);

/**
 * Mask an email safely for UI display (e.g. user@example.com -> u***@example.com)
 */
function maskEmailAddress(email: string): string {
  const parts = email.split("@");
  if (parts.length !== 2) return email;
  const [local, domain] = parts;
  if (local.length <= 2) {
    return `${local[0]}***@${domain}`;
  }
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/**
 * Validates registration input fields strictly server-side
 */
function validateRegistrationPayload(data: any): { valid: boolean; message: string; field?: string; normalizedName: string; normalizedEmail: string } {
  let { fullName, email, password, confirmPassword, acceptTerms } = data || {};

  // 1. Full Name Validation
  if (!fullName || typeof fullName !== "string") {
    return { valid: false, message: "Please enter a valid full name.", field: "fullName", normalizedName: "", normalizedEmail: "" };
  }

  // Trim leading/trailing whitespace & collapse duplicate spaces
  const normalizedName = fullName.trim().replace(/\s+/g, " ");

  if (normalizedName.length < 2 || normalizedName.length > 100) {
    return { valid: false, message: "Please enter a valid full name.", field: "fullName", normalizedName, normalizedEmail: "" };
  }

  // Must contain alphabetic characters
  if (!/[a-zA-Z]/.test(normalizedName)) {
    return { valid: false, message: "Please enter a valid full name.", field: "fullName", normalizedName, normalizedEmail: "" };
  }

  // Allow alphabetic characters, spaces, hyphens, apostrophes only. Disallow numbers and arbitrary symbols.
  if (!/^[a-zA-Z\s'-]+$/.test(normalizedName) || /\d/.test(normalizedName)) {
    return { valid: false, message: "Please enter a valid full name.", field: "fullName", normalizedName, normalizedEmail: "" };
  }

  // 2. Email Validation
  if (!email || typeof email !== "string") {
    return { valid: false, message: "Please enter a valid email address.", field: "email", normalizedName, normalizedEmail: "" };
  }

  const normalizedEmail = email.trim().toLowerCase();

  // No spaces inside email
  if (/\s/.test(normalizedEmail)) {
    return { valid: false, message: "Please enter a valid email address.", field: "email", normalizedName, normalizedEmail: "" };
  }

  // RFC-compliant email regex
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!emailRegex.test(normalizedEmail) || normalizedEmail.length > 254) {
    return { valid: false, message: "Please enter a valid email address.", field: "email", normalizedName, normalizedEmail: "" };
  }

  // 3. Password Validation
  if (!password || typeof password !== "string") {
    return { valid: false, message: "Password is required.", field: "password", normalizedName, normalizedEmail };
  }

  if (password.length < 8) {
    return { valid: false, message: "Password must be at least 8 characters long.", field: "password", normalizedName, normalizedEmail };
  }

  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: "Password must contain at least one uppercase letter.", field: "password", normalizedName, normalizedEmail };
  }

  if (!/[a-z]/.test(password)) {
    return { valid: false, message: "Password must contain at least one lowercase letter.", field: "password", normalizedName, normalizedEmail };
  }

  if (!/[0-9]/.test(password)) {
    return { valid: false, message: "Password must contain at least one number.", field: "password", normalizedName, normalizedEmail };
  }

  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
    return { valid: false, message: "Password must contain at least one special character.", field: "password", normalizedName, normalizedEmail };
  }

  // Password must not match email or local part
  const emailLocal = normalizedEmail.split("@")[0];
  if (password.toLowerCase() === normalizedEmail || password.toLowerCase() === emailLocal) {
    return { valid: false, message: "Password cannot match your email address.", field: "password", normalizedName, normalizedEmail };
  }

  // Password must not match full name
  if (password.toLowerCase() === normalizedName.toLowerCase()) {
    return { valid: false, message: "Password cannot match your name.", field: "password", normalizedName, normalizedEmail };
  }

  // Password must not be obviously weak
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    return { valid: false, message: "This password is too common. Please choose a stronger password.", field: "password", normalizedName, normalizedEmail };
  }

  // 4. Confirm Password
  if (confirmPassword !== undefined && password !== confirmPassword) {
    return { valid: false, message: "Passwords do not match.", field: "confirmPassword", normalizedName, normalizedEmail };
  }

  // 5. Terms of Service
  if (acceptTerms !== undefined && acceptTerms !== true && acceptTerms !== "true") {
    return { valid: false, message: "Please accept the Terms of Service and Privacy Policy to continue.", field: "acceptTerms", normalizedName, normalizedEmail };
  }

  return { valid: true, message: "Validation passed", normalizedName, normalizedEmail };
}

/**
 * POST /api/auth/validate-signup (or /api/auth/validate-register)
 * Validates registration fields without modifying system state
 */
router.post(["/validate-signup", "/validate-register"], (req, res) => {
  const result = validateRegistrationPayload(req.body);
  if (!result.valid) {
    return res.status(400).json({ success: false, message: result.message, field: result.field });
  }
  res.json({ success: true, message: "Validation passed", normalizedName: result.normalizedName, normalizedEmail: result.normalizedEmail });
});

/**
 * POST /api/auth/login (and /api/auth/signin)
 * Server-side authentication endpoint that verifies credentials with Supabase.
 * Acts as a reliable bridge when browser-direct auth needs server fallback.
 */
router.post(["/login", "/signin"], async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || typeof email !== "string" || !password || typeof password !== "string") {
    return res.status(400).json({
      success: false,
      message: "Email and password are required.",
    });
  }

  const cleanEmail = email.trim().toLowerCase();
  const supabase = getSupabaseAnonClient() || getSupabaseAdminClient();

  if (!supabase) {
    return res.status(503).json({
      success: false,
      message: "Authentication service is currently unavailable. Please verify environment settings.",
    });
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: cleanEmail,
      password,
    });

    if (error) {
      const msg = error.message || "Failed to sign in.";
      const lower = msg.toLowerCase();
      if (lower.includes("invalid login credentials") || lower.includes("invalid grant")) {
        return res.status(401).json({
          success: false,
          message: "Incorrect email or password. Please check your credentials.",
        });
      }
      if (lower.includes("email not confirmed") || lower.includes("email_not_confirmed")) {
        return res.status(403).json({
          success: false,
          isEmailUnconfirmed: true,
          message: "Email verification required: We've sent a verification code to your email. Please verify your email before continuing.",
        });
      }
      return res.status(401).json({
        success: false,
        message: msg,
      });
    }

    if (!data.user) {
      return res.status(401).json({
        success: false,
        message: "Sign in failed. No user found.",
      });
    }

    const isConfirmed = Boolean(data.user.email_confirmed_at || (data.user as any).confirmed_at);
    if (!isConfirmed) {
      return res.status(403).json({
        success: false,
        isEmailUnconfirmed: true,
        message: "Email verification required: We've sent a verification code to your email. Please verify your email before continuing.",
      });
    }

    return res.json({
      success: true,
      session: data.session,
      user: {
        id: data.user.id,
        email: data.user.email,
        email_confirmed_at: data.user.email_confirmed_at || (data.user as any).confirmed_at,
        user_metadata: data.user.user_metadata,
      },
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      message: err?.message || "Internal server error during authentication.",
    });
  }
});

/**
 * POST /api/auth/register (or /api/auth/signup)
 * Production signup endpoint:
 * 1. Validates all registration inputs server-side
 * 2. Checks for existing user accounts safely
 * 3. Creates unverified Supabase auth account (email_confirm: false)
 * 4. Generates real Supabase verification OTP & token
 * 5. Dispatches verification code to recipient inbox via SMTP
 * 6. Sets countdown and cooldown protections
 */
router.post(["/register", "/signup"], async (req, res) => {
  const validation = validateRegistrationPayload(req.body);
  if (!validation.valid) {
    return res.status(400).json({
      success: false,
      message: validation.message,
      field: validation.field,
    });
  }

  const { normalizedName, normalizedEmail } = validation;
  const { password } = req.body;

  const supabaseAdmin = getSupabaseAdminClient();
  if (!supabaseAdmin) {
    return res.status(500).json({
      success: false,
      message: "Supabase backend service is unavailable. Please check system configuration.",
    });
  }

  try {
    // 1. Check if user already exists in profiles table
    const { data: existingProfile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (existingProfile) {
      return res.status(409).json({
        success: false,
        isAlreadyRegistered: true,
        message: "An account may already exist with this email. Try signing in or resetting your password.",
      });
    }

    // 2. Check auth.users via admin listUsers
    const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingAuthUser = (authUsers?.users || []).find(
      (u: any) => u.email?.toLowerCase() === normalizedEmail
    );

    let targetUserId = existingAuthUser?.id;

    if (existingAuthUser) {
      // If user exists and email is already confirmed, prompt them to sign in
      if (existingAuthUser.email_confirmed_at) {
        return res.status(409).json({
          success: false,
          isAlreadyRegistered: true,
          message: "An account may already exist with this email. Try signing in or resetting your password.",
        });
      }
      // If user exists but is unconfirmed, update password and metadata to allow re-verification
      await supabaseAdmin.auth.admin.updateUserById(existingAuthUser.id, {
        password,
        user_metadata: {
          full_name: normalizedName,
          email_verified: false,
        },
      });
    } else {
      // Create new unconfirmed user in Supabase Auth
      const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: false,
        user_metadata: {
          full_name: normalizedName,
          email_verified: false,
        },
      });

      if (createErr) {
        if (
          createErr.message.toLowerCase().includes("already registered") ||
          createErr.message.toLowerCase().includes("already exists") ||
          createErr.message.toLowerCase().includes("user_already_exists")
        ) {
          return res.status(409).json({
            success: false,
            isAlreadyRegistered: true,
            message: "An account may already exist with this email. Try signing in or resetting your password.",
          });
        }
        throw createErr;
      }

      targetUserId = newUser.user?.id;
    }

    // 3. Generate authentic Supabase signup verification link and email OTP
    const linkRes = await supabaseAdmin.auth.admin.generateLink({
      type: "signup",
      email: normalizedEmail,
      password,
    });

    const emailOtp = linkRes.data?.properties?.email_otp || "";
    const actionLink = linkRes.data?.properties?.action_link || "";

    if (!emailOtp) {
      console.warn("[Register] Supabase generateLink did not return email_otp; checking link properties:", linkRes.data?.properties);
    }

    // 4. Send official verification email using platform SMTP
    const origin = `${req.protocol}://${req.get("host")}`;
    const directVerifyUrl = `${origin}/verify-email?token=${encodeURIComponent(emailOtp)}&email=${encodeURIComponent(normalizedEmail)}`;

    const emailResult = await sendVerificationOtpEmail({
      recipientEmail: normalizedEmail,
      fullName: normalizedName,
      otpCode: emailOtp,
      verificationLink: directVerifyUrl,
      expiresInMinutes: 5,
    });

    if (!emailResult.success) {
      console.error("[Register] Failed to dispatch verification email:", emailResult.error);
    }

    // 5. Store OTP session state with 5-minute expiry and 60-second cooldown
    const now = Date.now();
    const otpLength = emailOtp ? emailOtp.length : 6;
    otpRegistrationStore.set(normalizedEmail, {
      email: normalizedEmail,
      fullName: normalizedName,
      lastSentAt: now,
      expiresAt: now + 5 * 60 * 1000,
      otpLength,
    });

    res.json({
      success: true,
      message: "Account created. Please verify your email address to continue.",
      email: normalizedEmail,
      maskedEmail: maskEmailAddress(normalizedEmail),
      otpLength,
      expiresInSeconds: 300,
    });
  } catch (err: any) {
    console.error("[Register] Exception during registration:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to create account. Please try again.",
    });
  }
});

/**
 * POST /api/auth/verify-email-otp
 * Validates the email OTP against Supabase Auth:
 * 1. Checks expiry and format constraints
 * 2. Calls Supabase verifyOtp
 * 3. Confirms user email in Supabase and activates profile record
 * 4. Issues fresh authenticated session
 */
router.post("/verify-email-otp", async (req, res) => {
  const { email, token } = req.body;

  if (!email || typeof email !== "string" || !token || typeof token !== "string") {
    return res.status(400).json({
      success: false,
      message: "Email address and verification code are required.",
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const cleanToken = token.trim();

  // Reject non-numeric codes
  if (!/^\d+$/.test(cleanToken)) {
    return res.status(400).json({
      success: false,
      message: "Verification code must contain digits only.",
    });
  }

  // Check in-memory store for expiration
  const storedSession = otpRegistrationStore.get(normalizedEmail);
  if (storedSession && Date.now() > storedSession.expiresAt) {
    return res.status(400).json({
      success: false,
      isExpired: true,
      message: "This verification code has expired. Please request a new code.",
    });
  }

  const supabaseAdmin = getSupabaseAdminClient();
  const supabaseAnon = getSupabaseServerClient();

  if (!supabaseAdmin || !supabaseAnon) {
    return res.status(500).json({
      success: false,
      message: "Supabase client is not available.",
    });
  }

  try {
    // 1. Verify OTP with Supabase Auth (type: 'signup', fallback: 'email')
    let verifyRes = await supabaseAnon.auth.verifyOtp({
      email: normalizedEmail,
      token: cleanToken,
      type: "signup",
    });

    if (verifyRes.error && !verifyRes.data?.user) {
      verifyRes = await supabaseAnon.auth.verifyOtp({
        email: normalizedEmail,
        token: cleanToken,
        type: "magiclink",
      });
    }

    if (verifyRes.error && !verifyRes.data?.user) {
      verifyRes = await supabaseAnon.auth.verifyOtp({
        email: normalizedEmail,
        token: cleanToken,
        type: "email",
      });
    }

    if (verifyRes.error || !verifyRes.data?.user) {
      const errMsg = verifyRes.error?.message || "Invalid verification code.";
      const isExpired = errMsg.toLowerCase().includes("expired");
      return res.status(400).json({
        success: false,
        isExpired,
        message: isExpired
          ? "This verification code has expired. Please request a new code."
          : "Invalid or incorrect verification code. Please check the code and try again.",
      });
    }

    const verifiedUser = verifyRes.data.user;
    const session = verifyRes.data.session;
    const fullName = storedSession?.fullName || verifiedUser.user_metadata?.full_name || verifiedUser.email?.split("@")[0] || "User";

    // 2. Mark email verified in user metadata via admin client
    await supabaseAdmin.auth.admin.updateUserById(verifiedUser.id, {
      user_metadata: {
        ...verifiedUser.user_metadata,
        full_name: fullName,
        email_verified: true,
      },
    });

    // 3. Ensure user profile exists in public.profiles table
    const { data: existingProfile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", verifiedUser.id)
      .maybeSingle();

    if (!existingProfile) {
      await supabaseAdmin.from("profiles").insert({
        id: verifiedUser.id,
        email: normalizedEmail,
        full_name: fullName,
        storage_quota_bytes: DEFAULT_STORAGE_QUOTA_BYTES,
        role: "user",
        status: "active",
      });
    } else {
      await supabaseAdmin.from("profiles").update({
        full_name: fullName,
        status: "active",
        updated_at: new Date().toISOString(),
      }).eq("id", verifiedUser.id);
    }

    // Clean up stored OTP session
    otpRegistrationStore.delete(normalizedEmail);

    res.json({
      success: true,
      message: "Email verified successfully.",
      user: verifiedUser,
      session,
    });
  } catch (err: any) {
    console.error("[VerifyOtp] Exception during verification:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to verify code. Please try again.",
    });
  }
});

/**
 * POST /api/auth/resend-verification
 * Resends a fresh email OTP with cooldown protection (60 seconds)
 */
router.post("/resend-verification", async (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== "string") {
    return res.status(400).json({
      success: false,
      message: "Email address is required.",
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const storedSession = otpRegistrationStore.get(normalizedEmail);

  // Enforce 60-second cooldown per email
  const now = Date.now();
  if (storedSession && now - storedSession.lastSentAt < 60000) {
    const remainingSeconds = Math.ceil((60000 - (now - storedSession.lastSentAt)) / 1000);
    return res.status(429).json({
      success: false,
      message: `Please wait ${remainingSeconds} seconds before requesting a new code.`,
      cooldownRemaining: remainingSeconds,
    });
  }

  const supabaseAdmin = getSupabaseAdminClient();
  if (!supabaseAdmin) {
    return res.status(500).json({
      success: false,
      message: "Supabase backend service is unavailable.",
    });
  }

  try {
    // Generate fresh Supabase verification link
    const linkRes = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: normalizedEmail,
    });

    const emailOtp = linkRes.data?.properties?.email_otp || "";
    const fullName = storedSession?.fullName || "User";

    if (!emailOtp) {
      console.warn("[Resend] Could not generate email_otp from generateLink");
    }

    // Send email via platform SMTP
    const origin = `${req.protocol}://${req.get("host")}`;
    const directVerifyUrl = `${origin}/verify-email?token=${encodeURIComponent(emailOtp)}&email=${encodeURIComponent(normalizedEmail)}`;

    const emailResult = await sendVerificationOtpEmail({
      recipientEmail: normalizedEmail,
      fullName,
      otpCode: emailOtp,
      verificationLink: directVerifyUrl,
      expiresInMinutes: 5,
    });

    if (!emailResult.success) {
      console.error("[Resend] Email dispatch error:", emailResult.error);
    }

    const otpLength = emailOtp ? emailOtp.length : (storedSession?.otpLength || 6);

    // Update in-memory OTP state with fresh 5-minute expiry and new cooldown timestamp
    otpRegistrationStore.set(normalizedEmail, {
      email: normalizedEmail,
      fullName,
      lastSentAt: now,
      expiresAt: now + 5 * 60 * 1000,
      otpLength,
    });

    res.json({
      success: true,
      message: "A fresh verification code has been sent to your email.",
      otpLength,
      expiresInSeconds: 300,
    });
  } catch (err: any) {
    console.error("[Resend] Exception:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to resend verification code.",
    });
  }
});

/**
 * GET /api/auth/verification-status
 * Checks if a given email is already verified in Supabase
 */
router.get("/verification-status", async (req, res) => {
  const email = (req.query.email as string || "").trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, message: "Email parameter required." });
  }

  const supabaseAdmin = getSupabaseAdminClient();
  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: "Supabase client unavailable." });
  }

  try {
    const { data: usersData } = await supabaseAdmin.auth.admin.listUsers();
    const user = (usersData?.users || []).find((u: any) => u.email?.toLowerCase() === email);

    if (!user) {
      return res.json({ success: true, exists: false, isVerified: false });
    }

    const isVerified = Boolean(user.email_confirmed_at);
    res.json({
      success: true,
      exists: true,
      isVerified,
      confirmedAt: user.email_confirmed_at || null,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Cooldown tracking for password reset requests (60 seconds)
const passwordResetCooldownMap = new Map<string, number>();

/**
 * Resolves the current application origin in an environment-aware way.
 * - Development: client origin or localhost:3000
 * - Production / Deployed: deployed CloudVault application origin
 */
const resolveAppOrigin = (req: any, clientOrigin?: string): string => {
  if (clientOrigin && typeof clientOrigin === "string") {
    try {
      const parsed = new URL(clientOrigin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin;
      }
    } catch {}
  }

  const reqOrigin = req.get("origin");
  if (reqOrigin && !reqOrigin.includes("null")) {
    try {
      const parsed = new URL(reqOrigin);
      return parsed.origin;
    } catch {}
  }

  if (process.env.APP_URL) {
    let clean = process.env.APP_URL.trim();
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      clean = `https://${clean}`;
    }
    try {
      const parsed = new URL(clean);
      return parsed.origin;
    } catch {}
  }

  const host = req.get("host") || "localhost:3000";
  const protocol = req.protocol === "https" || req.secure || req.get("x-forwarded-proto") === "https" ? "https" : "http";
  return `${protocol}://${host}`;
};

/**
 * POST /api/auth/forgot-password
 * Handles secure, production-grade password recovery requests:
 * 1. Validates and sanitizes email address.
 * 2. Enforces cooldown and prevents duplicate submissions.
 * 3. Uses official Supabase Auth admin generateLink({ type: 'recovery' })
 * 4. Resolves environment-aware redirect URL to avoid hardcoded localhost:3000
 * 5. Dispatches branded CloudVault reset email with direct link
 */
router.post("/forgot-password", async (req, res) => {
  const { email, clientOrigin } = req.body || {};

  if (!email || typeof email !== "string") {
    return res.status(400).json({
      success: false,
      message: "A valid email address is required.",
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(normalizedEmail)) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid email address.",
    });
  }

  // Enforce 60-second cooldown per email to prevent spam & duplicate clicks
  const now = Date.now();
  const lastSent = passwordResetCooldownMap.get(normalizedEmail);
  if (lastSent && now - lastSent < 60000) {
    const remainingSeconds = Math.ceil((60000 - (now - lastSent)) / 1000);
    return res.status(429).json({
      success: false,
      message: `A reset link was recently sent. Please wait ${remainingSeconds} seconds before requesting another.`,
      cooldownRemaining: remainingSeconds,
    });
  }

  const supabaseAdmin = getSupabaseAdminClient();
  if (!supabaseAdmin) {
    return res.status(500).json({
      success: false,
      message: "Supabase backend service is currently unavailable.",
    });
  }

  try {
    const appOrigin = resolveAppOrigin(req, clientOrigin);
    const targetRedirectUrl = `${appOrigin}/reset-password`;

    console.log(`[ForgotPassword] Initiating password recovery for: ${normalizedEmail}`);
    console.log(`[ForgotPassword] Target redirect URL: ${targetRedirectUrl}`);

    // Generate official Supabase Auth recovery token & link
    const linkRes = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: normalizedEmail,
      options: {
        redirectTo: targetRedirectUrl,
      },
    });

    if (linkRes.error) {
      console.warn("[ForgotPassword] Supabase generateLink warning:", linkRes.error.message);
      // If user is not found, return generic success to avoid email enumeration
      if (linkRes.error.message?.includes("not found") || (linkRes.error as any).status === 404) {
        return res.json({
          success: true,
          message: "If an account exists with this email, a password reset link has been sent.",
        });
      }
      throw linkRes.error;
    }

    const tokenHash = linkRes.data?.properties?.hashed_token;
    const emailOtp = linkRes.data?.properties?.email_otp || "";
    const userMeta = linkRes.data?.user?.user_metadata;
    const fullName = userMeta?.full_name || "User";

    if (!tokenHash) {
      throw new Error("Failed to generate password recovery token from Supabase.");
    }

    // Direct environment-aware reset URL pointing to CloudVault /reset-password
    const directResetUrl = `${appOrigin}/reset-password?token_hash=${encodeURIComponent(tokenHash)}&type=recovery`;

    // Send official branded password reset email
    const emailResult = await sendPasswordResetEmail({
      recipientEmail: normalizedEmail,
      fullName,
      resetLink: directResetUrl,
      otpCode: emailOtp,
      expiresInMinutes: 15,
    });

    if (!emailResult.success) {
      console.error("[ForgotPassword] Email dispatch error:", emailResult.error);
    }

    // Set cooldown
    passwordResetCooldownMap.set(normalizedEmail, now);

    res.json({
      success: true,
      message: "Password reset instructions have been sent to your email.",
      redirectUrl: directResetUrl,
    });
  } catch (err: any) {
    console.error("[ForgotPassword] Unexpected error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to process password reset request. Please try again.",
    });
  }
});

export default router;

