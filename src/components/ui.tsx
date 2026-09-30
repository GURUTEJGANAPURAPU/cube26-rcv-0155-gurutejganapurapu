import { cn } from "@/lib/utils";

const TONES: Record<string, string> = {
  PASS: "bg-pass-bg text-pass",
  FAIL: "bg-fail-bg text-fail",
  EXCEPTION: "bg-fail-bg text-fail",
  UNCERTAIN: "bg-unc-bg text-unc",
  PENDING: "bg-pend-bg text-pend",
};

export function VerdictBadge({ value, className }: { value: string | null | undefined; className?: string }) {
  const v = value ?? "PENDING";
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-wide", TONES[v] ?? TONES.PENDING, className)}>
      {v}
    </span>
  );
}

export function DemoTag() {
  return <span className="rounded border border-unc px-1 font-mono text-[10px] font-semibold text-unc">DEMO</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4 border-b border-line pb-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card px-4 py-10 text-center text-sm text-muted">{children}</div>;
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return <div className="rounded border border-fail bg-fail-bg px-3 py-2 text-sm text-fail">{children}</div>;
}
