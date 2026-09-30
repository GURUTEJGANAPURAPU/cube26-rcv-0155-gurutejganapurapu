import type { LocalSignals, PoLineExpectation } from "@/lib/types";

/**
 * Versioned inspection prompt. Bump PROMPT_VERSION on any wording change:
 * the version is persisted with every inspection so results stay attributable.
 */
export const PROMPT_VERSION = "receiving-inspection/1.0.1";

export const SYSTEM_INSTRUCTION = `You are a visual receiving inspection observer in a warehouse goods-in process.

Your only job is to report what is visible or readable in the supplied photographs.
You do not decide whether the shipment passes. Application code does that.

Hard rules:
- Report only what is visible or readable. Never guess.
- Never invent a value. If something is not visible, return null and say so in the observation.
- Never infer quantity that you cannot see. Hidden units are not counted.
- Never infer hidden components. A sealed carton means components are not observable.
- Do not infer a SKU from generic product appearance when no label is readable.
- Do not state a colour when lighting, glare or white balance make it ambiguous.
- Do not state a variant when variants are visually similar and no label confirms it.
- Do not classify damage you cannot see.
- Absence of visible damage on the photographed side is NOT evidence that hidden sides are undamaged. If sides are unphotographed, mark damage evidence insufficient.
- Every non-null observation must list the image ids it came from.
- When signals conflict (for example a label SKU that does not match the visible product), list the conflict in contradictions rather than picking a winner.
- Mark an evidence category insufficient whenever a reliable observation is impossible.
- Return only the structured JSON object. No prose, no markdown, no commentary.

Confidence is your own calibrated certainty in the observation, between 0 and 1. Use null when you did not observe the attribute at all.`;

export function buildUserPrompt(
  expected: PoLineExpectation,
  signals: LocalSignals,
  images: { image_id: string; capture_type: string; filename: string | null }[],
): string {
  const lines: string[] = [];

  lines.push("PURCHASE ORDER CONTEXT (expected values, for comparison only — do not copy them into observations):");
  lines.push(
    JSON.stringify(
      {
        po_number: expected.po_number,
        po_line: expected.po_line,
        supplier: expected.supplier,
        sku: expected.sku,
        asin: expected.asin,
        product_title: expected.product_title,
        expected_colour: expected.spec_colour,
        expected_variant: expected.spec_variant,
        expected_components: expected.spec_components,
        cartons_ordered: expected.cartons_ordered,
        units_per_carton_ordered: expected.units_per_carton_ordered,
        qty_ordered: expected.qty_ordered,
      },
      null,
      2,
    ),
  );

  lines.push("");
  lines.push("IMAGES SUPPLIED (in the order they appear after this text):");
  for (const img of images) {
    lines.push(`- image_id=${img.image_id} capture_type=${img.capture_type} filename=${img.filename ?? "n/a"}`);
  }

  lines.push("");
  lines.push("LOCAL SUPPORTING SIGNALS (extracted in the browser, unverified, may be wrong or empty):");
  lines.push(
    JSON.stringify(
      {
        ocr_text: signals.ocr_text,
        barcode_values: signals.barcode_values,
        image_quality_flags: signals.image_quality_flags,
      },
      null,
      2,
    ),
  );

  lines.push("");
  lines.push(
    [
      "TASK:",
      "Inspect every supplied image and fill the response schema.",
      "1. Read any labels, SKUs, ASINs and barcodes that are legible.",
      "2. Count cartons only if the whole shipment is in frame and countable.",
      "3. Count units only where the carton interior is genuinely visible. Set quantity_evidence.coverage to 'complete' only when every ordered carton has been opened and counted in the photographs, 'partial' when only some are countable, 'none' when no count is possible. When you can count carton by carton, fill quantity_evidence.carton_counts (carton_index, verified_units, fully_counted). Visible units are not the same as verified units.",
      "4. Report colour, variant and components only when visible.",
      "5. Report carton damage, unit damage and obvious defects separately, by type (for example crushing, water, tear, dent, scratch, stain, deformation).",
      "6. List any contradictions between the label, product appearance, OCR and barcode signals.",
      "7. List the views that would resolve remaining ambiguity in missing_views (for example 'clearer carton label close-up', 'opposite side of carton 2').",
    ].join("\n"),
  );

  return lines.join("\n");
}
