"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { DemoTag, Empty, ErrorNote, VerdictBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";

interface Row { id: string; unit_id: string | null; po_number: string; po_line: number | null; supplier: string | null; sku: string | null; status: string; decision: string | null; created_at: string; is_demo: boolean; recommended_action: string | null }

const FILTERS = ["ALL", "EXCEPTION", "UNCERTAIN", "PENDING", "PASS"];

export function RecordsTable({ defaultFilter = "ALL", queueOnly = false }: { defaultFilter?: string; queueOnly?: boolean }) {
  const [filter, setFilter] = useState(defaultFilter);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      const params = new URLSearchParams();
      if (filter !== "ALL") params.set("decision", filter);
      if (q) params.set("q", q);
      const r = await fetch(`/api/receiving?${params}`);
      const j = await r.json();
      if (!r.ok) return setError(j.message);
      let list: Row[] = j.records;
      if (queueOnly && filter === "ALL") list = list.filter((x) => x.decision !== "PASS" || x.status !== "complete");
      setRows(list);
    }, 200);
    return () => clearTimeout(t);
  }, [filter, q, queueOnly]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={f === filter ? "btn btn-primary" : "btn"}>{f === "ALL" ? (queueOnly ? "Needs review" : "All") : f}</button>
        ))}
        <input className="input ml-auto max-w-xs" placeholder="Search PO, SKU, unit, supplier" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {rows === null ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <Empty>No receiving records match.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead><tr>{["Decision", "Unit", "PO / line", "SKU", "Supplier", "Status", "Next action", "Created"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-bg">
                  <td className="td"><VerdictBadge value={r.decision} /></td>
                  <td className="td font-mono text-[13px]"><Link className="underline-offset-2 hover:underline" href={`/evidence/${r.id}`}>{r.unit_id ?? r.id.slice(0, 8)}</Link> {r.is_demo && <DemoTag />}</td>
                  <td className="td font-mono text-[13px]">{r.po_number}{r.po_line != null ? ` / ${r.po_line}` : ""}</td>
                  <td className="td font-mono text-[13px]">{r.sku}</td>
                  <td className="td">{r.supplier}</td>
                  <td className="td text-muted">{r.status}</td>
                  <td className="td max-w-xs text-muted">{r.recommended_action ?? "—"}</td>
                  <td className="td whitespace-nowrap text-muted">{formatDateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
