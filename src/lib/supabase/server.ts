import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

/**
 * Request-scoped Supabase client acting as the signed-in user.
 * RLS applies; this is the default client for all application reads/writes.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component; the middleware refreshes cookies.
          }
        },
      },
    },
  );
}

export interface SessionContext {
  userId: string;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  operatorLabel: string;
  roles: string[];
  isDemoOrg: boolean;
}

/** Resolves the caller's organisation. Returns null when not signed in. */
export async function getSessionContext(): Promise<SessionContext | null> {
  const supabase = await createServerSupabase();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id, display_name, operator_label, organizations(slug, name, is_demo)")
    .eq("id", auth.user.id)
    .maybeSingle();

  if (!profile) return null;

  const org = profile.organizations as unknown as { slug: string; name: string; is_demo: boolean } | null;
  const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", auth.user.id);

  return {
    userId: auth.user.id,
    organizationId: profile.organization_id,
    organizationSlug: org?.slug ?? "",
    organizationName: org?.name ?? "",
    operatorLabel: profile.operator_label || profile.display_name || auth.user.email || "operator",
    roles: (roles ?? []).map((r) => r.role as string),
    isDemoOrg: Boolean(org?.is_demo),
  };
}
