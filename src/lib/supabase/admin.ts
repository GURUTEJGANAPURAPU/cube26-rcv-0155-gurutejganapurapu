import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client. Bypasses RLS.
 *
 * Used ONLY by the seed script and by server-side provisioning that must write
 * across organisations. Never import this from a client component, and never
 * use it to answer an ordinary application read.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Service-role access requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
