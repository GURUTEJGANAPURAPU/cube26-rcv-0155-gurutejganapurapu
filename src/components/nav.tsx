"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ClipboardCheck, FileText, FlaskConical, ListChecks, LogOut, Package } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/receiving", label: "Receiving", icon: ClipboardCheck },
  { href: "/inspection-queue", label: "Inspection queue", icon: ListChecks },
  { href: "/purchase-orders", label: "Purchase orders", icon: Package },
  { href: "/evidence", label: "Evidence records", icon: FileText },
  { href: "/evaluation", label: "Evaluation", icon: FlaskConical },
];

export function Nav({ orgName, operator, isDemo }: { orgName: string; operator: string; isDemo: boolean }) {
  const path = usePathname();
  const router = useRouter();
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface">
      <div className="border-b border-line px-4 py-4">
        <div className="text-sm font-semibold">Receiving Manager</div>
        <div className="mt-0.5 truncate text-xs text-muted">
          {orgName} {isDemo && <span className="font-mono text-unc">· DEMO</span>}
        </div>
      </div>
      <nav className="flex-1 p-2">
        {ITEMS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2 rounded px-2.5 py-2 text-sm text-muted hover:bg-sunken hover:text-ink",
              path.startsWith(href) && "bg-sunken font-medium text-ink",
            )}
          >
            <Icon size={15} /> {label}
          </Link>
        ))}
      </nav>
      <div className="border-t border-line p-3 text-xs text-muted">
        <div className="truncate">{operator}</div>
        <button
          className="mt-2 flex items-center gap-1.5 hover:text-ink"
          onClick={async () => {
            await createClient().auth.signOut();
            router.replace("/sign-in");
          }}
        >
          <LogOut size={13} /> Sign out
        </button>
      </div>
    </aside>
  );
}
