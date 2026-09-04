import { getSupabaseServerConfig } from "../server/config/supabase.js";

async function inspectRpc() {
  const config = getSupabaseServerConfig();
  const url = config.supabaseUrl;
  const key = config.supabaseServiceRoleKey;

  const res = await fetch(`${url}/rest/v1/`, {
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
    },
  });

  const spec = await res.json();
  console.log("rls_auto_enable details:", JSON.stringify(spec.paths["/rpc/rls_auto_enable"], null, 2));
  console.log("All paths:", Object.keys(spec.paths || {}));
}

inspectRpc();
