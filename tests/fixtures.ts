import type { VisionResponse } from "@/lib/ai/vision-schema";
import type { PoLineExpectation } from "@/lib/types";

export const expected: PoLineExpectation = {
  po_number: "PO-7000",
  po_line: 3,
  unit_id: "UNIT-0002",
  supplier: "Supplier Coastal (DUMMY)",
  sku: "SKU-CANDLE-3",
  asin: "B0DUMMY964",
  product_title: "Soy Candle Trio",
  spec_colour: "cream",
  spec_variant: "3-pack",
  spec_components: ["candle x3", "gift box"],
  cartons_ordered: 2,
  units_per_carton_ordered: 12,
  qty_ordered: 24,
};

const obs = <T,>(
  value: T,
  ids = ["img-1"]
) => ({
  value,
  confidence: 0.9,
  evidence_image_ids: ids,
  observation: "visible",
});

const dmg = (types: string[] = []) => ({
  types,
  confidence: 0.9,
  evidence_image_ids: ["img-1"],
  observation: types.length
    ? "damage visible"
    : "no damage visible",
});

/** A clean, fully-evidenced observation set that matches `expected`. */
export function cleanVision(): VisionResponse {
  return {
    evidence_sufficiency: {
      identity: "sufficient",
      quantity: "sufficient",
      variant: "sufficient",
      colour: "sufficient",
      components: "sufficient",
      damage: "sufficient",
    },

    observations: {
      sku: obs("SKU-CANDLE-3"),
      product_title: obs("Soy Candle Trio"),
      asin: obs("B0DUMMY964"),
      cartons_visible: obs(2),
      units_visible: obs(24),
      units_per_carton_visible: obs(12),
      colour: obs("cream"),
      variant: obs("3-pack"),
      components: obs(["candle x3", "gift box"]),
      carton_damage: dmg(),
      unit_damage: dmg(),
      obvious_defects: dmg(),
    },

    quantity_evidence: {
      coverage: "complete",
      cartons_fully_counted: 2,
      observation: "both cartons open",
      carton_counts: [
        {
          carton_index: 1,
          verified_units: null,
          fully_counted: true,
          evidence_image_ids: [],
        },
        {
          carton_index: 2,
          verified_units: null,
          fully_counted: true,
          evidence_image_ids: [],
        },
      ],
    },

    contradictions: [],

    missing_views: [],
  };
}

export const meta = {
  model_version: "test-model",
  prompt_version: "test-prompt",
  latency_ms: 10,
};