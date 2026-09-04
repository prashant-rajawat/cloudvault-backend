import { Router, Request, Response } from "express";
import {
  testSupabaseServerConnection,
  getSafeSupabaseConfigStatus,
  getSupabaseServerConfig,
} from "../config/supabase.js";

const router = Router();

/**
 * GET /api/supabase/health
 * Tests network reachability to the configured Supabase instance safely.
 * Returns:
 * - HTTP 200 when backend can successfully connect to Supabase
 * - HTTP 503 when DNS/network reachability fails (with safe errorType & hostname)
 * - HTTP 500 when unconfigured or configuration error occurs
 */
router.get("/health", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const config = getSupabaseServerConfig();
    const configStatus = getSafeSupabaseConfigStatus();

    if (!config.supabaseUrl || !config.isConfigured) {
      return res.status(500).json({
        success: false,
        httpStatus: 500,
        reachability: {
          reachable: false,
          configured: false,
          latencyMs: null,
          errorType: "CONFIGURATION_ERROR",
          status: "unconfigured",
          message: !config.supabaseUrl 
            ? "Supabase project URL is not configured in server environment variables (SUPABASE_URL)."
            : "Supabase API keys are not configured in server environment variables.",
          hostname: configStatus.hostname || "",
          endpoints: { auth: "unconfigured", rest: "unconfigured" },
        },
        config: configStatus,
        timestamp: new Date().toISOString(),
      });
    }

    const reachability = await testSupabaseServerConnection();

    if (reachability.reachable) {
      return res.status(200).json({
        success: true,
        httpStatus: 200,
        reachability: {
          reachable: true,
          configured: true,
          latencyMs: reachability.latencyMs,
          errorType: null,
          status: "reachable",
          message: reachability.message || "Supabase is reachable",
          hostname: reachability.hostname,
          endpoints: reachability.endpoints,
        },
        config: configStatus,
        timestamp: new Date().toISOString(),
      });
    } else {
      // Return HTTP 503 for network/DNS reachability failures; HTTP 500 for configuration errors
      const isConfigError = reachability.status === "configuration_error" || reachability.errorType === "CONFIGURATION_ERROR" || reachability.errorType === "UNCONFIGURED";
      const statusCode = isConfigError ? 500 : 503;

      return res.status(statusCode).json({
        success: false,
        httpStatus: statusCode,
        reachability: {
          reachable: false,
          configured: reachability.configured,
          latencyMs: reachability.latencyMs,
          status: isConfigError ? "configuration_error" : "unreachable",
          errorType: reachability.errorType || (statusCode === 503 ? "DNS_ERROR" : "CONFIGURATION_ERROR"),
          message: reachability.message,
          hostname: reachability.hostname,
          endpoints: reachability.endpoints,
        },
        config: configStatus,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      httpStatus: 500,
      reachability: {
        reachable: false,
        configured: false,
        latencyMs: null,
        status: "configuration_error",
        errorType: "INTERNAL_ERROR",
        message: error?.message || "Internal health probe error",
        hostname: "",
        endpoints: { auth: "unconfigured", rest: "unconfigured" },
      },
      config: getSafeSupabaseConfigStatus(),
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/supabase/config
 * Returns non-sensitive configuration status.
 */
router.get("/config", (req: Request, res: Response) => {
  const configStatus = getSafeSupabaseConfigStatus();
  res.json({
    status: "ok",
    config: configStatus,
    security: {
      serviceRoleExposedToClient: false,
      anonKeySafeForClient: true,
      encryption: "TLS 1.3 / HTTPS",
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/supabase/public-config
 * Returns client-safe credentials (supabaseUrl & public anonKey, NEVER service role key)
 * to allow client-side hydration when environment variables are injected at runtime.
 */
router.get("/public-config", (req: Request, res: Response) => {
  const config = getSupabaseServerConfig();
  res.setHeader("Content-Type", "application/json");
  res.json({
    success: true,
    isConfigured: config.isConfigured,
    supabaseUrl: config.supabaseUrl || "",
    supabaseAnonKey: config.supabaseAnonKey || "",
  });
});

export default router;
