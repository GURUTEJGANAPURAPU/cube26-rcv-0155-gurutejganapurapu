"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Download, Loader2, RotateCw, X, ZoomIn } from "lucide-react";

import { DemoTag, ErrorNote, PageHeader, VerdictBadge } from "@/components/ui";
import { CAPTURE_TYPES, CHECK_LABELS, type CheckKey, type EvidenceRecord } from "@/lib/types";
import { formatDateTime, percent } from "@/lib/utils";

interface Img { id: string; url: string | null; capture_type: string; quality_flags: string[]; ocr_text: string | null; barcode_value: string | null }
type Full = EvidenceRecord & { content_hash_verified: boolean };

export default function RecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [rec, setRec] = useState<Full | null>(null);
  const [images, setImages] = useState<Img[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Img | null>(null);
  const [busy, setBusy] = useState(false);
  const [ov, setOv] = useState<{ check_key: CheckKey | null; current: string } | null>(null);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([fetch(`/api/receiving/${id}/evidence`), fetch(`/api/receiving/${id}/images`)]);
    const ja = await a.json();
    if (!a.ok) return setError(ja.message);
    setRec(ja);
    if (b.ok) setImages((await b.json()).images);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function retry() {
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/receiving/${id}/retry`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) setError(j.message ?? "Retry failed.");
    load();
  }

  if (error && !rec) return <ErrorNote>{error}</ErrorNote>;
  if (!rec) return <div className="text-sm text-muted">Loading record…</div>;

  // The effective view is computed on the server from the append-only override
  // log; the agent's own verdicts are shown alongside it, never replaced.
  const effective = (key: string | null, original: string) =>
    (key === null ? rec.effective.decision : rec.effective.checks.find((c) => c.check_key === key)?.verdict) ?? original;
  const decision = rec.status === "complete" ? rec.outcome.decision : "PENDING";
  const effDecision = rec.status === "complete" ? rec.effective.decision : "PENDING";
  const imgIndex = new Map(images.map((im, i) => [im.id, i + 1]));

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title={`${rec.subject.unit_id ?? "Receiving unit"} · ${rec.subject.po_number}${rec.subject.po_line != null ? ` / ${rec.subject.po_line}` : ""}`}
        subtitle={`${rec.subject.supplier ?? ""} · ${rec.subject.sku ?? ""} · ${rec.subject.product_title ?? ""}`}
        actions={
          <div className="flex gap-2">
            <a className="btn" href={`/api/receiving/${id}/json`}><Download size={14} /> JSON</a>
            <Link className="btn" href="/inspection-queue">Queue</Link>
          </div>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}

      <section className="card grid gap-4 p-4 md:grid-cols-[auto_1fr_auto]">
        <div>
          <div className="label mb-1">Decision</div>
          <VerdictBadge value={effDecision} className="px-2.5 py-1 text-sm" />
          {effDecision !== decision && <div className="mt-1 text-xs text-muted">Agent: {decision} · overridden</div>}
          {rec.is_demo && <div className="mt-2"><DemoTag /></div>}
        </div>
        <div className="text-sm">
          <p>{rec.outcome.summary}</p>
          <p className="mt-1 text-muted"><span className="font-medium text-ink">Next action:</span> {rec.outcome.recommended_action}</p>
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted">
            {rec.outcome.inspection_coverage.map((c) => (
              <span key={c.group} title={c.explanation}>{c.group} coverage <span className="font-mono text-ink">{c.percent}%</span></span>
            ))}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {rec.status === "pending" || rec.status === "draft" ? (
            <button className="btn btn-primary" onClick={retry} disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />} Retry inspection</button>
          ) : (
            <button className="btn" onClick={() => setOv({ check_key: null, current: effDecision })}>Override decision</button>
          )}
        </div>
      </section>

      {rec.checks.length > 0 && (
        <section className="card overflow-x-auto">
          <table className="w-full">
            <thead><tr>{["Check", "Verdict", "Expected", "Observed", "Confidence", "Evidence", "Detail", ""].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>
              {rec.checks.map((c) => {
                const eff = effective(c.check_key, c.verdict);
                return (
                  <tr key={c.check_key}>
                    <td className="td font-medium">{CHECK_LABELS[c.check_key]}</td>
                    <td className="td whitespace-nowrap"><VerdictBadge value={eff} />{eff !== c.verdict && <div className="mt-0.5 text-[10px] text-muted">agent {c.verdict}</div>}</td>
                    <td className="td font-mono text-[13px]">{c.expected_value}</td>
                    <td className="td font-mono text-[13px]">{c.observed_value}</td>
                    <td className="td font-mono text-[13px]">{percent(c.confidence)}</td>
                    <td className="td whitespace-nowrap text-xs">
                      {c.evidence_image_ids.length ? c.evidence_image_ids.map((iid) => (
                        <button key={iid} className="mr-1 underline" onClick={() => setZoom(images.find((i) => i.id === iid) ?? null)}>#{imgIndex.get(iid) ?? "?"}</button>
                      )) : <span className="text-muted">none</span>}
                      {c.evidence_sufficiency === "insufficient" && <div className="text-unc">insufficient</div>}
                    </td>
                    <td className="td max-w-sm text-muted">{c.detail}{c.recommended_action && <div className="mt-1 text-ink">{c.recommended_action}</div>}</td>
                    <td className="td">{rec.status === "complete" && <button className="text-xs underline" onClick={() => setOv({ check_key: c.check_key, current: eff })}>Override</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <div className="label mb-2">Evidence images ({images.length})</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {images.map((im, i) => (
            <button key={im.id} className="card group relative overflow-hidden text-left" onClick={() => setZoom(im)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {im.url ? <img src={im.url} alt="" className="h-32 w-full object-cover" /> : <div className="h-32 bg-sunken" />}
              <ZoomIn size={16} className="absolute right-2 top-2 text-accent-ink opacity-0 drop-shadow group-hover:opacity-100" />
              <div className="px-2 py-1.5 text-xs">
                <span className="font-mono">#{i + 1}</span> {CAPTURE_TYPES.find((c) => c.key === im.capture_type)?.label ?? im.capture_type}
                {im.quality_flags.length > 0 && <div className="text-unc">{im.quality_flags.join(", ")}</div>}
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="grid gap-5 md:grid-cols-2">
        <div className="card p-4">
          <div className="label mb-2">Override history</div>
          {rec.overrides.length === 0 ? <p className="text-sm text-muted">No overrides. The agent verdicts stand.</p> : (
            <ul className="space-y-2 text-sm">
              {rec.overrides.map((o, i) => (
                <li key={i} className="border-l-2 border-line pl-3">
                  <div><span className="font-medium">{o.check_key ? CHECK_LABELS[o.check_key as CheckKey] ?? o.check_key : "Overall decision"}</span>: <VerdictBadge value={o.original_verdict} /> → <VerdictBadge value={o.new_verdict} /></div>
                  <div className="text-muted">{o.reason}</div>
                  <div className="text-xs text-muted">{o.operator} · {formatDateTime(o.created_at)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card p-4 text-sm">
          <div className="label mb-2">Record</div>
          <dl className="space-y-1.5">
            {[
              ["Status", rec.status],
              ["Captured", formatDateTime(rec.captured_at)],
              ["Inspected", formatDateTime(rec.inspection_completed_at)],
              ["Latency", rec.latency_ms != null ? `${rec.latency_ms} ms` : "—"],
              ["Model", rec.agent.model_version ?? "—"],
              ["Prompt", rec.agent.prompt_version ?? "—"],
              ["Schema", rec.schema_version],
            ].map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="font-mono text-[12px]">{v}</dd></div>)}
            <div className="pt-1">
              <dt className="text-muted">Content hash (SHA-256 integrity reference)</dt>
              <dd className="break-all font-mono text-[11px]">{rec.content_hash} <span className={rec.content_hash_verified ? "text-pass" : "text-fail"}>{rec.content_hash_verified ? "· matches" : "· does not match"}</span></dd>
            </div>
          </dl>
        </div>
      </section>

      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6" onClick={() => setZoom(null)}>
          <button className="absolute right-4 top-4 text-accent-ink" aria-label="Close"><X /></button>
          <div className="max-h-full max-w-5xl overflow-auto" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {zoom.url && <img src={zoom.url} alt="" className="max-h-[80vh] cursor-zoom-in rounded" onClick={(e) => e.currentTarget.classList.toggle("scale-150")} />}
            {(zoom.ocr_text || zoom.barcode_value) && (
              <div className="mt-2 rounded bg-surface p-2 font-mono text-[11px] text-muted">
                {zoom.barcode_value && <div>Barcode (local): {zoom.barcode_value}</div>}
                {zoom.ocr_text && <div className="line-clamp-3">OCR (local): {zoom.ocr_text}</div>}
              </div>
            )}
          </div>
        </div>
      )}

      {ov && <OverrideDialog recordId={id} target={ov} onClose={() => setOv(null)} onDone={() => { setOv(null); load(); }} />}
    </div>
  );
}

function OverrideDialog({ recordId, target, onClose, onDone }: { recordId: string; target: { check_key: CheckKey | null; current: string }; onClose: () => void; onDone: () => void }) {
  const options = target.check_key ? ["PASS", "FAIL", "UNCERTAIN"] : ["PASS", "EXCEPTION", "UNCERTAIN"];
  const [verdict, setVerdict] = useState(options.find((o) => o !== target.current) ?? options[0]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    const r = await fetch(`/api/receiving/${recordId}/override`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ check_key: target.check_key, new_verdict: verdict, reason }) });
    const j = await r.json();
    if (!r.ok) return setError(j.message);
    onDone();
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-md space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold">Override {target.check_key ? CHECK_LABELS[target.check_key] : "decision"}</h2>
        <p className="text-sm text-muted">The agent verdict is preserved; this adds an entry to the override history.</p>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex gap-2">{options.map((o) => <button key={o} className={o === verdict ? "btn btn-primary" : "btn"} onClick={() => setVerdict(o)}>{o}</button>)}</div>
        <textarea className="input h-24" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit} disabled={reason.trim().length < 5}>Save override</button></div>
      </div>
    </div>
  );
}
