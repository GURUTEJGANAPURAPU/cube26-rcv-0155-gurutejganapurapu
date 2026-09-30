import type { VisionResponse } from "@/lib/ai/vision-schema";
import { enforceEvidenceFloor } from "@/lib/inspection/evidence-floor";
import type { CaptureType, CheckKey, CheckResult, LocalSignals, PoLineExpectation, Sufficiency, Verdict } from "@/lib/types";
import { isUnspecified, normalizeToken, normalizeText, textSimilarity } from "@/lib/utils";

/**
 * Deterministic check engine.
 *
 * AI observes → this file decides. Nothing here calls a model, and no
 * arithmetic is delegated to the model: quantities are recomputed in code.
 */

export interface CheckMeta {
  model_version: string;
  prompt_version: string;
  latency_ms: number;
}

const EMPTY_SIGNALS: LocalSignals = { ocr_text: [], barcode_values: [], image_quality_flags: [] };

export function runChecks(
  expected: PoLineExpectation,
  vision: VisionResponse,
  signals: LocalSignals = EMPTY_SIGNALS,
  meta: CheckMeta,
  /**
   * Capture types actually present on the record. When supplied, the backend
   * evidence floor demotes any check whose required view is missing, so the
   * model's own sufficiency claim is never the only safeguard.
   */
  capturedTypes?: CaptureType[],
): CheckResult[] {
  const checks = [
    identityCheck(expected, vision, signals, meta),
    ...quantityChecks(expected, vision, meta),
    attributeCheck("colour", expected.spec_colour, vision.observations.colour, vision.evidence_sufficiency.colour, meta, "Capture a product close-up under even lighting."),
    attributeCheck("variant", expected.spec_variant, vision.observations.variant, vision.evidence_sufficiency.variant, meta, "Capture the variant marking on the label or product."),
    componentsCheck(expected, vision, meta),
    ...damageChecks(vision, meta),
  ];

  return capturedTypes ? enforceEvidenceFloor(checks, capturedTypes) : checks;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
function identityCheck(
  expected: PoLineExpectation,
  vision: VisionResponse,
  signals: LocalSignals,
  meta: CheckMeta,
): CheckResult {
  const sufficiency = vision.evidence_sufficiency.identity;
  const obs = vision.observations.sku;
  const title = vision.observations.product_title;
  const asin = vision.observations.asin;

  const expectedSku = normalizeToken(expected.sku);
  const expectedAsin = normalizeToken(expected.asin);
  const observedSku = normalizeToken(obs.value);
  const barcodeMatch = signals.barcode_values.some((b) => {
    const t = normalizeToken(b);
    return t !== "" && (t === expectedSku || (expectedAsin !== "" && t === expectedAsin));
  });
  // A barcode is often an EAN/UPC, not the SKU. That is supporting evidence
  // when it matches, not a contradiction when it does not.
  const barcodeConflict = signals.barcode_values.some((b) => {
    const t = normalizeToken(b);
    if (!t) return false;
    const looksLikeSku = t.startsWith("sku") || t === expectedSku;
    return looksLikeSku && t !== expectedSku;
  });
  const ocrMatch = signals.ocr_text.some((t) => normalizeText(t).includes(normalizeText(expected.sku)));
  const titleScore = textSimilarity(expected.product_title, title.value);
  const asinMatch = normalizeToken(asin.value) !== "" && normalizeToken(asin.value) === normalizeToken(expected.asin);

  const evidence = unique([
    ...obs.evidence_image_ids,
    ...title.evidence_image_ids,
    ...asin.evidence_image_ids,
  ]);

  const observedParts: string[] = [];
  if (obs.value) observedParts.push(`SKU ${obs.value}`);
  if (title.value) observedParts.push(`"${title.value}"`);
  if (asin.value) observedParts.push(`ASIN ${asin.value}`);
  if (signals.barcode_values.length) observedParts.push(`barcode ${signals.barcode_values.join(", ")}`);
  const observedValue = observedParts.join(" · ") || "Not readable";

  const contradictions = vision.contradictions.slice();
  if (observedSku && observedSku === expectedSku && title.value && titleScore < 0.2) {
    contradictions.push(
      `Label SKU matches the PO line but the visible product ("${title.value}") does not resemble "${expected.product_title}".`,
    );
  }
  if (barcodeConflict && observedSku === expectedSku) {
    contradictions.push("Scanned barcode does not match the label SKU.");
  }

  const base = {
    check_key: "identity" as CheckKey,
    expected_value: `${expected.sku}${expected.asin ? ` · ${expected.asin}` : ""} · ${expected.product_title}`,
    observed_value: observedValue,
    evidence_image_ids: evidence,
    evidence_sufficiency: sufficiency,
    ...meta,
  };

  if (contradictions.length > 0) {
    return {
      ...base,
      verdict: "UNCERTAIN",
      confidence: obs.confidence,
      detail: `Identity signals conflict. ${contradictions.join(" ")}`,
      recommended_action: "Re-photograph the carton label and one unit together so the label and product can be tied to each other.",
    };
  }

  if (sufficiency === "insufficient") {
    return {
      ...base,
      verdict: "UNCERTAIN",
      confidence: obs.confidence,
      detail: `Evidence insufficient to verify identity. ${obs.observation || "No readable SKU or label in the supplied images."}`,
      recommended_action: "Capture a clearer, closer carton-label image.",
    };
  }

  if (observedSku && observedSku === expectedSku) {
    const supporting = [
      barcodeMatch ? "barcode agrees" : null,
      ocrMatch ? "OCR agrees" : null,
      asinMatch ? "ASIN agrees" : null,
      titleScore >= 0.4 ? "product title agrees" : null,
    ].filter(Boolean);
    return {
      ...base,
      verdict: "PASS",
      confidence: obs.confidence,
      detail: `Label SKU matches the PO line${supporting.length ? ` (${supporting.join(", ")})` : ""}. ${obs.observation}`.trim(),
      recommended_action: null,
    };
  }

  if (observedSku && observedSku !== expectedSku) {
    return {
      ...base,
      verdict: "FAIL",
      confidence: obs.confidence,
      detail: `Label SKU ${obs.value} does not match the ordered SKU ${expected.sku}. ${obs.observation}`.trim(),
      recommended_action: "Hold the shipment. The delivered SKU differs from the purchase-order line.",
    };
  }

  if (!observedSku && barcodeMatch) {
    return {
      ...base,
      verdict: "PASS",
      confidence: 0.8,
      detail: "SKU text was not readable, but a scanned barcode on the carton matches the ordered SKU.",
      recommended_action: null,
    };
  }

  if (!observedSku && title.value && titleScore < 0.15) {
    return {
      ...base,
      verdict: "FAIL",
      confidence: title.confidence,
      detail: `No label SKU was readable and the visible product ("${title.value}") does not match the ordered product ("${expected.product_title}").`,
      recommended_action: "Hold the shipment and confirm what was delivered against the purchase order.",
    };
  }

  return {
    ...base,
    verdict: "UNCERTAIN",
    confidence: obs.confidence,
    detail:
      "No SKU, barcode or ASIN could be read. Product appearance alone is not sufficient to confirm identity against the purchase order.",
    recommended_action: "Capture a clearer carton-label image showing the SKU and barcode.",
  };
}

// ---------------------------------------------------------------------------
// Quantity family: carton_count, units_per_carton, total_quantity
// ---------------------------------------------------------------------------
function quantityChecks(
  expected: PoLineExpectation,
  vision: VisionResponse,
  meta: CheckMeta,
): CheckResult[] {
  const sufficiency = vision.evidence_sufficiency.quantity;
  const coverage = vision.quantity_evidence.coverage;
  const cartons = vision.observations.cartons_visible;
  const upc = vision.observations.units_per_carton_visible;
  const unitsVisible = vision.observations.units_visible;
  const cartonCounts = vision.quantity_evidence.carton_counts ?? [];

  const cartonEvidence = cartons.evidence_image_ids;
  const quantityEvidence = unique([...upc.evidence_image_ids, ...unitsVisible.evidence_image_ids]);

  // --- carton count -------------------------------------------------------
  const cartonBase = {
    check_key: "carton_count" as CheckKey,
    expected_value: String(expected.cartons_ordered),
    observed_value: cartons.value === null ? "Not countable" : String(cartons.value),
    evidence_image_ids: cartonEvidence,
    evidence_sufficiency: sufficiency,
    confidence: cartons.confidence,
    ...meta,
  };

  let cartonCheck: CheckResult;
  if (sufficiency === "insufficient" || cartons.value === null) {
    cartonCheck = {
      ...cartonBase,
      verdict: "UNCERTAIN",
      detail: `Carton count could not be established from the supplied images. ${cartons.observation}`.trim(),
      recommended_action: "Capture one overview photo with every carton fully in frame.",
    };
  } else if (cartons.value === expected.cartons_ordered) {
    cartonCheck = {
      ...cartonBase,
      verdict: "PASS",
      detail: `${cartons.value} cartons counted against ${expected.cartons_ordered} ordered. ${cartons.observation}`.trim(),
      recommended_action: null,
    };
  } else {
    cartonCheck = {
      ...cartonBase,
      verdict: "FAIL",
      detail: `${cartons.value} cartons counted against ${expected.cartons_ordered} ordered. ${cartons.observation}`.trim(),
      recommended_action:
        cartons.value < expected.cartons_ordered
          ? "Hold for review: fewer cartons arrived than were ordered."
          : "Hold for review: more cartons arrived than were ordered.",
    };
  }

  // --- units per carton ---------------------------------------------------
  const upcBase = {
    check_key: "units_per_carton" as CheckKey,
    expected_value: String(expected.units_per_carton_ordered),
    observed_value: upc.value === null ? "Not countable" : String(upc.value),
    evidence_image_ids: quantityEvidence,
    evidence_sufficiency: sufficiency,
    confidence: upc.confidence,
    ...meta,
  };

  let upcCheck: CheckResult;
  if (sufficiency === "insufficient" || coverage === "none" || upc.value === null) {
    upcCheck = {
      ...upcBase,
      verdict: "UNCERTAIN",
      detail: `Units per carton could not be verified. ${upc.observation || vision.quantity_evidence.observation}`.trim(),
      recommended_action: "Open a carton and capture the full contents in one frame.",
    };
  } else if (upc.value === expected.units_per_carton_ordered) {
    upcCheck = {
      ...upcBase,
      verdict: "PASS",
      detail: `${upc.value} units counted per carton against ${expected.units_per_carton_ordered} expected. ${upc.observation}`.trim(),
      recommended_action: null,
    };
  } else {
    upcCheck = {
      ...upcBase,
      verdict: "FAIL",
      detail: `${upc.value} units counted per carton against ${expected.units_per_carton_ordered} expected. ${upc.observation}`.trim(),
      recommended_action: "Hold for review: carton fill differs from the purchase order.",
    };
  }

  // --- total quantity: arithmetic done here, never by the model -----------
  const cartonsVerified = cartonCheck.verdict !== "UNCERTAIN" && cartons.value !== null;
  const coverageComplete = coverage === "complete" && sufficiency === "sufficient";
  const fullyCounted = vision.quantity_evidence.cartons_fully_counted;
  const allCartonsCounted =
    cartonsVerified && fullyCounted !== null && cartons.value !== null && fullyCounted >= cartons.value;

  let verifiedUnits: number | null = null;
  let derivation = "";
  const cartonSumReady =
    coverageComplete &&
    cartonCounts.length > 0 &&
    cartonCounts.every((c) => c.fully_counted && c.verified_units !== null) &&
    (cartons.value === null || cartonCounts.length === cartons.value);

  if (cartonSumReady) {
    verifiedUnits = cartonCounts.reduce((sum, c) => sum + (c.verified_units as number), 0);
    derivation = cartonCounts
      .slice()
      .sort((a, b) => a.carton_index - b.carton_index)
      .map((c) => `Carton ${c.carton_index}: ${c.verified_units} verified`)
      .join("; ");
  } else if (coverageComplete && cartonsVerified && upc.value !== null && allCartonsCounted) {
    verifiedUnits = (cartons.value as number) * upc.value;
    derivation = `${cartons.value} cartons × ${upc.value} verified units per carton`;
  } else if (coverageComplete && unitsVisible.value !== null && allCartonsCounted) {
    verifiedUnits = unitsVisible.value;
    derivation = `${unitsVisible.value} units individually counted across all cartons`;
  }

  const totalBase = {
    check_key: "total_quantity" as CheckKey,
    expected_value: String(expected.qty_ordered),
    observed_value:
      verifiedUnits === null
        ? unitsVisible.value === null
          ? "Not verifiable"
          : `${unitsVisible.value} visible, not verified`
        : String(verifiedUnits),
    evidence_image_ids: unique([...cartonEvidence, ...quantityEvidence]),
    evidence_sufficiency: (verifiedUnits === null ? "insufficient" : "sufficient") as Sufficiency,
    confidence: upc.confidence ?? unitsVisible.confidence,
    ...meta,
  };

  let totalCheck: CheckResult;
  if (verifiedUnits === null) {
    totalCheck = {
      ...totalBase,
      verdict: "UNCERTAIN",
      detail: `Quantity evidence covers ${coverage === "none" ? "no" : coverage} of the shipment, so the received total cannot be verified. Visible units are not the same as verified units. ${vision.quantity_evidence.observation}`.trim(),
      recommended_action: "Open every carton and capture the contents so the full count can be verified.",
    };
  } else if (verifiedUnits === expected.qty_ordered) {
    totalCheck = {
      ...totalBase,
      verdict: "PASS",
      detail: `Verified quantity ${verifiedUnits} (${derivation}) matches ${expected.qty_ordered} ordered.`,
      recommended_action: null,
    };
  } else {
    const variance = verifiedUnits - expected.qty_ordered;
    totalCheck = {
      ...totalBase,
      verdict: "FAIL",
      detail: `Verified quantity ${verifiedUnits} (${derivation}) against ${expected.qty_ordered} ordered. Variance ${variance > 0 ? "+" : ""}${variance}.`,
      recommended_action: `Hold receiving record for review. Verified quantity is ${verifiedUnits} against ${expected.qty_ordered} ordered.`,
    };
  }

  return [cartonCheck, upcCheck, totalCheck];
}

// ---------------------------------------------------------------------------
// Colour / variant
// ---------------------------------------------------------------------------
function attributeCheck(
  key: "colour" | "variant",
  expectedValue: string | null,
  observation: { value: string | null; confidence: number | null; evidence_image_ids: string[]; observation: string },
  sufficiency: Sufficiency,
  meta: CheckMeta,
  action: string,
): CheckResult {
  const base = {
    check_key: key as CheckKey,
    expected_value: isUnspecified(expectedValue) ? "Not specified" : (expectedValue as string),
    observed_value: observation.value ?? "Not observable",
    confidence: observation.confidence,
    evidence_image_ids: observation.evidence_image_ids,
    evidence_sufficiency: sufficiency,
    ...meta,
  };

  if (isUnspecified(expectedValue)) {
    return {
      ...base,
      verdict: "PASS",
      evidence_sufficiency: "sufficient",
      detail: `The purchase-order line specifies no ${key}, so there is nothing to contradict.`,
      recommended_action: null,
    };
  }

  if (sufficiency === "insufficient" || !observation.value) {
    return {
      ...base,
      verdict: "UNCERTAIN",
      detail: `Evidence insufficient to verify ${key}. ${observation.observation}`.trim(),
      recommended_action: action,
    };
  }

  const expectedNorm = normalizeText(expectedValue);
  const observedNorm = normalizeText(observation.value);
  const matches =
    expectedNorm === observedNorm ||
    observedNorm.includes(expectedNorm) ||
    expectedNorm.includes(observedNorm) ||
    textSimilarity(expectedNorm, observedNorm) >= 0.5;

  return {
    ...base,
    verdict: matches ? "PASS" : "FAIL",
    detail: matches
      ? `Observed ${key} "${observation.value}" matches the specified "${expectedValue}". ${observation.observation}`.trim()
      : `Observed ${key} "${observation.value}" does not match the specified "${expectedValue}". ${observation.observation}`.trim(),
    recommended_action: matches ? null : `Hold for review: ${key} mismatch against the purchase-order specification.`,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------
function componentsCheck(
  expected: PoLineExpectation,
  vision: VisionResponse,
  meta: CheckMeta,
): CheckResult {
  const obs = vision.observations.components;
  const sufficiency = vision.evidence_sufficiency.components;
  const expectedList = expected.spec_components.filter((c) => !isUnspecified(c));

  const base = {
    check_key: "components" as CheckKey,
    expected_value: expectedList.length ? expectedList.join(", ") : "Not specified",
    observed_value: obs.value.length ? obs.value.join(", ") : "Not observable",
    confidence: obs.confidence,
    evidence_image_ids: obs.evidence_image_ids,
    evidence_sufficiency: sufficiency,
    ...meta,
  };

  if (expectedList.length === 0) {
    return {
      ...base,
      verdict: "PASS",
      evidence_sufficiency: "sufficient",
      detail: "The purchase-order line lists no separate components.",
      recommended_action: null,
    };
  }

  if (sufficiency === "insufficient") {
    return {
      ...base,
      verdict: "UNCERTAIN",
      detail: `Evidence insufficient to verify components. ${obs.observation || "Contents are not observable in the supplied images."} Hidden components are not treated as missing.`,
      recommended_action: "Open one unit and capture all components laid out in a single frame.",
    };
  }

  const observedNorm = obs.value.map((v) => normalizeText(v));
  const missing = expectedList.filter(
    (c) => !observedNorm.some((o) => o.includes(normalizeText(c)) || normalizeText(c).includes(o)),
  );

  if (missing.length === 0) {
    return {
      ...base,
      verdict: "PASS",
      detail: `All specified components are visible: ${expectedList.join(", ")}. ${obs.observation}`.trim(),
      recommended_action: null,
    };
  }

  return {
    ...base,
    verdict: "FAIL",
    detail: `Specified components not present in the opened unit: ${missing.join(", ")}. ${obs.observation}`.trim(),
    recommended_action: "Hold for review: the delivered unit is missing specified components.",
  };
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------
const DAMAGE_PATTERNS: { key: CheckKey; label: string; match: RegExp; source: "carton" | "unit" | "defect" }[] = [
  { key: "carton_crushing", label: "crushing", match: /crush|dent|deform|collaps/i, source: "carton" },
  { key: "carton_water_damage", label: "water damage", match: /water|damp|wet|stain|mould|mold/i, source: "carton" },
  { key: "carton_tears", label: "tears", match: /tear|rip|punctur|hole|split|gash/i, source: "carton" },
];

function damageChecks(vision: VisionResponse, meta: CheckMeta): CheckResult[] {
  const sufficiency = vision.evidence_sufficiency.damage;
  const carton = vision.observations.carton_damage;
  const unit = vision.observations.unit_damage;
  const defects = vision.observations.obvious_defects;

  const results: CheckResult[] = DAMAGE_PATTERNS.map((pattern) => {
    const hit = carton.types.filter((t) => pattern.match.test(t));
    const base = {
      check_key: pattern.key,
      expected_value: "No visible damage",
      observed_value: hit.length ? hit.join(", ") : sufficiency === "sufficient" ? "None visible" : "Not fully observable",
      confidence: carton.confidence,
      evidence_image_ids: carton.evidence_image_ids,
      evidence_sufficiency: sufficiency,
      ...meta,
    };

    if (hit.length > 0) {
      return {
        ...base,
        verdict: "FAIL" as Verdict,
        detail: `Carton ${pattern.label} observed: ${hit.join(", ")}. ${carton.observation}`.trim(),
        recommended_action: "Photograph the damage close-up and hold the record for a supplier claim.",
      };
    }
    if (sufficiency === "insufficient") {
      return {
        ...base,
        verdict: "UNCERTAIN" as Verdict,
        detail: `No ${pattern.label} is visible on the photographed surfaces, but the evidence does not cover the whole carton. Absence of visible damage is not proof that unphotographed sides are undamaged.`,
        recommended_action: "Capture the remaining carton sides, including the base.",
      };
    }
    return {
      ...base,
      verdict: "PASS" as Verdict,
      detail: `No ${pattern.label} visible on the photographed cartons. ${carton.observation}`.trim(),
      recommended_action: null,
    };
  });

  results.push(
    damageSummaryCheck("unit_damage", unit.types, unit, sufficiency, meta, "unit damage"),
    damageSummaryCheck("obvious_defect", defects.types, defects, sufficiency, meta, "obvious defect"),
  );

  return results;
}

function damageSummaryCheck(
  key: CheckKey,
  types: string[],
  obs: { confidence: number | null; evidence_image_ids: string[]; observation: string },
  sufficiency: Sufficiency,
  meta: CheckMeta,
  label: string,
): CheckResult {
  const base = {
    check_key: key,
    expected_value: "No visible damage",
    observed_value: types.length ? types.join(", ") : sufficiency === "sufficient" ? "None visible" : "Not fully observable",
    confidence: obs.confidence,
    evidence_image_ids: obs.evidence_image_ids,
    evidence_sufficiency: sufficiency,
    ...meta,
  };

  if (types.length > 0) {
    return {
      ...base,
      verdict: "FAIL",
      detail: `Observed ${label}: ${types.join(", ")}. ${obs.observation}`.trim(),
      recommended_action: "Quarantine the affected units and record the damage for the supplier claim.",
    };
  }
  if (sufficiency === "insufficient") {
    return {
      ...base,
      verdict: "UNCERTAIN",
      detail: `No ${label} visible, but the units were not photographed well enough to rule it out.`,
      recommended_action: "Capture a close-up of one unit from the shipment.",
    };
  }
  return {
    ...base,
    verdict: "PASS",
    detail: `No ${label} visible in the supplied unit photographs. ${obs.observation}`.trim(),
    recommended_action: null,
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
