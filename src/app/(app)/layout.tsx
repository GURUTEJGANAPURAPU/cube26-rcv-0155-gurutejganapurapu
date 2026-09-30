import { redirect } from "next/navigation";

import { Nav } from "@/components/nav";
import { getSessionContext } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionContext();
  if (!session) redirect("/sign-in");
  return (
    <div className="flex min-h-screen">
      <Nav orgName={session.organizationName} operator={session.operatorLabel} isDemo={session.isDemoOrg} />
      <main className="min-w-0 flex-1 px-8 py-6">{children}</main>
    </div>
  );
}
