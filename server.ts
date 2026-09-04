import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { createApp } from "./server/app.js";
import { errorHandler } from "./server/middleware/errorHandler.js";
import { logSupabaseStartupDiagnostics } from "./server/config/supabase.js";

async function startServer() {
  const app = createApp();
  const PORT = 3000;

  // Prevent non-GET requests or JSON client requests from falling through to HTML index
  app.use((req, res, next) => {
    const isJsonExpected = req.get("accept")?.includes("application/json") || req.is("application/json");
    if (req.method !== "GET" && req.method !== "HEAD") {
      return res.status(404).json({
        success: false,
        httpStatus: 404,
        error: {
          message: `Endpoint not found: ${req.method} ${req.originalUrl}`,
          statusCode: 404,
        },
      });
    }
    next();
  });

  // Error handling middleware
  app.use(errorHandler);

  // Vite middleware in development; static serve in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[CloudVault] Server running on http://0.0.0.0:${PORT}`);
    logSupabaseStartupDiagnostics();
  });
}

startServer().catch((err) => {
  console.error("[CloudVault] Failed to start server:", err);
});

