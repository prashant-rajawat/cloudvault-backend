import express from "express";
import apiRouter from "./routes/index.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { helmetMiddleware, corsMiddleware, generalLimiter } from "./middleware/security.js";

export function createApp() {
  const app = express();

  // Trust reverse proxy for correct client IP resolution in express-rate-limit
  app.set("trust proxy", 1);

  // Apply general security headers and rate limits
  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(express.json({ limit: "15mb" }));
  app.use(express.urlencoded({ limit: "15mb", extended: true }));

  // Apply general API rate limiter to all API endpoints
  app.use("/api", generalLimiter);

  // API routes mounted FIRST
  app.use("/api", apiRouter);

  // Top-level aliases for auth endpoints if reached without /api prefix
  app.all(
    [
      "/register",
      "/signup",
      "/login",
      "/signin",
      "/validate-signup",
      "/validate-register",
      "/verify-email-otp",
      "/resend-verification",
      "/verification-status",
      "/forgot-password",
    ],
    (req, res, next) => {
      apiRouter(req, res, next);
    }
  );

  // Catch unmatched /api routes so they return JSON and NEVER fall through to HTML
  app.all(["/api", "/api/*"], (req, res) => {
    res.status(404).json({
      success: false,
      httpStatus: 404,
      error: {
        message: `API endpoint not found: ${req.method} ${req.originalUrl}`,
        statusCode: 404,
      },
    });
  });

  return app;
}

export const app = createApp();
export default app;
