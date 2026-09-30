#!/usr/bin/env python3
"""Scores Receiving Manager predictions against hand labels.

Inputs
  evaluation/labels/labels.csv       one row per (unit_id, check_key) with the true verdict
                                     (PASS / FAIL / UNCERTAIN) plus a row with check_key=_decision
  evaluation/results/predictions/    one evidence-record JSON per unit, downloaded from
                                     GET /api/receiving/<id>/json

Output
  evaluation/results/report.json     read by the /evaluation page

Nothing is estimated: if there are no predictions, the script says so and exits.
"""
import csv
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LABELS = ROOT / "labels" / "labels.csv"
PRED_DIR = ROOT / "results" / "predictions"
OUT = ROOT / "results" / "report.json"


def load_labels():
    """Returns (labels, second_pass).

    `second_verdict` is an optional column holding a second human labeller's
    verdict. When it is absent or empty everywhere, human agreement is
    reported as "Not measured" rather than invented.
    """
    labels = defaultdict(dict)
    second = defaultdict(dict)
    with LABELS.open(newline="") as f:
        for row in csv.DictReader(f):
            if row["unit_id"].startswith("#"):
                continue
            unit = row["unit_id"].strip()
            key = row["check_key"].strip()
            labels[unit][key] = row["true_verdict"].strip().upper()
            other = (row.get("second_verdict") or "").strip().upper()
            if other:
                second[unit][key] = other
    return labels, second


def load_predictions():
    preds, meta = {}, {"model_version": None, "prompt_version": None}
    for p in sorted(PRED_DIR.glob("*.json")):
        rec = json.loads(p.read_text())
        unit = rec.get("subject", {}).get("unit_id")
        if not unit:
            continue
        checks = {c["check_key"]: c["verdict"] for c in rec.get("checks", [])}
        checks["_decision"] = rec.get("outcome", {}).get("decision")
        preds[unit] = checks
        meta["model_version"] = rec.get("agent", {}).get("model_version") or meta["model_version"]
        meta["prompt_version"] = rec.get("agent", {}).get("prompt_version") or meta["prompt_version"]
    return preds, meta


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def main():
    if not LABELS.exists():
        sys.exit(f"Missing {LABELS}")
    labels, second = load_labels()
    preds, meta = load_predictions() if PRED_DIR.exists() else ({}, {})
    units = [u for u in labels if u in preds]
    if not units:
        sys.exit("No predictions match the labelled units. Download evidence JSON into evaluation/results/predictions/ first.")

    # Positive class = FAIL, i.e. "this check found a real problem". UNCERTAIN
    # is neither a positive nor a negative prediction: it is counted in its own
    # column, because abstaining is a designed outcome and must not be scored
    # as if the agent had guessed.
    def blank():
        return {"labelled": 0, "correct": 0, "uncertain": 0, "tp": 0, "tn": 0, "fp": 0, "fn": 0,
                "false_pass": 0, "false_fail": 0, "missed_by_abstention": 0}

    per = defaultdict(blank)
    dec_total = dec_ok = unc = 0
    agree_total = agree_ok = 0

    for u in units:
        for key, truth in labels[u].items():
            got = preds[u].get(key)
            if got is None:
                continue
            other = second.get(u, {}).get(key)
            if other:
                agree_total += 1
                agree_ok += other == truth
            if key == "_decision":
                dec_total += 1
                dec_ok += got == truth
                unc += got == "UNCERTAIN"
                continue
            s = per[key]
            s["labelled"] += 1
            s["correct"] += got == truth
            if got == "UNCERTAIN":
                s["uncertain"] += 1
                if truth == "FAIL":
                    s["missed_by_abstention"] += 1
            elif got == "FAIL" and truth == "FAIL":
                s["tp"] += 1
            elif got == "PASS" and truth == "PASS":
                s["tn"] += 1
            elif got == "FAIL" and truth == "PASS":
                s["fp"] += 1
                s["false_fail"] += 1
            elif got == "PASS" and truth == "FAIL":
                s["fn"] += 1
                s["false_pass"] += 1
            elif truth == "UNCERTAIN":
                # The agent committed where a human could not. Not a
                # precision/recall event, but it is not correct either.
                pass

    for s in per.values():
        s["accuracy"] = ratio(s["correct"], s["labelled"])
        s["precision"] = ratio(s["tp"], s["tp"] + s["fp"])
        s["recall"] = ratio(s["tp"], s["tp"] + s["fn"])
        p_, r_ = s["precision"], s["recall"]
        s["f1"] = ratio(2 * p_ * r_, p_ + r_) if p_ is not None and r_ is not None and (p_ + r_) else None
        s["abstention_rate"] = ratio(s["uncertain"], s["labelled"])

    totals = {k: sum(s[k] for s in per.values()) for k in ("tp", "tn", "fp", "fn", "labelled", "uncertain")}
    micro_p = ratio(totals["tp"], totals["tp"] + totals["fp"])
    micro_r = ratio(totals["tp"], totals["tp"] + totals["fn"])

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model_version": meta.get("model_version"),
        "prompt_version": meta.get("prompt_version"),
        "units_evaluated": len(units),
        "checks_labelled": totals["labelled"],
        "positive_class": "FAIL (a check that found a real problem). UNCERTAIN is scored separately as abstention.",
        "overall": {
            "decision_accuracy": ratio(dec_ok, dec_total),
            "uncertain_rate": ratio(unc, dec_total) or 0,
            "false_pass_count": sum(s["false_pass"] for s in per.values()),
            "false_fail_count": sum(s["false_fail"] for s in per.values()),
            "check_abstention_rate": ratio(totals["uncertain"], totals["labelled"]),
            "micro_precision": micro_p,
            "micro_recall": micro_r,
            "micro_f1": ratio(2 * micro_p * micro_r, micro_p + micro_r)
            if micro_p is not None and micro_r is not None and (micro_p + micro_r)
            else None,
            "human_agreement": ratio(agree_ok, agree_total)
            if agree_total
            else "Not measured (no second_verdict column in labels.csv)",
            "human_agreement_pairs": agree_total,
        },
        "per_check": dict(sorted(per.items())),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    print(json.dumps(report["overall"], indent=2))
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
