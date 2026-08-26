import { Request, Response, NextFunction } from "express";
import { getSupabaseAdminClient } from "../config/supabase.js";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role?: string;
  };
}

/**
 * Authentication Middleware
 * Validates Supabase Auth JWT token sent in the Authorization header.
 */
export const requireAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authorization Bearer token required.",
    });
  }

  const token = authHeader.split(" ")[1];
  const supabase = getSupabaseAdminClient();

  if (!supabase) {
    return res.status(500).json({
      success: false,
      message: "Supabase backend client is not configured.",
    });
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired session token.",
        error: error?.message,
      });
    }

    req.user = {
      id: data.user.id,
      email: data.user.email || "",
      role: data.user.role,
    };

    // Check account role in profiles and maintenance mode
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", data.user.id)
      .single();

    if (profile) {
      req.user.role = profile.role || req.user.role;
    }

    // Check maintenance mode
    if (!req.path.startsWith("/admin") && profile?.role !== "admin") {
      try {
        const { data: mainSetting } = await supabase
          .from("system_settings")
          .select("value")
          .eq("key", "maintenance_mode")
          .single();

        if (mainSetting && mainSetting.value === true) {
          return res.status(503).json({
            success: false,
            message: "CloudVault is temporarily under maintenance. Please try again shortly.",
            code: "MAINTENANCE_MODE",
          });
        }
      } catch {
        // system_settings may not be initialized yet
      }
    }

    next();
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      message: "Internal authentication verification error.",
      error: err?.message,
    });
  }
};

