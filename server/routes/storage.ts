import { Router, Response, Request } from "express";
import { getSupabaseAdminClient } from "../config/supabase.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/authMiddleware.js";

const router = Router();

/**
 * POST /api/storage/signed-url
 * Generates a temporary signed download URL for private files
 */
router.post("/signed-url", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const userId = req.user?.id;
  const userEmail = req.user?.email;
  const userRole = req.user?.role;
  const { path, expiresIn = 7200 } = req.body;

  if (!path) {
    return res.status(400).json({ success: false, message: "path is required." });
  }

  // 1. Owner check
  let isAuthorized = Boolean(userId && path.startsWith(`${userId}/`));

  // 2. Admin check
  if (!isAuthorized && userRole === "admin") {
    isAuthorized = true;
  }

  // 3. Shared recipient check
  if (!isAuthorized && userEmail) {
    try {
      const { data: file } = await supabase
        .from("files")
        .select("id")
        .eq("storage_path", path)
        .maybeSingle();

      if (file) {
        const { data: share } = await supabase
          .from("shares")
          .select("id, expires_at")
          .eq("file_id", file.id)
          .eq("granted_to_email", userEmail)
          .maybeSingle();

        if (share) {
          const isExpired = share.expires_at && new Date(share.expires_at) < new Date();
          if (!isExpired) {
            isAuthorized = true;
          }
        }
      }
    } catch {
      // Query error
    }
  }

  if (!isAuthorized) {
    return res.status(403).json({ success: false, message: "Access denied. You are not authorized to access this storage path." });
  }

  try {
    const { data, error } = await supabase.storage
      .from("cloudvault-files")
      .createSignedUrl(path, expiresIn);

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    res.json({ success: true, signedUrl: data.signedUrl });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/storage/stream
 * Streams video/audio media with HTTP Range (206 Partial Content) support
 */
router.get("/stream", async (req: Request, res: Response) => {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Backend Supabase client unavailable." });
  }

  const path = req.query.path as string;
  if (!path) {
    return res.status(400).send("Path parameter is required.");
  }

  // Generate signed URL from Supabase
  try {
    const { data, error } = await supabase.storage
      .from("cloudvault-files")
      .createSignedUrl(path, 7200);

    if (error || !data?.signedUrl) {
      return res.status(404).send("Media file not found or inaccessible.");
    }

    const rangeHeader = req.headers.range;
    const fetchHeaders: HeadersInit = {};
    if (rangeHeader) {
      fetchHeaders["Range"] = rangeHeader;
    }

    const upstreamRes = await fetch(data.signedUrl, { headers: fetchHeaders });
    
    // Forward response headers
    res.status(upstreamRes.status);
    
    const contentType = upstreamRes.headers.get("content-type") || "video/mp4";
    const contentLength = upstreamRes.headers.get("content-length");
    const contentRange = upstreamRes.headers.get("content-range");
    const acceptRanges = upstreamRes.headers.get("accept-ranges") || "bytes";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", acceptRanges);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);

    if (!upstreamRes.body) {
      return res.end();
    }

    // Stream the body chunks to response
    const reader = upstreamRes.body.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            break;
          }
          if (!res.write(value)) {
            // Backpressure handled
            await new Promise((resolve) => res.once("drain", resolve));
          }
        }
      } catch (err) {
        if (!res.writableEnded) {
          res.end();
        }
      }
    };

    pump();
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).send(err.message || "Streaming error");
    }
  }
});

export default router;
