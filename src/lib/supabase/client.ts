"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Browser client. Publishable anon key only; every read is RLS-scoped. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
