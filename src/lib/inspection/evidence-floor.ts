import { CAPTURE_TYPES, type CaptureType, type CheckKey, type CheckResult } from "@/lib/types";

/**
 * Backend evidence floor.
 *
 * The model reports its own `evidence_sufficiency`, but that claim is not
 * trusted on its own: a check may only reach PASS or FAIL when the capture
 * types it structurally depends on are actually present in the record. If a
 * required view was never photographed, the check is demoted to UNCERTAIN
 * here — in deterministic code, after the model has spoken.
 *
 * Checks whose expectation is "Not specified" are exempt: they are decided
 * from the purchase order alone and need no image to be correct.
 */
export const REQUIRED_CAPTURES: Record<CheckKey, CaptureType[]> = {
  identity: ["carton_label"],
  carton_count: ["overview"],
  units_per_carton: ["quantity"],
  total_quantity: ["quantity", "overview"],
  colour: ["product"],
  variant: ["product"],
  components: ["product"],
  carton_crushing: ["overview", "damage"],
  carton_water_damage: ["overview", "damage"],
  carton_tears: ["overview", "damage"],
  unit_damage: ["product", "damage"],
  obvious_defect: ["product", "damage"],
};

const LABEL = new Map(CAPTURE_TYPES.map((c) => [c.key, c.label]));

function label(type: CaptureType): string {
  return LABEL.get(type) ?? type;
}

/**
 * `required` semantics: EVERY listed capture type must be present, except
 * where the list is an either/or alternative for the damage family, which is
 * satisfied by any one of its entries.
 */
const ANY_OF: CheckKey[] = [
  "total_quantity",
  "carton_crushing",
  "carton_water_damage",
  "carton_tears",
  "unit_damage",
  "obvious_defect",
];

export function missingCaptures(key: CheckKey, captured: Set<CaptureType>): CaptureType[] {
  const required = REQUIRED_CAPTURES[key] ?? [];
  if (required.length === 0) return [];
  if (ANY_OF.includes(key)) {
    return required.some((t) => captured.has(t)) ? [] : required;
  }
  return required.filter((t) => !captured.has(t));
}

export function enforceEvidenceFloor(checks: CheckResult[], capturedTypes: CaptureType[]): CheckResult[] {
  const captured = new Set(capturedTypes);

  return checks.map((check) => {
    if (check.verdict === "UNCERTAIN") return check;
    if (check.expected_value === "Not specified") return check;

    const missing = missingCaptures(check.check_key, captured);
    if (missing.length === 0) return check;

    const names = missing.map(label);
    const phrase = names.length === 1 ? names[0] : `one of: ${names.join(", ")}`;

    return {
      ...check,
      verdict: "UNCERTAIN" as const,
      evidence_sufficiency: "insufficient" as const,
      detail:
        `This check cannot be verified: the capture does not include ${phrase}. ` +
        `The agent reported "${check.verdict}" from the available images, but that view is required to stand behind the verdict. ` +
        check.detail,
      recommended_action: `Capture the ${phrase} view and re-inspect.`,
    };
  });
}
