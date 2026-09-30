import { AGENT_NAME, AGENT_VERSION } from "@/lib/config";
import { sha256Hex } from "@/lib/hash";
import { effectiveFromOverrides } from "@/lib/inspection/decision";
import { canonicalJson } from "@/lib/utils";
import {
  EVIDENCE_SCHEMA_VERSION,
  type CheckResult,
  type DecisionOutcome,
  type EvidenceImageRef,
  type EvidenceRecord,
  type OverrideEntry,
  type PoLineExpectation,
  type RecordStatus,
} from "@/lib/types";

export interface EvidenceInput {
  record_id: string;
  organization_id: string;
  client_id: string;
  expected: PoLineExpectation | null;
  captured_at: string;
  inspection_started_at: string | null;
  inspection_completed_at: string | null;
  latency_ms: number | null;
  operator_label: string | null;
  model_version: string | null;
  prompt_version: string | null;
  images: EvidenceImageRef[];
  checks: CheckResult[];
  outcome: DecisionOutcome;
  overrides: OverrideEntry[];
  status: RecordStatus;
  is_demo: boolean;
}

/**
 * Applies the append-only override log to one target (a check key, or `null`
 * for the overall decision). The latest override wins; nothing is rewritten.
 */
export function applyOverrides<T extends string>(
  target: string | null,
  original: T,
  overrides: OverrideEntry[],
): { value: T | string; overridden: boolean } {
  const latest = overrides
    .filter((o) => (o.check_key ?? null) === target)
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    .pop();
  return latest ? { value: latest.new_verdict, overridden: true } : { value: original, overridden: false };
}

/**
 * Builds the cross-pod evidence record and its SHA-256 content hash.
 *
 * The canonical record includes override history and the derived effective
 * view. After an override, the canonical JSON is rebuilt and the hash is
 * stored again so verification succeeds. The hash is an integrity reference,
 * not a tamper-proof, immutable or anchored guarantee.
 */
export async function buildEvidenceRecord(input: EvidenceInput): Promise<EvidenceRecord> {
  const effective = effectiveFromOverrides(input.checks, input.outcome.decision, input.overrides);

  const canonical: Omit<EvidenceRecord, "content_hash"> = {
    record_id: input.record_id,
    schema_version: EVIDENCE_SCHEMA_VERSION,
    organization_id: input.organization_id,
    client_id: input.client_id,
    agent: {
      name: AGENT_NAME,
      version: AGENT_VERSION,
      model_version: input.model_version,
      prompt_version: input.prompt_version,
    },
    subject: {
      unit_id: input.expected?.unit_id ?? null,
      po_number: input.expected?.po_number ?? "",
      po_line: input.expected?.po_line ?? null,
      supplier: input.expected?.supplier ?? null,
      sku: input.expected?.sku ?? null,
      asin: input.expected?.asin ?? null,
      product_title: input.expected?.product_title ?? null,
    },
    expected: input.expected,
    captured_at: input.captured_at,
    inspection_started_at: input.inspection_started_at,
    inspection_completed_at: input.inspection_completed_at,
    latency_ms: input.latency_ms,
    operator_label: input.operator_label,
    images: input.images,
    checks: input.checks,
    outcome: {
      decision: input.outcome.decision,
      summary: input.outcome.summary,
      recommended_action: input.outcome.recommended_action,
      failed_checks: input.outcome.failed_checks,
      uncertain_checks: input.outcome.uncertain_checks,
      inspection_coverage: input.outcome.coverage,
    },
    overrides: input.overrides,
    effective: {
      decision: effective.decision,
      checks: effective.checks,
      overridden: effective.overridden,
    },
    status: input.status,
    is_demo: input.is_demo,
  };

  const content_hash = await sha256Hex(canonicalJson(canonical));
  return { ...canonical, content_hash };
}

/**
 * Recompute the SHA-256 integrity reference over the canonical record
 * (everything except `content_hash`) and compare it to the stored value.
 *
 * Records hashed before overrides were included in the canonical JSON still
 * verify against that earlier material so existing captures are not marked
 * corrupt after the format change.
 */
export async function verifyContentHash(record: EvidenceRecord): Promise<boolean> {
  const { content_hash, ...canonical } = record;
  if ((await sha256Hex(canonicalJson(canonical))) === content_hash) return true;
  const { overrides: _overrides, effective: _effective, ...legacyCore } = canonical;
  void _overrides;
  void _effective;
  return (await sha256Hex(canonicalJson(legacyCore))) === content_hash;
}

/** Hash currently assembled fields, ignoring any previously stored digest. */
export async function computeContentHash(record: Omit<EvidenceRecord, "content_hash"> | EvidenceRecord): Promise<string> {
  const { content_hash: _ignored, ...canonical } = record as EvidenceRecord;
  void _ignored;
  return sha256Hex(canonicalJson(canonical));
}

/**
 * Idempotency key for a capture: same PO line + same image bytes + same
 * capture types ⇒ same key, so a resubmitted capture does not silently create
 * a duplicate receiving record.
 */
export async function captureHash(
  poLineId: string,
  images: { sha256: string | null; capture_type: string }[],
): Promise<string> {
  const material = canonicalJson({
    poLineId,
    images: images
      .map((i) => `${i.capture_type}:${i.sha256 ?? ""}`)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  });
  return sha256Hex(material);
}
