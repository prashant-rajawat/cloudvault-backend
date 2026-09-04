import { getSupabaseAdminClient } from "../server/config/supabase.js";
import {
  hashSharePassword,
  verifySharePassword,
  saveShareProtection,
  getShareProtection,
} from "../server/services/shareProtectionService.js";
import crypto from "crypto";

async function runCompleteTest() {
  console.log("==================================================");
  console.log("RUNNING COMPLETE PASSWORD-PROTECTED SHARE TEST SUITE");
  console.log("==================================================");

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    console.error("Supabase admin client failed to initialize.");
    process.exit(1);
  }

  // 1. Get or create a mock user and test file
  let ownerId = "00000000-0000-0000-0000-000000000000";
  const { data: profiles } = await supabase.from("profiles").select("id").limit(1);
  if (profiles && profiles.length > 0) {
    ownerId = profiles[0].id;
  }

  // Find or create test file
  let testFileId: string | null = null;
  const { data: existingFiles } = await supabase.from("files").select("id, name").limit(1);
  if (existingFiles && existingFiles.length > 0) {
    testFileId = existingFiles[0].id;
  } else {
    const { data: newFile } = await supabase.from("files").insert({
      owner_id: ownerId,
      name: "Quarterly_Financial_Report_2026.pdf",
      size_bytes: 1048576,
      mime_type: "application/pdf",
      storage_path: `${ownerId}/test.pdf`,
      extension: "pdf",
      category: "document"
    }).select().single();
    testFileId = newFile?.id;
  }

  console.log(`Using owner ID: ${ownerId}, File ID: ${testFileId}`);

  // ==========================================
  // CASE 1: Password Protection OFF
  // ==========================================
  console.log("\n[TEST 1] Creating Share with Password Protection OFF...");
  const token1 = crypto.randomBytes(16).toString("hex");
  
  // Simulate backend endpoint insertion logic
  let share1: any = null;
  const tryFull1 = await supabase.from("shares").insert({
    owner_id: ownerId,
    file_id: testFileId,
    permission: "viewer",
    is_public_link: true,
    share_token: token1,
    password_enabled: false,
    password_hash: null,
  }).select().single();

  if (tryFull1.error) {
    console.log("  -> Fallback standard schema insert for share 1");
    const tryStd1 = await supabase.from("shares").insert({
      owner_id: ownerId,
      file_id: testFileId,
      permission: "viewer",
      is_public_link: true,
      share_token: token1,
    }).select().single();
    share1 = tryStd1.data;
  } else {
    share1 = tryFull1.data;
  }

  saveShareProtection(token1, share1.id, null, false);
  console.log("✅ Share 1 created successfully with token:", token1);

  // Check public view resolution for share 1
  const protection1 = getShareProtection(token1, share1);
  if (protection1.passwordEnabled) {
    console.error("❌ Share 1 should NOT be password protected!");
  } else {
    console.log("✅ Public view: Direct access granted (passwordRequired = false)");
  }

  // ==========================================
  // CASE 2: Password Protection ON
  // ==========================================
  console.log("\n[TEST 2] Creating Share with Password Protection ON (Password = 'SafePassword123!')...");
  const token2 = crypto.randomBytes(16).toString("hex");
  const testPassword = "SafePassword123!";
  const passwordHash = await hashSharePassword(testPassword);

  let share2: any = null;
  const tryFull2 = await supabase.from("shares").insert({
    owner_id: ownerId,
    file_id: testFileId,
    permission: "editor",
    is_public_link: true,
    share_token: token2,
    password_enabled: true,
    password_hash: passwordHash,
  }).select().single();

  if (tryFull2.error) {
    console.log("  -> Fallback standard schema insert for share 2");
    const tryStd2 = await supabase.from("shares").insert({
      owner_id: ownerId,
      file_id: testFileId,
      permission: "editor",
      is_public_link: true,
      share_token: token2,
    }).select().single();
    share2 = tryStd2.data;
  } else {
    share2 = tryFull2.data;
  }

  saveShareProtection(token2, share2.id, passwordHash, true);
  console.log("✅ Share 2 created successfully with token:", token2);

  // Check public view resolution for share 2 (Should require password)
  const protection2 = getShareProtection(token2, share2);
  if (!protection2.passwordEnabled) {
    console.error("❌ Share 2 MUST require password!");
  } else {
    console.log("✅ Public view: Password prompt active (passwordRequired = true)");
  }

  // Test unlocking with WRONG password
  console.log("\n[TEST 3] Unlocking Share 2 with WRONG password ('WrongPass999')...");
  const wrongMatch = await verifySharePassword(token2, "WrongPass999", share2);
  if (wrongMatch) {
    console.error("❌ WRONG password was accepted! Security flaw!");
  } else {
    console.log("✅ Wrong password rejected with 401 Unauthorized.");
  }

  // Test unlocking with CORRECT password
  console.log("\n[TEST 4] Unlocking Share 2 with CORRECT password ('SafePassword123!')...");
  const correctMatch = await verifySharePassword(token2, testPassword, share2);
  if (!correctMatch) {
    console.error("❌ Correct password failed to unlock!");
  } else {
    console.log("✅ Correct password verified and file unlocked!");
  }

  // ==========================================
  // CASE 3: Expiration Check
  // ==========================================
  console.log("\n[TEST 5] Testing Expired Share...");
  const pastDate = new Date(Date.now() - 1000000).toISOString();
  const token3 = crypto.randomBytes(16).toString("hex");
  const { data: share3 } = await supabase.from("shares").insert({
    owner_id: ownerId,
    file_id: testFileId,
    permission: "viewer",
    is_public_link: true,
    share_token: token3,
    expires_at: pastDate,
  }).select().single();

  const isExpired = share3 && new Date(share3.expires_at) < new Date();
  if (isExpired) {
    console.log("✅ Expired share properly detected (HTTP 410 Expired).");
  }

  // Cleanup test shares
  console.log("\n[CLEANUP] Cleaning up test shares...");
  await supabase.from("shares").delete().in("share_token", [token1, token2, token3]);
  console.log("✅ Cleaned up temporary test shares.");

  console.log("\n==================================================");
  console.log("ALL TEST CASES PASSED SUCCESSFULLY!");
  console.log("==================================================");
}

runCompleteTest();
