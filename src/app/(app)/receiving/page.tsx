"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, Check, Loader2 } from "lucide-react";

import { DemoTag, Empty, ErrorNote, PageHeader } from "@/components/ui";
import { CAPTURE_TYPES, type CaptureType } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Line { id: string; po_line: number; sku: string; product_title: string; qty_ordered: number; cartons_ordered: number; units_per_carton_ordered: number; unit_id: string | null }
interface PO { id: string; po_number: string; supplier: string; is_demo: boolean; purchase_order_lines: Line[] }
interface Shot { key: string; type: CaptureType; name: string; preview: string; flags: string[]; state: "uploading" | "enriching" | "done" | "error"; imageId?: string; error?: string }

export default function ReceivingPage() {
  const router = useRouter();
  const [pos, setPos] = useState<PO[] | null>(null);
  const [lineId, setLineId] = useState("");
  const [recordId, setRecordId] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/purchase-orders").then(async (r) => {
      const j = await r.json();
      if (!r.ok) return setError(j.message);
      setPos(j.purchase_orders);
    });
  }, []);

  const selected = useMemo(() => {
    for (const po of pos ?? []) for (const l of po.purchase_order_lines) if (l.id === lineId) return { po, line: l };
    return null;
  }, [pos, lineId]);

  const doneTypes = new Set(shots.filter((s) => s.state === "done").map((s) => s.type));
  const required = CAPTURE_TYPES.filter((c) => c.required);
  const requiredDone = required.filter((c) => doneTypes.has(c.key)).length;

  async function ensureRecord(): Promise<string | null> {
    if (recordId) return recordId;
    const r = await fetch("/api/receiving", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ po_line_id: lineId }) });
    const j = await r.json();
    if (!r.ok) { setError(j.message); return null; }
    setRecordId(j.id);
    return j.id;
  }

  async function addFiles(type: CaptureType, files: File[]) {
    if (!files.length) return;

    setError(null);

    const id = await ensureRecord();
    if (!id) return;

    for (const file of Array.from(files)) {
      const key = crypto.randomUUID();
      const preview = URL.createObjectURL(file);

      setShots((s) => [
        ...s,
        {
          key,
          type,
          name: file.name,
          preview,
          flags: [],
          state: "uploading",
        },
      ]);

      let imageId: string | undefined;

      try {
        /*
         * PRIMARY OPERATION:
         * Upload the ORIGINAL file immediately.
         *
         * Do not run image processing, OCR, barcode detection or quality
         * analysis before this request. Those client-side operations can be
         * slow and must never block evidence capture.
         */
        const form = new FormData();
        form.set("file", file);
        form.set("capture_type", type);

        const uploadResponse = await fetch(`/api/receiving/${id}/images`, {
          method: "POST",
          body: form,
        });

        const uploadJson = await uploadResponse.json().catch(() => ({}));

        if (!uploadResponse.ok) {
          throw new Error(uploadJson.message ?? "Image upload failed.");
        }

        imageId = uploadJson.image?.id as string | undefined;

        if (!imageId) {
          throw new Error("Upload succeeded but the server did not return an image ID.");
        }

        // Evidence is safely stored. Only now start optional enrichment.
        setShots((s) =>
          s.map((x) =>
            x.key === key
              ? {
                  ...x,
                  imageId,
                  state: "enriching",
                }
              : x,
          ),
        );
      } catch (e) {
        setShots((s) =>
          s.map((x) =>
            x.key === key
              ? {
                  ...x,
                  state: "error",
                  error: e instanceof Error ? e.message : "Image upload failed.",
                }
              : x,
          ),
        );
        continue;
      }

      /*
       * OPTIONAL LOCAL ENRICHMENT
       *
       * Everything below is supporting evidence only. If it fails or takes
       * too long, the uploaded image must remain usable for inspection.
       */
      let prepared: { blob: Blob; width: number; height: number } | null = null;
      let quality = {
        score: undefined as number | undefined,
        flags: [] as string[],
      };
      let ocr = "";
      let barcodes: string[] = [];

      try {
        // Dynamically load browser-only enrichment code ONLY after the upload
        // has succeeded. This keeps the evidence-capture path independent
        // from canvas/Tesseract/barcode processing.
        const { prepareImage, assessQuality } = await import("@/lib/image/quality");
        prepared = await prepareImage(file);

        try {
          const assessed = await assessQuality(prepared.blob);
          quality = {
            score: assessed.score,
            flags: assessed.flags ?? [],
          };
        } catch {
          // Quality analysis is optional.
        }

        if (type === "carton_label" || type === "product") {
          const [ocrResult, barcodeResult] = await Promise.allSettled([
            (async () => {
              try {
                return await (await import("@/lib/ocr/tesseract")).extractText(prepared!.blob);
              } catch {
                return "";
              }
            })(),
            (async () => {
              try {
                return await (await import("@/lib/barcode/zxing")).readBarcode(prepared!.blob);
              } catch {
                return [];
              }
            })(),
          ]);

          if (ocrResult.status === "fulfilled") {
            ocr = ocrResult.value;
          }

          if (barcodeResult.status === "fulfilled") {
            barcodes = barcodeResult.value;
          }
        }
      } catch {
        // Image processing is optional. Keep the uploaded evidence.
      }

      /*
       * Persist supporting metadata when available.
       *
       * If PATCH fails, the primary image is still successfully uploaded.
       */
      if (imageId) {
        try {
          const patchBody: Record<string, unknown> = {
            ocr_text: ocr.slice(0, 8000),
            barcode_value: barcodes.join(",").slice(0, 500),
            quality_flags: quality.flags,
          };

          if (quality.score !== undefined) {
            patchBody.quality_score = quality.score;
          }

          if (prepared) {
            patchBody.width = prepared.width;
            patchBody.height = prepared.height;
          }

          await fetch(`/api/receiving/${id}/images/${imageId}`, {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(patchBody),
          });
        } catch {
          // Supporting metadata is non-blocking.
        }
      }

      // The image is usable even when enrichment failed.
      setShots((s) =>
        s.map((x) =>
          x.key === key
            ? {
                ...x,
                state: "done",
                imageId,
                flags: quality.flags,
              }
            : x,
        ),
      );
    }
  }

  async function inspect() {
    if (!recordId) return;
    setBusy("Running inspection…");
    setError(null);
    const r = await fetch(`/api/receiving/${recordId}/inspect`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    // Pending outcomes still open the record: the capture is saved and retryable.
    if (r.ok || j.status === "pending") return router.push(`/evidence/${recordId}`);
    setError(j.message ?? "Inspection could not start.");
  }

  return (
    <div className="max-w-6xl">
      <PageHeader title="Receiving" subtitle="Select the purchase-order line, capture the guided views, then inspect." />
      {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <section className="card p-4">
            <div className="label mb-2">1 · Purchase-order line</div>
            {pos === null ? (
              <div className="text-sm text-muted">Loading purchase orders…</div>
            ) : pos.length === 0 ? (
              <Empty>No purchase orders yet. <Link className="underline" href="/purchase-orders">Import purchase orders</Link> first.</Empty>
            ) : (
              <select className="input" value={lineId} disabled={!!recordId} onChange={(e) => setLineId(e.target.value)}>
                <option value="">Choose a line…</option>
                {pos.map((po) => (
                  <optgroup key={po.id} label={`${po.po_number} — ${po.supplier}${po.is_demo ? " (DEMO)" : ""}`}>
                    {po.purchase_order_lines.map((l) => (
                      <option key={l.id} value={l.id}>
                        Line {l.po_line} · {l.sku} · {l.product_title}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </section>

          <section className={cn("card p-4", !selected && "pointer-events-none opacity-50")}>
            <div className="mb-3 flex items-center justify-between">
              <div className="label">2 · Guided capture</div>
              <div className="text-xs text-muted">{requiredDone} of {required.length} required views</div>
            </div>
            <div className="mb-4 h-1 rounded bg-sunken">
              <div className="h-1 rounded bg-accent transition-all" style={{ width: `${(requiredDone / required.length) * 100}%` }} />
            </div>
            <div className="divide-y divide-line">
              {CAPTURE_TYPES.map((c) => {
                const mine = shots.filter((s) => s.type === c.key);
                return (
                  <div key={c.key} className="flex gap-4 py-3">
                    <div className="w-5 pt-0.5">{doneTypes.has(c.key) ? <Check size={16} className="text-pass" /> : <span className="block h-3.5 w-3.5 rounded-full border border-line" />}</div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{c.label} {!c.required && <span className="text-xs font-normal text-muted">optional</span>}</div>
                      <div className="text-xs text-muted">{c.hint}</div>
                      {mine.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {mine.map((s) => (
                            <div key={s.key} className="w-24">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={s.preview} alt={s.name} className="h-16 w-24 rounded border border-line object-cover" />
                              <div className="mt-0.5 truncate text-[10px] text-muted">
                                {s.state === "uploading" ? "Uploading…" : s.state === "enriching" ? "Saved · reading evidence…" : s.state === "error" ? <span className="text-fail">{s.error}</span> : s.flags.length ? <span className="text-unc">{s.flags.join(", ")}</span> : "Saved"}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <label className="btn h-fit cursor-pointer">
                      <Camera size={14} /> Add
                      <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple className="hidden" onChange={(e) => {
                        const selectedFiles = e.currentTarget.files
                          ? Array.from(e.currentTarget.files)
                          : [];
                        e.currentTarget.value = "";
                        void addFiles(c.key, selectedFiles);
                      }} />
                    </label>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="flex items-center gap-3">
            <button className="btn btn-primary" disabled={!recordId || !!busy || shots.some((s) => s.state === "uploading" || s.state === "enriching") || doneTypes.size === 0} onClick={inspect}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : null} {busy ?? "Inspect receiving unit"}
            </button>
            {recordId && requiredDone < required.length && (
              <span className="text-xs text-unc">Missing views make the affected checks UNCERTAIN rather than guessed.</span>
            )}
          </div>
        </div>

        <aside className="card h-fit p-4">
          <div className="label mb-3">Expected (purchase order)</div>
          {selected ? (
            <dl className="space-y-2 text-sm">
              {[
                ["PO", `${selected.po.po_number} / line ${selected.line.po_line}`],
                ["Supplier", selected.po.supplier],
                ["SKU", selected.line.sku],
                ["Product", selected.line.product_title],
                ["Unit ID", selected.line.unit_id ?? "—"],
                ["Cartons", selected.line.cartons_ordered],
                ["Units / carton", selected.line.units_per_carton_ordered],
                ["Total units", selected.line.qty_ordered],
              ].map(([k, v]) => (
                <div key={String(k)} className="flex justify-between gap-3">
                  <dt className="text-muted">{k}</dt>
                  <dd className="text-right font-mono text-[13px]">{String(v)}</dd>
                </div>
              ))}
              {selected.po.is_demo && <div className="pt-1"><DemoTag /> <span className="text-xs text-muted">synthetic reference data</span></div>}
            </dl>
          ) : (
            <p className="text-sm text-muted">Choose a line to see what the delivery should contain. Observed values appear on the decision screen.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
