/** Server-side configuration. Read inside handlers, never at import time in shared modules. */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getLimits() {
  return {
    dailyInspectionLimit: intEnv("INSPECTION_DAILY_LIMIT", 100),
    inspectionTimeoutMs: intEnv("INSPECTION_TIMEOUT_MS", 60_000),
    maxImagesPerInspection: intEnv("MAX_IMAGES_PER_INSPECTION", 8),
    maxImageBytes: intEnv("MAX_IMAGE_BYTES", 8 * 1024 * 1024),
    maxAttempts: intEnv("MAX_INSPECTION_ATTEMPTS", 3),
  };
}

export const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "receiving-evidence";

export const AGENT_NAME = "receiving-manager";
export const AGENT_VERSION = "1.0.0";
