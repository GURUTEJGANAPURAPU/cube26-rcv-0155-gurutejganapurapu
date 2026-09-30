/**
 * Shared domain types for Receiving Manager.
 *
 * Boundary rule: the vision model produces `VisionObservations` only.
 * Verdicts and decisions are produced by deterministic code in
 * `src/lib/inspection/*` from those observations plus the purchase-order line.
 */

export const EVIDENCE_SCHEMA_VERSION = "cube.receiving.evidence/1.0";

export type Verdict = "PASS" | "FAIL" | "UNCERTAIN";
export type Decision = "PASS" | "EXCEPTION" | "UNCERTAIN" | "PENDING";
export type Sufficiency = "sufficient" | "insufficient";
export type RecordStatus = "draft" | "processing" | "pending" | "complete";

export type CaptureType =
  | "overview"
  | "carton_label"
  | "quantity"
  | "product"
  | "damage"
  | "other";

export const CAPTURE_TYPES: { key: CaptureType; label: string; hint: string; required: boolean }[] = [
  {
    key: "overview",
    label: "Shipment overview",
    hint: "Whole pallet or delivery as it arrived, all cartons in frame.",
    required: true,
  },
  {
    key: "carton_label",
    label: "Carton label",
    hint: "Shipping or SKU label, close enough to read text and barcode.",
    required: true,
  },
  {
    key: "quantity",
    label: "Quantity evidence",
    hint: "Open carton with contents visible; one photo per carton counted.",
    required: true,
  },
  {
    key: "product",
    label: "Product evidence",
    hint: "Single unit close-up showing colour, variant and components.",
    required: true,
  },
  {
    key: "damage",
    label: "Damage evidence",
    hint: "Close-up of any crushing, water staining or tears. Optional.",
    required: false,
  },
];

export const CHECK_KEYS = [
  "identity",
  "carton_count",
  "units_per_carton",
  "total_quantity",
  "colour",
  "variant",
  "components",
  "carton_crushing",
  "carton_water_damage",
  "carton_tears",
  "unit_damage",
  "obvious_defect",
] as const;

export type CheckKey = (typeof CHECK_KEYS)[number];

export const CHECK_LABELS: Record<CheckKey, string> = {
  identity: "Identity",
  carton_count: "Carton count",
  units_per_carton: "Units per carton",
  total_quantity: "Total quantity",
  colour: "Colour",
  variant: "Variant",
  components: "Components",
  carton_crushing: "Carton crushing",
  carton_water_damage: "Carton water damage",
  carton_tears: "Carton tears",
  unit_damage: "Unit damage",
  obvious_defect: "Obvious defect",
};

/** Coverage groups used by the Inspection Coverage panel (an application UX metric). */
export const COVERAGE_GROUPS: Record<string, CheckKey[]> = {
  Identity: ["identity"],
  Quantity: ["carton_count", "units_per_carton", "total_quantity"],
  Variant: ["colour", "variant"],
  Components: ["components"],
  Damage: ["carton_crushing", "carton_water_damage", "carton_tears", "unit_damage", "obvious_defect"],
};

export interface PoLineExpectation {
  id?: string;
  po_number: string;
  po_line: number | null;
  unit_id: string | null;
  supplier: string;
  sku: string;
  asin: string | null;
  product_title: string;
  spec_colour: string | null;
  spec_variant: string | null;
  spec_components: string[];
  cartons_ordered: number;
  units_per_carton_ordered: number;
  qty_ordered: number;
}

/** Local (free, in-browser) supporting signals. Never authoritative alone. */
export interface LocalSignals {
  ocr_text: string[];
  barcode_values: string[];
  image_quality_flags: { image_id: string; flags: string[]; score: number }[];
}

export interface CheckResult {
  check_key: CheckKey;
  verdict: Verdict;
  expected_value: string;
  observed_value: string;
  confidence: number | null;
  detail: string;
  evidence_image_ids: string[];
  evidence_sufficiency: Sufficiency;
  recommended_action: string | null;
  model_version: string;
  prompt_version: string;
  latency_ms: number;
}

export interface CoverageEntry {
  group: string;
  percent: number;
  explanation: string;
}

export interface DecisionOutcome {
  decision: Decision;
  summary: string;
  failed_checks: CheckKey[];
  uncertain_checks: CheckKey[];
  recommended_action: string;
  coverage: CoverageEntry[];
}

export interface EvidenceImageRef {
  image_id: string;
  capture_type: CaptureType;
  storage_path: string;
  original_filename: string | null;
  mime_type: string;
  size_bytes: number;
  sha256: string | null;
  uploaded_at: string;
  quality_flags: string[];
}

export interface OverrideEntry {
  check_key: string | null;
  original_verdict: string;
  new_verdict: string;
  reason: string;
  operator: string;
  created_at: string;
}

/** The record handed to downstream pods (Prep, Pack, Returns, Recovery). */
export interface EvidenceRecord {
  record_id: string;
  schema_version: string;
  organization_id: string;
  client_id: string;
  agent: {
    name: string;
    version: string;
    model_version: string | null;
    prompt_version: string | null;
  };
  subject: {
    unit_id: string | null;
    po_number: string;
    po_line: number | null;
    supplier: string | null;
    sku: string | null;
    asin: string | null;
    product_title: string | null;
  };
  expected: PoLineExpectation | null;
  captured_at: string;
  inspection_started_at: string | null;
  inspection_completed_at: string | null;
  latency_ms: number | null;
  operator_label: string | null;
  images: EvidenceImageRef[];
  checks: CheckResult[];
  outcome: {
    decision: Decision;
    summary: string;
    recommended_action: string;
    failed_checks: CheckKey[];
    uncertain_checks: CheckKey[];
    inspection_coverage: CoverageEntry[];
  };
  /**
   * Agent verdicts after applying the append-only override log. The agent's
   * own verdicts in `outcome`/`checks` are never rewritten.
   */
  effective: {
    decision: Decision;
    checks: { check_key: CheckKey; verdict: string; overridden: boolean }[];
    overridden: boolean;
  };
  overrides: OverrideEntry[];
  status: RecordStatus;
  is_demo: boolean;
  /**
   * SHA-256 integrity reference over the canonical evidence record, including
   * override history. Recomputed after each override. Not a tamper-proof,
   * immutable or anchored guarantee.
   */
  content_hash: string;
}
