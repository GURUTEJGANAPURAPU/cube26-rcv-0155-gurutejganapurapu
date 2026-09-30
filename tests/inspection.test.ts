import { describe, expect, it } from "vitest";

import { parseInspectionPayload } from "@/lib/ai/gemini";
import { runChecks } from "@/lib/inspection/checks";
import { computeCoverage, decide, pendingOutcome } from "@/lib/inspection/decision";
import { CHECK_KEYS } from "@/lib/types";
import { cleanVision, expected, meta } from "./fixtures";

const byKey = (checks: ReturnType<typeof runChecks>, k: string) => checks.find((c) => c.check_key === k)!;

describe("runChecks", () => {
  it("returns one result for every check key", () => {
    const checks = runChecks(expected, cleanVision(), undefined, meta);
    expect(checks.map((c) => c.check_key).sort()).toEqual([...CHECK_KEYS].sort());
  });

  it("passes every check for clean, matching evidence", () => {
    const checks = runChecks(expected, cleanVision(), undefined, meta);
    expect(checks.filter((c) => c.verdict !== "PASS").map((c) => c.check_key)).toEqual([]);
  });

  it("fails identity when the label SKU differs", () => {
    const v = cleanVision();
    v.observations.sku.value = "SKU-CANDLE-6";
    v.observations.product_title.value = "Soy Candle Six";
    expect(byKey(runChecks(expected, v, undefined, meta), "identity").verdict).toBe("FAIL");
  });

  it("marks identity UNCERTAIN when the label is unreadable", () => {
    const v = cleanVision();
    v.evidence_sufficiency.identity = "insufficient";
    v.observations.sku.value = null;
    v.observations.product_title.value = null;
    v.observations.asin.value = null;
    expect(byKey(runChecks(expected, v, undefined, meta), "identity").verdict).toBe("UNCERTAIN");
  });

  it("fails carton count on a visible short shipment", () => {
    const v = cleanVision();
    v.observations.cartons_visible.value = 1;
    v.quantity_evidence.cartons_fully_counted = 1;
    expect(byKey(runChecks(expected, v, undefined, meta), "carton_count").verdict).toBe("FAIL");
  });

  it("computes total quantity in code, never trusting a model total", () => {
    const v = cleanVision();
    v.observations.units_per_carton_visible.value = 10;
    v.observations.units_visible.value = 24; // inconsistent model total must not rescue it
    const total = byKey(runChecks(expected, v, undefined, meta), "total_quantity");
    expect(total.verdict).not.toBe("PASS");
  });

  it("does not guess totals from partial quantity coverage", () => {
    const v = cleanVision();
    v.quantity_evidence.coverage = "partial";
    v.evidence_sufficiency.quantity = "insufficient";
    v.quantity_evidence.cartons_fully_counted = 1;
    expect(byKey(runChecks(expected, v, undefined, meta), "total_quantity").verdict).toBe("UNCERTAIN");
  });

  it("fails colour on a clear mismatch", () => {
    const v = cleanVision();
    v.observations.colour.value = "black";
    expect(byKey(runChecks(expected, v, undefined, meta), "colour").verdict).toBe("FAIL");
  });

  it("marks colour UNCERTAIN when evidence is insufficient", () => {
    const v = cleanVision();
    v.evidence_sufficiency.colour = "insufficient";
    v.observations.colour.value = null;
    expect(byKey(runChecks(expected, v, undefined, meta), "colour").verdict).toBe("UNCERTAIN");
  });

  it("fails carton crushing when crushing is observed", () => {
    const v = cleanVision();
    v.observations.carton_damage.types = ["crushed"];
    expect(byKey(runChecks(expected, v, undefined, meta), "carton_crushing").verdict).toBe("FAIL");
  });

  it("marks damage checks UNCERTAIN when damage views are missing", () => {
    const v = cleanVision();
    v.evidence_sufficiency.damage = "insufficient";
    const checks = runChecks(expected, v, undefined, meta);
    expect(byKey(checks, "unit_damage").verdict).toBe("UNCERTAIN");
  });

  it("carries model and prompt version on every check", () => {
    for (const c of runChecks(expected, cleanVision(), undefined, meta)) {
      expect(c.model_version).toBe("test-model");
      expect(c.prompt_version).toBe("test-prompt");
    }
  });
});

describe("decide", () => {
  it("returns PASS when all checks pass", () => {
    expect(decide(runChecks(expected, cleanVision(), undefined, meta)).decision).toBe("PASS");
  });

  it("returns EXCEPTION when any check fails", () => {
    const v = cleanVision();
    v.observations.colour.value = "black";
    expect(decide(runChecks(expected, v, undefined, meta)).decision).toBe("EXCEPTION");
  });

  it("returns UNCERTAIN, never EXCEPTION, when checks are only uncertain", () => {
    const v = cleanVision();
    v.evidence_sufficiency.colour = "insufficient";
    v.observations.colour.value = null;
    const out = decide(runChecks(expected, v, undefined, meta));
    expect(out.decision).toBe("UNCERTAIN");
    expect(out.failed_checks).toEqual([]);
  });

  it("pendingOutcome is PENDING with a recommended action", () => {
    const out = pendingOutcome("model timed out");
    expect(out.decision).toBe("PENDING");
    expect(out.recommended_action.length).toBeGreaterThan(0);
  });

  it("coverage reflects insufficient evidence", () => {
    const v = cleanVision();
    v.evidence_sufficiency.damage = "insufficient";
    const cov = computeCoverage(runChecks(expected, v, undefined, meta));
    expect(cov.find((c) => c.group === "Damage")!.percent).toBeLessThan(100);
  });
});

describe("parseInspectionPayload", () => {
  const m = { latencyMs: 5, modelVersion: "m", promptVersion: "p" };
  it("rejects non-JSON output", () => {
    const r = parseInspectionPayload("not json", m);
    expect(r.ok).toBe(false);
  });
  it("rejects JSON that does not match the schema", () => {
    const r = parseInspectionPayload(JSON.stringify({ verdict: "PASS" }), m);
    expect(r.ok).toBe(false);
  });
  it("accepts a valid payload wrapped in a code fence", () => {
    const r = parseInspectionPayload("```json\n" + JSON.stringify(cleanVision()) + "\n```", m);
    expect(r.ok).toBe(true);
  });
});
