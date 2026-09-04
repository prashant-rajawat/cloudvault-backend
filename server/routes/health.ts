import { Router, Request, Response } from "express";
import { getSupabaseServerConfig, testSupabaseServerConnection } from "../config/supabase.js";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  const supabaseConfig = getSupabaseServerConfig();
  
  // Quick probe if configured
  const probe = req.query.probe === "true" ? await testSupabaseServerConnection() : null;

  res.json({
    status: "online",
    service: "CloudVault API Gateway",
    version: "0.2.0 (Supabase Connection Phase)",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    modules: {
      auth: { 
        status: supabaseConfig.isConfigured ? "configured" : "awaiting_credentials", 
        provider: "Supabase Auth" 
      },
      storage: { 
        status: supabaseConfig.isConfigured ? "configured" : "awaiting_credentials", 
        provider: "Supabase Storage" 
      },
      database: { 
        status: supabaseConfig.isConfigured ? "configured" : "awaiting_credentials", 
        provider: "PostgreSQL / Supabase" 
      },
      files: { 
        status: "ready_for_implementation", 
        features: ["upload", "metadata", "sharing"] 
      },
    },
    configState: {
      supabaseConfigured: supabaseConfig.isConfigured,
      hasUrl: Boolean(supabaseConfig.supabaseUrl),
      hasAnonKey: Boolean(supabaseConfig.supabaseAnonKey),
      hasServiceRoleKey: Boolean(supabaseConfig.supabaseServiceRoleKey),
    },
    ...(probe ? { liveProbe: probe } : {}),
  });
});

export default router;

