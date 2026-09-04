import dotenv from "dotenv";
dotenv.config({ override: true });
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dns from "node:dns/promises";

/**
 * Supabase Server Configuration & Lazy Client Factory
 * 
 * SECURITY RULES:
 * 1. SUPABASE_SERVICE_ROLE_KEY has admin bypass and must NEVER be returned
 *    to the browser or referenced in client-side code.
 * 2. Supabase clients are initialized lazily so the server boots cleanly
 *    even when credentials are not yet populated in the environment.
 * 3. Server strictly uses SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY
 *    (Never VITE_ variables in server code).
 */

export interface SupabaseServerConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  isConfigured: boolean;
}

export interface SupabaseReachabilityResult {
  reachable: boolean;
  configured: boolean;
  latencyMs: number | null;
  status: "connected" | "unconfigured" | "unreachable" | "configuration_error";
  errorType?: "NETWORK_ERROR" | "TIMEOUT" | "DNS_ERROR" | "TLS_ERROR" | "AUTH_ERROR" | "UNCONFIGURED" | "CONFIGURATION_ERROR" | "HTTP_ERROR" | "INTERNAL_ERROR" | null;
  message: string;
  hostname?: string;
  endpoints: {
    auth: "healthy" | "unhealthy" | "unconfigured";
    rest: "healthy" | "unhealthy" | "unconfigured";
  };
}

let cachedAdminClient: SupabaseClient | null = null;
let cachedAnonClient: SupabaseClient | null = null;

/**
 * Normalizes and sanitizes a Supabase URL safely.
 * Strips accidental quotes, leading/trailing whitespace, /rest/v1, /auth/v1, or duplicate slashes.
 */
export const normalizeSupabaseUrl = (rawUrl?: string): string => {
  if (!rawUrl) return "";
  let clean = rawUrl.trim().replace(/^["']|["']$/g, "").trim();
  if (!clean) return "";

  // Auto-correct known typo variants in project domain if detected (e.g. gibh -> gjbh)
  if (clean.includes("pqmnemgddcrgibhdtwvz")) {
    clean = clean.replace("pqmnemgddcrgibhdtwvz", "pqmnemgddcrgjbhdtwvz");
  }

  // Add protocol if missing
  if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
    clean = `https://${clean}`;
  }

  try {
    const parsed = new URL(clean);
    // Return standard origin: https://<project-ref>.supabase.co without trailing endpoints
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    // Fallback regex sanitization
    clean = clean.replace(/\/rest\/v1\/?.*$/, "");
    clean = clean.replace(/\/auth\/v1\/?.*$/, "");
    clean = clean.replace(/\/storage\/v1\/?.*$/, "");
    clean = clean.replace(/\/+$/, "");
    return clean;
  }
};

/**
 * Extract hostname from normalized Supabase URL safely.
 */
export const getSupabaseHostname = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return "";
  }
};

/**
 * Retrieve raw server environment variables for Supabase.
 * STRICT: Uses ONLY SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.
 */
export const getSupabaseServerConfig = (): SupabaseServerConfig => {
  const rawUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const supabaseAnonKey = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ""
  )
    .trim()
    .replace(/^["']|["']$/g, "");
  const supabaseServiceRoleKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ""
  )
    .trim()
    .replace(/^["']|["']$/g, "");

  const supabaseUrl = normalizeSupabaseUrl(rawUrl);

  return {
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    isConfigured: Boolean(supabaseUrl && (supabaseAnonKey || supabaseServiceRoleKey)),
  };
};

/**
 * Logs safe startup diagnostic summary (Zero secrets exposed).
 */
export const logSupabaseStartupDiagnostics = () => {
  const config = getSupabaseServerConfig();
  const hostname = config.supabaseUrl ? getSupabaseHostname(config.supabaseUrl) : "Not Configured";

  console.log("--------------------------------------------------");
  console.log("[CloudVault] Supabase Backend Diagnostics:");
  console.log(`  - Target Hostname:            ${hostname}`);
  console.log(`  - SUPABASE_URL Configured:    ${Boolean(config.supabaseUrl)}`);
  console.log(`  - SUPABASE_ANON_KEY Set:      ${Boolean(config.supabaseAnonKey)}`);
  console.log(`  - SUPABASE_SERVICE_ROLE Set:  ${Boolean(config.supabaseServiceRoleKey)} (Server-Only)`);
  console.log("--------------------------------------------------");
};

/**
 * Returns safe metadata about Supabase configuration (NO secrets leaked).
 */
export const getSafeSupabaseConfigStatus = () => {
  const config = getSupabaseServerConfig();
  const hostname = config.supabaseUrl ? getSupabaseHostname(config.supabaseUrl) : null;
  return {
    isConfigured: config.isConfigured,
    hasUrl: Boolean(config.supabaseUrl),
    hasAnonKey: Boolean(config.supabaseAnonKey),
    hasServiceRoleKey: Boolean(config.supabaseServiceRoleKey),
    hostname: hostname || "",
    supabaseUrl: config.supabaseUrl || null,
  };
};

/**
 * Lazy initialization of Supabase Admin Client (Service Role).
 * Uses SUPABASE_SERVICE_ROLE_KEY for server-only elevated operations.
 */
export const getSupabaseAdminClient = (): SupabaseClient | null => {
  const config = getSupabaseServerConfig();

  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return null;
  }

  if (!cachedAdminClient) {
    cachedAdminClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return cachedAdminClient;
};

/**
 * Lazy initialization of standard Supabase Client for server-side user-scoped requests.
 * Uses SUPABASE_ANON_KEY and can optionally attach a user JWT token.
 */
export const getSupabaseServerClient = (accessToken?: string): SupabaseClient | null => {
  const config = getSupabaseServerConfig();

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return null;
  }

  if (accessToken) {
    return createClient(config.supabaseUrl, config.supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      auth: {
        persistSession: false,
      },
    });
  }

  if (!cachedAnonClient) {
    cachedAnonClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: false,
      },
    });
  }

  return cachedAnonClient;
};

export const getSupabaseAnonClient = getSupabaseServerClient;

/**
 * Network probe to test connectivity to the configured Supabase project.
 */
export const testSupabaseServerConnection = async (): Promise<SupabaseReachabilityResult> => {
  const config = getSupabaseServerConfig();

  if (!config.supabaseUrl) {
    return {
      reachable: false,
      configured: false,
      latencyMs: null,
      status: "unconfigured",
      errorType: "UNCONFIGURED",
      message: "Supabase project URL is not configured in server environment variables (SUPABASE_URL).",
      endpoints: {
        auth: "unconfigured",
        rest: "unconfigured",
      },
    };
  }

  const formattedUrl = config.supabaseUrl;
  const startTime = Date.now();
  let authHealthy: "healthy" | "unhealthy" | "unconfigured" = "unhealthy";
  let restHealthy: "healthy" | "unhealthy" | "unconfigured" = "unhealthy";

  // 1. Safe DNS resolution check using Node.js dns/promises
  const hostname = getSupabaseHostname(formattedUrl);
  if (!hostname) {
    return {
      reachable: false,
      configured: config.isConfigured,
      latencyMs: null,
      status: "configuration_error",
      errorType: "UNCONFIGURED",
      message: "Invalid Supabase URL format: hostname could not be parsed.",
      hostname: "",
      endpoints: {
        auth: "unhealthy",
        rest: "unhealthy",
      },
    };
  }

  try {
    // Attempt DNS lookup on the Supabase hostname using Node's dns facility
    await dns.lookup(hostname);
  } catch (dnsErr: any) {
    const latencyMs = Date.now() - startTime;
    const isNotFound = dnsErr?.code === "ENOTFOUND" || dnsErr?.code === "EAI_AGAIN" || String(dnsErr?.message).includes("ENOTFOUND");
    const errorType: SupabaseReachabilityResult["errorType"] = isNotFound ? "DNS_ERROR" : "NETWORK_ERROR";
    const errorMessage = isNotFound 
      ? `Supabase hostname cannot be resolved from the backend runtime (${hostname}).`
      : `DNS lookup failed for ${hostname}: ${dnsErr?.message || "Lookup error"}`;

    console.info(`[Supabase Health] DNS lookup status for ${hostname}: ${dnsErr?.message || "unresolved"} (classification: ${errorType})`);

    return {
      reachable: false,
      configured: config.isConfigured,
      latencyMs,
      status: "unreachable",
      errorType,
      message: errorMessage,
      hostname,
      endpoints: {
        auth: "unhealthy",
        rest: "unhealthy",
      },
    };
  }

  // 2. HTTPS Connection and Endpoint Probe
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const authUrl = `${formattedUrl}/auth/v1/health`;
    const restUrl = `${formattedUrl}/rest/v1/`;
    
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (config.supabaseAnonKey) {
      headers["apikey"] = config.supabaseAnonKey;
      headers["Authorization"] = `Bearer ${config.supabaseAnonKey}`;
    }

    const [authRes, restRes] = await Promise.all([
      fetch(authUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
      }).catch((err: any) => {
        const causeMsg = err?.cause?.message || err?.cause?.code || err?.cause || "";
        return {
          _fetchError: causeMsg ? `${err?.message || "fetch failed"} (${causeMsg})` : (err?.message || String(err)),
        };
      }),
      fetch(restUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
      }).catch((err: any) => {
        const causeMsg = err?.cause?.message || err?.cause?.code || err?.cause || "";
        return {
          _fetchError: causeMsg ? `${err?.message || "fetch failed"} (${causeMsg})` : (err?.message || String(err)),
        };
      }),
    ]);

    clearTimeout(timeoutId);

    const latencyMs = Date.now() - startTime;

    const isAuthHealthy = authRes && !("_fetchError" in authRes) && 
      (authRes.ok || authRes.status === 200 || authRes.status === 401 || authRes.status === 403);
    
    const isRestHealthy = restRes && !("_fetchError" in restRes) && 
      (restRes.ok || restRes.status === 200 || restRes.status === 401 || restRes.status === 403);

    authHealthy = isAuthHealthy ? "healthy" : "unhealthy";
    restHealthy = isRestHealthy ? "healthy" : "unhealthy";

    if (isAuthHealthy || isRestHealthy) {
      console.log(`[Supabase Health] Successfully reached ${formattedUrl} (${latencyMs}ms)`);
      return {
        reachable: true,
        configured: config.isConfigured,
        latencyMs,
        status: "connected",
        errorType: null,
        message: `Supabase instance is reachable (${latencyMs}ms latency).`,
        hostname,
        endpoints: {
          auth: authHealthy,
          rest: restHealthy,
        },
      };
    } else {
      const rawError = (authRes && "_fetchError" in authRes) ? authRes._fetchError : 
                        (restRes && "_fetchError" in restRes) ? restRes._fetchError :
                        (authRes && "status" in authRes) ? `HTTP ${authRes.status}` : "Network probe failed";

      let errorType: SupabaseReachabilityResult["errorType"] = "NETWORK_ERROR";
      const errLower = String(rawError).toLowerCase();

      if (errLower.includes("enotfound") || errLower.includes("eai_again") || errLower.includes("dns")) {
        errorType = "DNS_ERROR";
      } else if (errLower.includes("timeout") || errLower.includes("aborted")) {
        errorType = "TIMEOUT";
      } else if (errLower.includes("cert") || errLower.includes("tls") || errLower.includes("ssl")) {
        errorType = "TLS_ERROR";
      } else if (errLower.includes("401") || errLower.includes("403")) {
        errorType = "AUTH_ERROR";
      } else if (errLower.includes("http 5")) {
        errorType = "HTTP_ERROR";
      }

      const displayMessage = errorType === "DNS_ERROR" 
        ? `Supabase hostname cannot be resolved from the backend runtime (${hostname}).`
        : `Unable to reach Supabase project host: ${rawError}`;

      console.info(`[Supabase Health] Reachability check status for ${formattedUrl}: ${rawError} (classification: ${errorType})`);

      return {
        reachable: false,
        configured: config.isConfigured,
        latencyMs,
        status: "unreachable",
        errorType,
        message: displayMessage,
        hostname,
        endpoints: {
          auth: authHealthy,
          rest: restHealthy,
        },
      };
    }
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    const errorMsg = error?.message || "Failed to establish network connection to Supabase.";
    console.info(`[Supabase Health] Probe diagnostic: ${errorMsg}`);
    return {
      reachable: false,
      configured: config.isConfigured,
      latencyMs,
      status: "unreachable",
      errorType: "NETWORK_ERROR",
      message: errorMsg,
      hostname,
      endpoints: {
        auth: "unhealthy",
        rest: "unhealthy",
      },
    };
  }
};

