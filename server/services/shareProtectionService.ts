import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";

export interface ShareProtectionData {
  shareId: string;
  shareToken: string;
  passwordEnabled: boolean;
  passwordHash: string | null;
  updatedAt: string;
}

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "share_protections.json");

function ensureStoreFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(STORE_FILE)) {
      fs.writeFileSync(STORE_FILE, JSON.stringify({}), "utf-8");
    }
  } catch (err) {
    console.warn("[ShareProtectionService] Could not create store file:", err);
  }
}

function readStore(): Record<string, ShareProtectionData> {
  try {
    ensureStoreFile();
    const raw = fs.readFileSync(STORE_FILE, "utf-8");
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function writeStore(data: Record<string, ShareProtectionData>) {
  try {
    ensureStoreFile();
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[ShareProtectionService] Failed to write store file:", err);
  }
}

/**
 * Hash a plain password using bcrypt (10 rounds)
 */
export async function hashSharePassword(plainPassword: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plainPassword, salt);
}

/**
 * Verify a plain password against a bcrypt hash
 */
export async function compareSharePassword(plainPassword: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plainPassword, hash);
}

/**
 * Save protection metadata for a share token
 */
export function saveShareProtection(
  shareToken: string,
  shareId: string,
  passwordHash: string | null,
  passwordEnabled: boolean
) {
  const store = readStore();
  store[shareToken] = {
    shareId,
    shareToken,
    passwordEnabled,
    passwordHash: passwordEnabled ? passwordHash : null,
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
}

/**
 * Get protection metadata for a share token (checking database row first if available)
 */
export function getShareProtection(shareToken: string, shareRow?: any): { passwordEnabled: boolean; passwordHash: string | null } {
  // If the database record contains the column values directly, prioritize them
  if (shareRow && typeof shareRow.password_enabled === "boolean") {
    return {
      passwordEnabled: shareRow.password_enabled,
      passwordHash: shareRow.password_hash || null,
    };
  }

  const store = readStore();
  const entry = store[shareToken];
  if (entry) {
    return {
      passwordEnabled: entry.passwordEnabled,
      passwordHash: entry.passwordHash,
    };
  }

  return {
    passwordEnabled: false,
    passwordHash: null,
  };
}

/**
 * Verify password for a given share token
 */
export async function verifySharePassword(
  shareToken: string,
  enteredPassword: string,
  shareRow?: any
): Promise<boolean> {
  const protection = getShareProtection(shareToken, shareRow);
  if (!protection.passwordEnabled || !protection.passwordHash) {
    return false;
  }
  return compareSharePassword(enteredPassword, protection.passwordHash);
}

/**
 * Delete protection metadata when a share is revoked
 */
export function deleteShareProtection(shareToken: string) {
  const store = readStore();
  if (store[shareToken]) {
    delete store[shareToken];
    writeStore(store);
  }
}
