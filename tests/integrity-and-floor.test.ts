import { describe, expect, it } from "vitest";

import { applyOverrides, buildEvidenceRecord, captureHash, verifyContentHash } from "@/lib/evidence/record";
import { runChecks } from "@/lib/inspection/checks";
import { decide } from "@/lib/inspection/decision";
import { enforceEvidenceFloor } from "@/lib/inspection/evidence-floor";
import type { CaptureType, OverrideEntry } from "@/lib/types";
import { cleanVision, expected, meta } from "./fixtures";

const ALL_CAPTURES: CaptureType[] = ["overview", "carton_label", "quantity", "product", "damage"];

async function record(overrides: OverrideEntry[] = [], captured: CaptureType[] = ALL_CAPTURES) {
  const checks = runChecks(expected, cleanVision(), undefined, meta, captured);
  return buildEvidenceRecord({
    record_id: "rec-1", organization_id: "org-1", client_id: "demo-alpha", expected,
    captured_at: "2026-06-01T10:00:00Z", inspection_started_at: null, inspection_completed_at: null,
    latency_ms: 10, operator_label: "op", model_version: "m", prompt_version: "p",
    images: [], checks, outcome: decide(checks), overrides, status: "complete", is_demo: true,
  });
}

const override = (check_key: string | null, from: string, to: string, at: string): OverrideEntry => ({
  check_key, original_verdict: from, new_verdict: to, reason: "operator inspected physically", operator: "op", created_at: at,
});

describe("content hash survives overrides", () => {
  it("is identical with and without an override, and still verifies", async () => {
    const plain = await record();
    const overridden = await record([override("identity", "PASS", "FAIL", "2026-06-01T11:00:00Z")]);

    expect(overridden.content_hash).toBe(plain.content_hash);
    expect(await verifyContentHash(overridden)).toBe(true);
  });

  it("still detects a changed agent verdict", async () => {
    const r = await record();
    const tampered = { ...r, checks: r.checks.map((c, i) => (i === 0 ? { ...c, verdict: "PASS" as const, detail: "edited" } : c)) };
    expect(await verifyContentHash(tampered)).toBe(false);
  });
});

describe("effective decision after override", () => {
  it("reports the latest override and preserves the agent verdict", async () => {
    const r = await record([
      override(null, "PASS", "UNCERTAIN", "2026-06-01T11:00:00Z"),
      override(null, "UNCERTAIN", "EXCEPTION", "2026-06-01T12:00:00Z"),
    ]);
    expect(r.outcome.decision).toBe("PASS");
    expect(r.effective.decision).toBe("EXCEPTION");
    expect(r.effective.overridden).toBe(true);
  });

  it("leaves non-overridden checks untouched", async () => {
    const r = await record([override("identity", "PASS", "FAIL", "2026-06-01T11:00:00Z")]);
    const identity = r.effective.checks.find((c) => c.check_key === "identity");
    const colour = r.effective.checks.find((c) => c.check_key === "colour");
    expect(identity).toMatchObject({ verdict: "FAIL", overridden: true });
    expect(colour?.overridden).toBe(false);
  });

  it("applyOverrides returns the original when nothing applies", () => {
    expect(applyOverrides("identity", "PASS", [])).toEqual({ value: "PASS", overridden: false });
  });
});

describe("backend evidence floor", () => {
  it("demotes carton count to UNCERTAIN when no overview was captured", () => {
    const checks = runChecks(expected, cleanVision(), undefined, meta, ["carton_label", "quantity", "product"]);
    const carton = checks.find((c) => c.check_key === "carton_count")!;
    expect(carton.verdict).toBe("UNCERTAIN");
    expect(carton.evidence_sufficiency).toBe("insufficient");
    expect(carton.detail).toMatch(/does not include/);
  });

  it("demotes identity to UNCERTAIN when no carton label was captured", () => {
    const checks = runChecks(expected, cleanVision(), undefined, meta, ["overview", "quantity", "product"]);
    expect(checks.find((c) => c.check_key === "identity")!.verdict).toBe("UNCERTAIN");
  });

  it("never demotes a check whose expectation is unspecified", () => {
    const withoutSpec = { ...expected, spec_colour: null, spec_variant: null, spec_components: [] };
    const checks = runChecks(withoutSpec, cleanVision(), undefined, meta, ["overview"]);
    for (const key of ["colour", "variant", "components"]) {
      expect(checks.find((c) => c.check_key === key)!.verdict).toBe("PASS");
    }
  });

  it("never promotes: a demoted check is only ever UNCERTAIN", () => {
    const checks = runChecks(expected, cleanVision(), undefined, meta, []);
    expect(checks.every((c) => c.verdict !== "PASS" || c.expected_value === "Not specified")).toBe(true);
  });

  it("is a no-op when every required view is present", () => {
    const base = runChecks(expected, cleanVision(), undefined, meta);
    expect(enforceEvidenceFloor(base, ALL_CAPTURES)).toEqual(base);
  });
});

describe("capture hash idempotency", () => {
  const images = [
    { capture_type: "overview", sha256: "aaa" },
    { capture_type: "carton_label", sha256: "bbb" },
  ];

  it("is stable regardless of image order", async () => {
    expect(await captureHash("line-1", images)).toBe(await captureHash("line-1", [...images].reverse()));
  });

  it("differs for a different PO line or different bytes", async () => {
    const base = await captureHash("line-1", images);
    expect(await captureHash("line-2", images)).not.toBe(base);
    expect(await captureHash("line-1", [{ capture_type: "overview", sha256: "ccc" }, images[1]])).not.toBe(base);
  });
});
