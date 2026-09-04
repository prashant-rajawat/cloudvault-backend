import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

/**
 * CORS Hardening:
 * Dynamic verification of origins.
 * Restricts cross-origin requests to trusted development and production domains.
 */
const allowedOrigins = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /https:\/\/.*\.run\.app$/,
  /https:\/\/.*\.google\.com$/,
  /https:\/\/.*\.googleusercontent\.com$/
];

export const corsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const origin = req.get("origin");
  if (origin) {
    let isAllowed = false;
    for (const pattern of allowedOrigins) {
      if (pattern.test(origin)) {
        isAllowed = true;
        break;
      }
    }
    // Also check against explicit APP_URL from env if defined
    if (!isAllowed && process.env.APP_URL && origin === process.env.APP_URL) {
      isAllowed = true;
    }
    
    if (isAllowed) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Access-Control-Allow-Credentials", "true");
    }
  }
  
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, apikey");
  
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
};

/**
 * HTTP Security Headers (Helmet):
 * Configured with standard security options, including custom CSP 
 * that allows communication with Supabase and embedding inside AI Studio iFrames.
 */
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", "https://*.supabase.co", "https://*.supabase.in", "wss://*.supabase.co", "wss://*.supabase.in"],
      imgSrc: ["'self'", "data:", "blob:", "https://*.supabase.co", "https://*.supabase.in"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      frameAncestors: ["'self'", "https://ai.studio", "https://*.google.com", "https://*.google.com.br", "https://*.googleusercontent.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

/**
 * General API Rate Limiter:
 * Maximum of 300 requests per 15 minutes per IP address.
 */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300,
  standardHeaders: "draft-6",
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      message: "Too many requests from this IP. Please try again in 15 minutes.",
    });
  },
});

/**
 * Authentication & Profile Abuse Limiter:
 * Protects login, delete-account, and profile management from automated abuse.
 * Max 30 requests per 15 minutes.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 30,
  standardHeaders: "draft-6",
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      message: "Too many authentication or profile attempts. Please try again in 15 minutes.",
    });
  },
});

/**
 * File Upload Abuse Limiter:
 * Prevents rapid file-upload calls to minimize server resource exhaustion.
 * Max 60 uploads per 15 minutes.
 */
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 60,
  standardHeaders: "draft-6",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Upload rate limit exceeded. Please try again shortly.",
  },
});

/**
 * Bulk & Destructive Operation Limiter:
 * Protects endpoints that perform large or heavy file deletions, trashes, or restores.
 * Max 20 requests per 15 minutes.
 */
export const bulkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20,
  standardHeaders: "draft-6",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many bulk or administrative file operations. Please try again in 15 minutes.",
  },
});

/**
 * Share & Link Sharing Limiter:
 * Limits signed URL generations and public share token lookups/unlocking.
 * Standard 300 requests per 15 minutes per IP.
 */
export const shareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300,
  standardHeaders: "draft-6",
  legacyHeaders: false,
  statusCode: 429,
  message: {
    success: false,
    errorType: "rate_limit",
    message: "Too many share access requests. Please try again in 15 minutes.",
  },
});
