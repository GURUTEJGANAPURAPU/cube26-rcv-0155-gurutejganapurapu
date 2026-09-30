import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildEvidenceRecord, verifyContentHash } from "@/lib/evidence/record";
import { runChecks } from "@/lib/inspection/checks";
import { decide } from "@/lib/inspection/decision";
import { importFromCsv, importFromJson } from "@/lib/po/import";
import { canonicalJson } from "@/lib/utils";
import { EVIDENCE_SCHEMA_VERSION } from "@/lib/types";
import { cleanVision, expected, meta } from "./fixtures";

async function sampleRecord() {
  const checks = runChecks(expected, cleanVision(), undefined, meta);
  return buildEvidenceRecord({
    record_id: "rec-1", organization_id: "org-1", client_id: "demo-alpha", expected,
    captured_at: "2026-06-01T10:00:00Z", inspection_started_at: null, inspection_completed_at: null,
    latency_ms: 10, operator_label: "op", model_version: "m", prompt_version: "p",
    images: [], checks, outcome: decide(checks), overrides: [], status: "complete", is_demo: true,
  });
}

describe("evidence record", () => {
  it("carries the schema version and a 64-char SHA-256 hash", async () => {
    const r = await sampleRecord();
    expect(r.schema_version).toBe(EVIDENCE_SCHEMA_VERSION);
    expect(r.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("verifies an untouched record and detects a changed one", async () => {
    const r = await sampleRecord();
    expect(await verifyContentHash(r)).toBe(true);
    expect(await verifyContentHash({ ...r, status: "pending" })).toBe(false);
  });

  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("purchase-order import", () => {
  it("imports all 100 rows of the synthetic sample CSV", () => {
    const r = importFromCsv(readFileSync("data/receiving_sample.csv", "utf8"));
    expect(r.lines.length).toBe(100);
  });

  it("reports missing required fields instead of importing them", () => {
    const r = importFromJson(JSON.stringify([{ po_number: "PO-1", po_line: 1, supplier: "S", product_title: "T" }]));
    expect(r.lines.length).toBe(0);
    expect(r.issues.some((i) => i.field === "sku")).toBe(true);
  });
});
