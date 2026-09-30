import type { SupabaseClient } from "@supabase/supabase-js";

import { runInspection, type InspectionImage } from "@/lib/ai/gemini";
import { STORAGE_BUCKET, getLimits } from "@/lib/config";
import { buildEvidenceRecord, captureHash } from "@/lib/evidence/record";
import { runChecks } from "@/lib/inspection/checks";
import { decide, pendingOutcome } from "@/lib/inspection/decision";
import type {
  CaptureType,
  CheckResult,
  EvidenceImageRef,
  EvidenceRecord,
  LocalSignals,
  PoLineExpectation,
  RecordStatus,
} from "@/lib/types";
import type { SessionContext } from "@/lib/supabase/server";

type DB = SupabaseClient;

export interface RecordRow {
  id: string;
  organization_id: string;
  po_line_id: string | null;
  unit_id: string | null;
  po_number: string;
  po_line: number | null;
  supplier: string | null;
  sku: string | null;
  status: RecordStatus;
  decision: string | null;
  captured_at: string;
  operator_label: string | null;
  model_version: string | null;
  prompt_version: string | null;
  latency_ms: number | null;
  inspection_started_at: string | null;
  inspection_completed_at: string | null;
  attempt_count: number;
  failure_reason: string | null;
  recommended_action: string | null;
  observations: unknown;
  coverage: unknown;
  content_hash: string | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}

export async function loadExpectation(db: DB, poLineId: string): Promise<PoLineExpectation | null> {
  const { data } = await db
    .from("purchase_order_lines")
    .select(
      "id, po_line, unit_id, sku, asin, product_title, spec_colour, spec_variant, spec_components, cartons_ordered, units_per_carton_ordered, qty_ordered, purchase_orders(po_number, supplier)",
    )
    .eq("id", poLineId)
    .maybeSingle();

  if (!data) return null;
  const po = data.purchase_orders as unknown as { po_number: string; supplier: string } | null;

  return {
    id: data.id,
    po_number: po?.po_number ?? "",
    po_line: data.po_line,
    unit_id: data.unit_id,
    supplier: po?.supplier ?? "",
    sku: data.sku,
    asin: data.asin,
    product_title: data.product_title,
    spec_colour: data.spec_colour,
    spec_variant: data.spec_variant,
    spec_components: data.spec_components ?? [],
    cartons_ordered: data.cartons_ordered,
    units_per_carton_ordered: data.units_per_carton_ordered,
    qty_ordered: data.qty_ordered,
  };
}

export async function loadEvidenceRecord(
  db: DB,
  recordId: string,
  session: SessionContext,
): Promise<EvidenceRecord | null> {
  const { data: record } = await db
    .from("receiving_records")
    .select("*")
    .eq("id", recordId)
    .maybeSingle<RecordRow>();
  if (!record) return null;

  const [{ data: images }, { data: checks }, { data: overrides }] = await Promise.all([
    db.from("receiving_images").select("*").eq("receiving_record_id", recordId).order("uploaded_at"),
    db.from("inspection_checks").select("*").eq("receiving_record_id", recordId).order("check_key"),
    db.from("overrides").select("*").eq("receiving_record_id", recordId).order("created_at"),
  ]);

  const expectation = record.po_line_id ? await loadExpectation(db, record.po_line_id) : null;

  const imageRefs: EvidenceImageRef[] = (images ?? []).map((i) => ({
    image_id: i.id,
    capture_type: i.capture_type,
    storage_path: i.storage_path,
    original_filename: i.original_filename,
    mime_type: i.mime_type,
    size_bytes: i.size_bytes,
    sha256: i.sha256,
    uploaded_at: i.uploaded_at,
    quality_flags: i.quality_flags ?? [],
  }));

  const checkResults: CheckResult[] = (checks ?? []).map((c) => ({
    check_key: c.check_key,
    verdict: c.verdict,
    expected_value: c.expected_value ?? "",
    observed_value: c.observed_value ?? "",
    confidence: c.confidence === null ? null : Number(c.confidence),
    detail: c.detail ?? "",
    evidence_image_ids: c.evidence_image_ids ?? [],
    evidence_sufficiency: c.evidence_sufficiency,
    recommended_action: c.recommended_action,
    model_version: c.model_version ?? "",
    prompt_version: c.prompt_version ?? "",
    latency_ms: c.latency_ms ?? 0,
  }));

  const decisionValue = (record.decision ?? "PENDING") as EvidenceRecord["outcome"]["decision"];

  const evidence = await buildEvidenceRecord({
    record_id: record.id,
    organization_id: record.organization_id,
    client_id: session.organizationSlug,
    expected: expectation,
    captured_at: record.captured_at,
    inspection_started_at: record.inspection_started_at,
    inspection_completed_at: record.inspection_completed_at,
    latency_ms: record.latency_ms,
    operator_label: record.operator_label,
    model_version: record.model_version,
    prompt_version: record.prompt_version,
    images: imageRefs,
    checks: checkResults,
    outcome: {
      decision: decisionValue,
      summary: summaryFor(record, checkResults),
      failed_checks: checkResults.filter((c) => c.verdict === "FAIL").map((c) => c.check_key),
      uncertain_checks: checkResults.filter((c) => c.verdict === "UNCERTAIN").map((c) => c.check_key),
      recommended_action: record.recommended_action ?? "",
      coverage: (record.coverage as EvidenceRecord["outcome"]["inspection_coverage"]) ?? [],
    },
    overrides: (overrides ?? []).map((o) => ({
      check_key: o.check_key,
      original_verdict: o.original_verdict,
      new_verdict: o.new_verdict,
      reason: o.reason,
      operator: o.operator_label ?? o.operator_id ?? "operator",
      created_at: o.created_at,
    })),
    status: record.status,
    is_demo: record.is_demo,
  });

  return { ...evidence, content_hash: record.content_hash || evidence.content_hash };
}

function summaryFor(record: RecordRow, checks: CheckResult[]): string {
  if (record.status === "pending") {
    return "Inspection could not be completed. The capture and all evidence are saved.";
  }
  const failed = checks.filter((c) => c.verdict === "FAIL").length;
  const uncertain = checks.filter((c) => c.verdict === "UNCERTAIN").length;
  if (failed) return `${failed} ${failed === 1 ? "check" : "checks"} failed.`;
  if (uncertain) return `${uncertain} ${uncertain === 1 ? "check" : "checks"} could not be verified from the supplied evidence.`;
  return `All ${checks.length} checks passed against the purchase-order line.`;
}

export interface InspectionExecution {
  status: RecordStatus;
  decision: string;
  message: string;
  latency_ms: number;
  http_status: number;
  /** Set when an identical capture had already been inspected. */
  duplicate_of?: string;
}

/**
 * Executes ONE multimodal inspection for a receiving record and persists the
 * result. A model failure never loses the capture: the record moves to
 * `pending` with a stored reason and can be retried.
 */
export async function performInspection(
  db: DB,
  session: SessionContext,
  recordId: string,
): Promise<InspectionExecution> {
  const limits = getLimits();
  const startedAt = new Date().toISOString();

  const { data: record } = await db
    .from("receiving_records")
    .select("*")
    .eq("id", recordId)
    .maybeSingle<RecordRow>();

  if (!record) {
    return { status: "draft", decision: "PENDING", message: "Receiving record not found.", latency_ms: 0, http_status: 404 };
  }
  if (!record.po_line_id) {
    return { status: record.status, decision: "PENDING", message: "This record has no purchase-order line.", latency_ms: 0, http_status: 400 };
  }
  if (record.attempt_count >= limits.maxAttempts) {
    return {
      status: record.status,
      decision: record.decision ?? "PENDING",
      message: `Retry limit reached (${limits.maxAttempts} attempts). Review the capture before trying again.`,
      latency_ms: 0,
      http_status: 429,
    };
  }

  // Daily quota guard, counted from real attempts in this organisation.
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { count: todayCount } = await db
    .from("inspection_attempts")
    .select("id", { count: "exact", head: true })
    .gte("created_at", dayStart.toISOString());
  if ((todayCount ?? 0) >= limits.dailyInspectionLimit) {
    await recordAttempt(db, session, record, "rate_limited", "Daily inspection limit reached.", null, 0);
    await db
      .from("receiving_records")
      .update({
        status: "pending",
        decision: "PENDING",
        failure_reason: "Daily inspection limit reached for this organisation.",
        recommended_action: "The capture is saved. Retry after the daily limit resets at 00:00 UTC.",
      })
      .eq("id", recordId);
    return {
      status: "pending",
      decision: "PENDING",
      message: "Daily inspection limit reached. The capture is saved and can be retried after 00:00 UTC.",
      latency_ms: 0,
      http_status: 429,
    };
  }

  const expectation = await loadExpectation(db, record.po_line_id);
  if (!expectation) {
    return { status: record.status, decision: "PENDING", message: "The purchase-order line for this record is unavailable.", latency_ms: 0, http_status: 400 };
  }

  const { data: imageRows } = await db
    .from("receiving_images")
    .select("*")
    .eq("receiving_record_id", recordId)
    .order("uploaded_at");

  const images = imageRows ?? [];
  if (images.length === 0) {
    return { status: record.status, decision: "PENDING", message: "Capture at least one evidence photo before inspecting.", latency_ms: 0, http_status: 400 };
  }
  if (images.length > limits.maxImagesPerInspection) {
    return {
      status: record.status,
      decision: "PENDING",
      message: `This inspection carries ${images.length} images; the configured maximum is ${limits.maxImagesPerInspection}.`,
      latency_ms: 0,
      http_status: 400,
    };
  }

  // --- idempotency: the same PO line + the same image bytes is the same capture.
  // A resubmitted capture returns the existing result instead of spending a
  // second model call and creating a divergent duplicate record.
  const capture_hash = await captureHash(record.po_line_id, images);
  const { data: twin } = await db
    .from("receiving_records")
    .select("id, status, decision, latency_ms, recommended_action")
    .eq("capture_hash", capture_hash)
    .eq("status", "complete")
    .neq("id", recordId)
    .maybeSingle<Pick<RecordRow, "id" | "status" | "decision" | "latency_ms" | "recommended_action">>();

  if (twin) {
    return {
      status: "complete",
      decision: twin.decision ?? "PENDING",
      message: "This exact capture has already been inspected; the existing decision is reused.",
      latency_ms: twin.latency_ms ?? 0,
      http_status: 200,
      duplicate_of: twin.id,
    };
  }

  // --- atomic claim: only one inspection may run for a record at a time.
  // A claim older than the inspection timeout is considered abandoned and may
  // be re-taken, so a crashed request cannot lock the record forever.
  const staleBefore = new Date(Date.now() - limits.inspectionTimeoutMs * 2).toISOString();
  const { data: claimed } = await db
    .from("receiving_records")
    .update({ status: "processing", inspection_started_at: startedAt, failure_reason: null, capture_hash })
    .eq("id", recordId)
    .or(`status.neq.processing,inspection_started_at.lt.${staleBefore}`)
    .select("id");

  if (!claimed || claimed.length === 0) {
    return {
      status: "processing",
      decision: "PENDING",
      message: "An inspection for this receiving unit is already running. Wait for it to finish before retrying.",
      latency_ms: 0,
      http_status: 409,
    };
  }

  // Fetch image bytes through the caller's own session: storage RLS applies.
  const inspectionImages: InspectionImage[] = [];
  for (const image of images) {
    const { data: blob, error } = await db.storage.from(STORAGE_BUCKET).download(image.storage_path);
    if (error || !blob) {
      await markPending(db, session, record, "model_error", "An evidence image could not be read from storage.", 0);
      return {
        status: "pending",
        decision: "PENDING",
        message: "An evidence image could not be read from storage. The capture is saved.",
        latency_ms: 0,
        http_status: 502,
      };
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    inspectionImages.push({
      image_id: image.id,
      capture_type: image.capture_type,
      filename: image.original_filename,
      mime_type: image.mime_type,
      data: buffer.toString("base64"),
    });
  }

  const signals: LocalSignals = {
    ocr_text: images.map((i) => i.ocr_text).filter((t): t is string => Boolean(t)),
    barcode_values: images.map((i) => i.barcode_value).filter((t): t is string => Boolean(t)),
    image_quality_flags: images.map((i) => ({
      image_id: i.id,
      flags: i.quality_flags ?? [],
      score: i.quality_score === null ? 0 : Number(i.quality_score),
    })),
  };

  // ---- the single multimodal call -----------------------------------------
  const result = await runInspection(expectation, signals, inspectionImages);

  if (!result.ok) {
    await markPending(db, session, record, result.outcome, result.message, result.latencyMs);
    return {
      status: "pending",
      decision: "PENDING",
      message: result.message,
      latency_ms: result.latencyMs,
      http_status: result.outcome === "rate_limited" || result.outcome === "quota_exhausted" ? 429 : 502,
    };
  }

  const meta = {
    model_version: result.modelVersion,
    prompt_version: result.promptVersion,
    latency_ms: result.latencyMs,
  };
  const capturedTypes = [...new Set(images.map((i) => i.capture_type as CaptureType))];
  const checks = runChecks(expectation, result.data, signals, meta, capturedTypes);
  const outcome = decide(checks);
  const completedAt = new Date().toISOString();

  await db.from("inspection_checks").delete().eq("receiving_record_id", recordId);
  await db.from("inspection_checks").insert(
    checks.map((c) => ({
      organization_id: record.organization_id,
      receiving_record_id: recordId,
      check_key: c.check_key,
      verdict: c.verdict,
      confidence: c.confidence,
      expected_value: c.expected_value,
      observed_value: c.observed_value,
      detail: c.detail,
      evidence_image_ids: c.evidence_image_ids,
      evidence_sufficiency: c.evidence_sufficiency,
      recommended_action: c.recommended_action,
      model_version: c.model_version,
      prompt_version: c.prompt_version,
      latency_ms: c.latency_ms,
    })),
  );

  await db
    .from("receiving_records")
    .update({
      status: "complete",
      decision: outcome.decision,
      model_version: result.modelVersion,
      prompt_version: result.promptVersion,
      latency_ms: result.latencyMs,
      inspection_completed_at: completedAt,
      attempt_count: record.attempt_count + 1,
      failure_reason: null,
      recommended_action: outcome.recommended_action,
      observations: result.data,
      coverage: outcome.coverage,
    })
    .eq("id", recordId);

  await recordAttempt(db, session, record, "success", null, result.modelVersion, result.latencyMs);

  // Content hash over the final, stored record.
  const evidence = await loadEvidenceRecord(db, recordId, session);
  if (evidence) {
    await db.from("receiving_records").update({ content_hash: evidence.content_hash }).eq("id", recordId);
  }

  return {
    status: "complete",
    decision: outcome.decision,
    message: outcome.summary,
    latency_ms: result.latencyMs,
    http_status: 200,
  };
}

async function markPending(
  db: DB,
  session: SessionContext,
  record: RecordRow,
  outcome: string,
  message: string,
  latencyMs: number,
) {
  await db
    .from("receiving_records")
    .update({
      status: "pending",
      decision: "PENDING",
      failure_reason: message,
      attempt_count: record.attempt_count + 1,
      latency_ms: latencyMs,
      recommended_action: pendingOutcome(message).recommended_action,
    })
    .eq("id", record.id);
  await recordAttempt(db, session, record, outcome, message, null, latencyMs);
}

async function recordAttempt(
  db: DB,
  session: SessionContext,
  record: RecordRow,
  outcome: string,
  errorMessage: string | null,
  modelVersion: string | null,
  latencyMs: number,
) {
  await db.from("inspection_attempts").insert({
    organization_id: session.organizationId,
    receiving_record_id: record.id,
    attempt_no: record.attempt_count + 1,
    outcome,
    error_message: errorMessage,
    model_version: modelVersion,
    latency_ms: latencyMs,
  });
}
