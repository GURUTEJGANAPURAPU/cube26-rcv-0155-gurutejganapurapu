# Evaluation

No evaluation numbers are included in this repository, because none have been measured yet. The sample CSV is
synthetic and its photo paths do not exist, so it cannot be used to score visual accuracy.

## How to run

1. Photograph real receiving units (all five views) and inspect them in the app.
2. For each unit add rows to `evaluation/labels/labels.csv`: one per check (`identity`, `carton_count`, …) with
   the true verdict, plus `_decision` with the true overall decision. Label from the photos, not from the PO.
3. Download each unit's evidence JSON (`/api/receiving/<id>/json`) into `evaluation/results/predictions/`.
4. `npm run eval` → writes `evaluation/results/report.json`, shown on the Evaluation screen.

## Metrics

- Per-check accuracy, UNCERTAIN count, false PASS (said PASS, truth FAIL) and false FAIL.
- Overall decision accuracy and UNCERTAIN rate.

False PASS is the most costly error in receiving; the design prefers UNCERTAIN over guessing to keep it low.
Report the model id and prompt version with every result (both are recorded automatically).
