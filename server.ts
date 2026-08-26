import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import apiRouter from "./server/routes/index.js";
import { errorHandler } from "./server/middleware/errorHandler.js";
import { logSupabaseStartupDiagnostics } from "./server/config/supabase.js";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Safe standard CORS handling for development & API access
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, apikey");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // API routes mounted FIRST
  app.use("/api", apiRouter);

  // Catch unmatched /api routes so they return JSON and NEVER fall through to Vite HTML
  app.all("/api/*", (req, res) => {
    res.status(404).json({
      success: false,
      httpStatus: 404,
      error: {
        message: `API endpoint not found: ${req.method} ${req.originalUrl}`,
        statusCode: 404,
      },
    });
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
