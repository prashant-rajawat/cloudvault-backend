import fs from "fs";
import path from "path";
import { getSupabaseAdminClient } from "../config/supabase.js";

export interface AnnouncementRecord {
  id: string;
  title: string;
  message: string;
  type: "info" | "success" | "warning" | "security" | "maintenance" | "feature";
  status: "draft" | "published" | "scheduled" | "expired";
  created_at: string;
  updated_at: string;
  published_at?: string | null;
  expires_at?: string | null;
  created_by?: string | null;
}

const DATA_DIR = path.join(process.cwd(), "data");
const FILE_PATH = path.join(DATA_DIR, "announcements.json");

function ensureFileExists() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(FILE_PATH)) {
    fs.writeFileSync(FILE_PATH, JSON.stringify([]), "utf-8");
  }
}

function readLocalAnnouncements(): AnnouncementRecord[] {
  try {
    ensureFileExists();
    const raw = fs.readFileSync(FILE_PATH, "utf-8");
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function writeLocalAnnouncements(list: AnnouncementRecord[]) {
  try {
    ensureFileExists();
    fs.writeFileSync(FILE_PATH, JSON.stringify(list, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write local announcements file:", err);
  }
}

export async function fetchAllAnnouncementsAdmin(): Promise<AnnouncementRecord[]> {
  const supabase = getSupabaseAdminClient();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("announcements")
        .select("*")
        .order("created_at", { ascending: false });

      if (!error && data) {
        return data as AnnouncementRecord[];
      }
    } catch {
      // Fallback to local file store if table doesn't exist
    }
  }

  const local = readLocalAnnouncements();
  return local.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function fetchActiveAnnouncementsUser(): Promise<AnnouncementRecord[]> {
  const all = await fetchAllAnnouncementsAdmin();
  const now = new Date();

  return all.filter((item) => {
    // ONLY published
    if (item.status !== "published") return false;
    // Check expiration
    if (item.expires_at) {
      if (new Date(item.expires_at) <= now) return false;
    }
    return true;
  });
}

export async function createAnnouncementRecord(
  payload: Omit<AnnouncementRecord, "id" | "created_at" | "updated_at">
): Promise<AnnouncementRecord> {
  const now = new Date().toISOString();
  const record: AnnouncementRecord = {
    id: crypto.randomUUID(),
    title: payload.title,
    message: payload.message,
    type: payload.type || "info",
    status: payload.status || "draft",
    created_at: now,
    updated_at: now,
    published_at: payload.status === "published" ? (payload.published_at || now) : null,
    expires_at: payload.expires_at || null,
    created_by: payload.created_by || null,
  };

  const supabase = getSupabaseAdminClient();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("announcements")
        .insert(record)
        .select()
        .single();

      if (!error && data) {
        // Also sync local
        const local = readLocalAnnouncements();
        writeLocalAnnouncements([data as AnnouncementRecord, ...local]);
        return data as AnnouncementRecord;
      }
    } catch {
      // Fallback
    }
  }

  const local = readLocalAnnouncements();
  const updated = [record, ...local];
  writeLocalAnnouncements(updated);
  return record;
}

export async function updateAnnouncementRecord(
  id: string,
  updates: Partial<AnnouncementRecord>
): Promise<AnnouncementRecord | null> {
  const now = new Date().toISOString();

  // If status is changing to published and published_at is missing, set it
  const payloadToUpdate: Record<string, any> = {
    ...updates,
    updated_at: now,
  };

  if (updates.status === "published" && !updates.published_at) {
    payloadToUpdate.published_at = now;
  } else if (updates.status === "draft") {
    payloadToUpdate.published_at = null;
  }

  const supabase = getSupabaseAdminClient();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("announcements")
        .update(payloadToUpdate)
        .eq("id", id)
        .select()
        .single();

      if (!error && data) {
        const local = readLocalAnnouncements();
        const idx = local.findIndex((a) => a.id === id);
        if (idx !== -1) {
          local[idx] = { ...local[idx], ...data };
          writeLocalAnnouncements(local);
        } else {
          writeLocalAnnouncements([data as AnnouncementRecord, ...local]);
        }
        return data as AnnouncementRecord;
      }
    } catch {
      // Fallback
    }
  }

  const local = readLocalAnnouncements();
  const idx = local.findIndex((a) => a.id === id);
  if (idx === -1) return null;

  const updatedRecord = {
    ...local[idx],
    ...payloadToUpdate,
  };
  local[idx] = updatedRecord;
  writeLocalAnnouncements(local);
  return updatedRecord;
}

export async function deleteAnnouncementRecord(id: string): Promise<boolean> {
  const supabase = getSupabaseAdminClient();
  if (supabase) {
    try {
      const { error } = await supabase.from("announcements").delete().eq("id", id);
      if (!error) {
        const local = readLocalAnnouncements();
        writeLocalAnnouncements(local.filter((a) => a.id !== id));
        return true;
      }
    } catch {
      // Fallback
    }
  }

  const local = readLocalAnnouncements();
  writeLocalAnnouncements(local.filter((a) => a.id !== id));
  return true;
}
