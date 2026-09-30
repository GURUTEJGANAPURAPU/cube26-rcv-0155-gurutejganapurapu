import { readFile } from "node:fs/promises";
import path from "node:path";

import { Empty, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Evaluation · Receiving Manager" };

interface CheckStats {
  labelled: number;
  correct: number;
  accuracy: number | null;
  uncertain: number;
  false_pass: number;
  false_fail: number;
  tp: number;
  tn: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  abstention_rate: number | null;
  missed_by_abstention: number;
}

interface Report {
  generated_at: string;
  model_version: string | null;
  prompt_version: string | null;
  units_evaluated: number;
  checks_labelled?: number;
  positive_class?: string;
  overall: {
    decision_accuracy: number | null;
    uncertain_rate: number;
    false_pass_count: number;
    false_fail_count?: number;
    check_abstention_rate?: number | null;
    micro_precision?: number | null;
    micro_recall?: number | null;
    micro_f1?: number | null;
    human_agreement?: number | string | null;
    human_agreement_pairs?: number;
  };
  per_check: Record<string, CheckStats>;
}

async function loadReport(): Promise<Report | null> {
  try {
    return JSON.parse(await readFile(path.join(process.cwd(), "evaluation", "results", "report.json"), "utf8"));
  } catch {
    return null;
  }
}

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export default async function EvaluationPage() {
  const report = await loadReport();
  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader title="Evaluation" subtitle="Measured results from evaluation/run_eval.py against hand-labelled evidence. Nothing here is estimated." />
      {!report ? (
        <Empty>
          No evaluation has been run yet. Label real photos in <code className="font-mono">evaluation/labels/labels.csv</code>, export predictions,
          then run <code className="font-mono">npm run eval</code>. See EVALUATION.md.
        </Empty>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              ["Units evaluated", String(report.units_evaluated)],
              ["Decision accuracy", pct(report.overall.decision_accuracy)],
              ["UNCERTAIN rate (decisions)", pct(report.overall.uncertain_rate)],
              ["False PASS (checks)", String(report.overall.false_pass_count)],
              ["Micro precision", pct(report.overall.micro_precision ?? null)],
              ["Micro recall", pct(report.overall.micro_recall ?? null)],
              ["Micro F1", pct(report.overall.micro_f1 ?? null)],
              [
                "Human agreement",
                typeof report.overall.human_agreement === "number"
                  ? `${pct(report.overall.human_agreement)} (${report.overall.human_agreement_pairs} pairs)`
                  : "Not measured",
              ],
            ].map(([k, v]) => <div key={k} className="card p-3"><div className="label">{k}</div><div className="mt-1 font-mono text-xl">{v}</div></div>)}
          </div>
          <p className="text-xs text-muted">
            Positive class: {report.positive_class ?? "FAIL"}. UNCERTAIN is an abstention, scored in its own column and never
            counted as a correct or incorrect commitment.
          </p>
          <div className="card overflow-x-auto">
            <table className="w-full">
              <thead><tr>{["Check", "Labelled", "Accuracy", "TP", "TN", "FP", "FN", "Precision", "Recall", "F1", "Abstained", "False PASS"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
              <tbody>
                {Object.entries(report.per_check).map(([k, v]) => (
                  <tr key={k}>
                    <td className="td font-mono text-[13px]">{k}</td>
                    <td className="td">{v.labelled}</td>
                    <td className="td">{pct(v.accuracy)}</td>
                    <td className="td">{v.tp}</td>
                    <td className="td">{v.tn}</td>
                    <td className="td">{v.fp}</td>
                    <td className="td">{v.fn}</td>
                    <td className="td">{pct(v.precision)}</td>
                    <td className="td">{pct(v.recall)}</td>
                    <td className="td">{pct(v.f1)}</td>
                    <td className="td">{v.uncertain} ({pct(v.abstention_rate)})</td>
                    <td className={v.false_pass > 0 ? "td text-fail" : "td"}>{v.false_pass}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">
            Generated {report.generated_at} · model {report.model_version ?? "—"} · prompt {report.prompt_version ?? "—"} ·{" "}
            {report.checks_labelled ?? 0} labelled checks
          </p>
        </>
      )}
    </div>
  );
}
