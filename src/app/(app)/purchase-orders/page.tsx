"use client";

import { useCallback, useEffect, useState } from "react";
import { PenLine, Upload } from "lucide-react";

import { DemoTag, Empty, ErrorNote, PageHeader } from "@/components/ui";
import { validateRows, type ImportIssue } from "@/lib/po/import";
import { importFromCsv, importFromJson } from "@/lib/po/import";

interface Line { id: string; po_line: number; sku: string; product_title: string; qty_ordered: number; cartons_ordered: number; units_per_carton_ordered: number; unit_id: string | null }
interface PO { id: string; po_number: string; supplier: string; is_demo: boolean; purchase_order_lines: Line[] }

export default function PurchaseOrdersPage() {
  const [pos, setPos] = useState<PO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [manual, setManual] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/purchase-orders");
    const j = await r.json();
    if (!r.ok) return setError(j.message);
    setPos(j.purchase_orders);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null); setNote(null);
    const text = await file.text();
    const result = file.name.endsWith(".json") ? importFromJson(text) : importFromCsv(text);
    setIssues(result.issues);
    if (result.lines.length === 0) return setError("No valid rows found in that file.");
    const r = await fetch("/api/purchase-orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines: result.lines }) });
    const j = await r.json();
    if (!r.ok) return setError(j.message);
    setNote(`Imported ${result.lines.length} line(s).`);
    load();
  }

  return (
    <div className="max-w-6xl space-y-4">
      <PageHeader
        title="Purchase orders"
        subtitle="The expected side of every inspection. Enter a line by hand, or import CSV or JSON with the sample-file columns."
        actions={
          <div className="flex gap-2">
            <button className="btn" onClick={() => setManual((m) => !m)}><PenLine size={14} /> {manual ? "Close form" : "Enter manually"}</button>
            <label className="btn btn-primary cursor-pointer"><Upload size={14} /> Import file<input type="file" accept=".csv,.json" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
          </div>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {manual && (
        <ManualLineForm
          onSaved={(message, foundIssues) => { setNote(message); setIssues(foundIssues); setError(null); load(); }}
          onError={(m) => setError(m)}
        />
      )}
      {note && <div className="rounded border border-pass bg-pass-bg px-3 py-2 text-sm text-pass">{note}</div>}
      {issues.length > 0 && (
        <div className="card p-3 text-sm">
          <div className="label mb-1">Import findings ({issues.length})</div>
          <ul className="max-h-40 space-y-0.5 overflow-auto text-muted">{issues.map((i, k) => <li key={k}>Row {i.row}: {i.message}</li>)}</ul>
        </div>
      )}
      {pos === null ? <div className="text-sm text-muted">Loading…</div> : pos.length === 0 ? <Empty>No purchase orders yet.</Empty> : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead><tr>{["PO", "Supplier", "Line", "SKU", "Product", "Cartons", "Units/carton", "Total"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>
              {pos.flatMap((po) => po.purchase_order_lines.sort((a, b) => a.po_line - b.po_line).map((l, i) => (
                <tr key={l.id}>
                  <td className="td font-mono text-[13px]">{i === 0 ? <>{po.po_number} {po.is_demo && <DemoTag />}</> : ""}</td>
                  <td className="td">{i === 0 ? po.supplier : ""}</td>
                  <td className="td font-mono text-[13px]">{l.po_line}</td>
                  <td className="td font-mono text-[13px]">{l.sku}</td>
                  <td className="td">{l.product_title}</td>
                  <td className="td font-mono text-[13px]">{l.cartons_ordered}</td>
                  <td className="td font-mono text-[13px]">{l.units_per_carton_ordered}</td>
                  <td className="td font-mono text-[13px]">{l.qty_ordered}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Manual purchase-order entry. It validates through the SAME schema as CSV and
 * JSON import (`validateRows`), so a hand-typed line is checked exactly like an
 * imported one — including the qty_ordered = cartons × units-per-carton
 * consistency finding, which is reported and never silently corrected.
 */
const FIELDS: { key: string; label: string; type?: string; required?: boolean; hint?: string }[] = [
  { key: "po_number", label: "PO number", required: true },
  { key: "supplier", label: "Supplier", required: true },
  { key: "po_line", label: "PO line", type: "number", required: true },
  { key: "unit_id", label: "Unit ID", hint: "Optional receiving-unit reference" },
  { key: "sku", label: "SKU", required: true },
  { key: "asin", label: "ASIN", hint: "Optional" },
  { key: "product_title", label: "Product title", required: true },
  { key: "spec_colour", label: "Colour", hint: "Leave blank if the PO does not specify one" },
  { key: "spec_variant", label: "Variant", hint: "Leave blank if the PO does not specify one" },
  { key: "spec_components", label: "Components", hint: "Separate with semicolons" },
  { key: "cartons_ordered", label: "Cartons ordered", type: "number", required: true },
  { key: "units_per_carton_ordered", label: "Units per carton", type: "number", required: true },
  { key: "qty_ordered", label: "Total units ordered", type: "number", required: true },
];

function ManualLineForm({
  onSaved,
  onError,
}: {
  onSaved: (message: string, issues: ImportIssue[]) => void;
  onError: (message: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [localIssues, setLocalIssues] = useState<ImportIssue[]>([]);
  const [saving, setSaving] = useState(false);

  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));

  const cartons = Number.parseInt(values.cartons_ordered ?? "", 10);
  const perCarton = Number.parseInt(values.units_per_carton_ordered ?? "", 10);
  const derived = Number.isFinite(cartons) && Number.isFinite(perCarton) ? cartons * perCarton : null;
  const total = Number.parseInt(values.qty_ordered ?? "", 10);
  const mismatch = derived !== null && Number.isFinite(total) && derived !== total;

  async function submit() {
    setSaving(true);
    setLocalIssues([]);
    const { lines, issues } = validateRows([values]);
    if (lines.length === 0) {
      setLocalIssues(issues);
      setSaving(false);
      return;
    }
    const r = await fetch("/api/purchase-orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines }),
    });
    const j = await r.json();
    setSaving(false);
    if (!r.ok) return onError(j.message ?? "The purchase-order line could not be saved.");
    setValues({});
    onSaved(`Saved PO line ${lines[0].po_number} / ${lines[0].po_line}.`, [...issues, ...(j.issues ?? [])]);
  }

  return (
    <section className="card space-y-4 p-4">
      <div className="label">Manual purchase-order line</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="label">
              {f.label} {f.required && <span className="text-fail">*</span>}
            </span>
            <input
              className="input mt-1"
              type={f.type ?? "text"}
              value={values[f.key] ?? ""}
              onChange={(e) => set(f.key, e.target.value)}
            />
            {f.hint && <span className="text-[11px] text-muted">{f.hint}</span>}
          </label>
        ))}
      </div>
      {mismatch && (
        <p className="rounded border border-unc bg-unc-bg px-3 py-2 text-sm text-unc">
          Total units ({total}) does not equal {cartons} × {perCarton} = {derived}. The line will be saved exactly as typed
          and the difference recorded as a finding — it is not corrected for you.
        </p>
      )}
      {localIssues.length > 0 && (
        <ul className="space-y-0.5 text-sm text-fail">
          {localIssues.map((i, k) => (
            <li key={k}>
              {i.field}: {i.message}
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">
        <button className="btn btn-primary" onClick={submit} disabled={saving}>
          {saving ? "Saving…" : "Save purchase-order line"}
        </button>
      </div>
    </section>
  );
}
