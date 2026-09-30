import { z } from "zod";

/**
 * Strict schema for the single multimodal inspection response.
 * The model reports observations only. It never returns verdicts.
 */

const sufficiency = z.enum(["sufficient", "insufficient"]);

const confidence = z.number().min(0).max(1).nullable();

const base = {
  confidence,
  evidence_image_ids: z.array(z.string()).default([]),
  observation: z.string().default(""),
};

const stringObservation = z.object({ value: z.string().nullable(), ...base });
const numberObservation = z.object({ value: z.number().int().nullable(), ...base });
const listObservation = z.object({ value: z.array(z.string()).default([]), ...base });
const damageObservation = z.object({ types: z.array(z.string()).default([]), ...base });

export const visionResponseSchema = z.object({
  evidence_sufficiency: z.object({
    identity: sufficiency,
    quantity: sufficiency,
    variant: sufficiency,
    colour: sufficiency,
    components: sufficiency,
    damage: sufficiency,
  }),
  observations: z.object({
    sku: stringObservation,
    product_title: stringObservation,
    asin: stringObservation,
    cartons_visible: numberObservation,
    units_visible: numberObservation,
    units_per_carton_visible: numberObservation,
    colour: stringObservation,
    variant: stringObservation,
    components: listObservation,
    carton_damage: damageObservation,
    unit_damage: damageObservation,
    obvious_defects: damageObservation,
  }),
  quantity_evidence: z.object({
    /** How much of the shipment the quantity photographs actually cover. */
    coverage: z.enum(["complete", "partial", "none"]),
    cartons_fully_counted: z.number().int().nullable(),
    observation: z.string().default(""),
    carton_counts: z
      .array(
        z.object({
          carton_index: z.number().int(),
          verified_units: z.number().int().nullable(),
          fully_counted: z.boolean(),
          evidence_image_ids: z.array(z.string()).default([]),
        }),
      )
      .default([]),
  }),
  /** Explicit conflicts between signals, e.g. label SKU vs product appearance. */
  contradictions: z.array(z.string()).default([]),
  /** Views the operator should capture to resolve remaining ambiguity. */
  missing_views: z.array(z.string()).default([]),
});

export type VisionResponse = z.infer<typeof visionResponseSchema>;

/**
 * Gemini responseSchema (OpenAPI subset). Kept in lockstep with the Zod schema
 * above; the Zod parse remains the authority and rejects anything malformed.
 */
export const geminiResponseSchema = {
  type: "object",
  properties: {
    evidence_sufficiency: {
      type: "object",
      properties: Object.fromEntries(
        ["identity", "quantity", "variant", "colour", "components", "damage"].map((k) => [
          k,
          { type: "string", enum: ["sufficient", "insufficient"] },
        ]),
      ),
      required: ["identity", "quantity", "variant", "colour", "components", "damage"],
    },
    observations: {
      type: "object",
      properties: {
        sku: valueObject("string"),
        product_title: valueObject("string"),
        asin: valueObject("string"),
        cartons_visible: valueObject("integer"),
        units_visible: valueObject("integer"),
        units_per_carton_visible: valueObject("integer"),
        colour: valueObject("string"),
        variant: valueObject("string"),
        components: listObject(),
        carton_damage: typesObject(),
        unit_damage: typesObject(),
        obvious_defects: typesObject(),
      },
      required: [
        "sku",
        "product_title",
        "asin",
        "cartons_visible",
        "units_visible",
        "units_per_carton_visible",
        "colour",
        "variant",
        "components",
        "carton_damage",
        "unit_damage",
        "obvious_defects",
      ],
    },
    quantity_evidence: {
      type: "object",
      properties: {
        coverage: { type: "string", enum: ["complete", "partial", "none"] },
        cartons_fully_counted: { type: "integer", nullable: true },
        observation: { type: "string" },
        carton_counts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              carton_index: { type: "integer" },
              verified_units: { type: "integer", nullable: true },
              fully_counted: { type: "boolean" },
              evidence_image_ids: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      required: ["coverage", "cartons_fully_counted", "observation"],
    },
    contradictions: { type: "array", items: { type: "string" } },
    missing_views: { type: "array", items: { type: "string" } },
  },
  required: [
    "evidence_sufficiency",
    "observations",
    "quantity_evidence",
    "contradictions",
    "missing_views",
  ],
} as const;

function commonProps() {
  return {
    confidence: { type: "number", nullable: true },
    evidence_image_ids: { type: "array", items: { type: "string" } },
    observation: { type: "string" },
  };
}

function valueObject(valueType: "string" | "integer") {
  return {
    type: "object",
    properties: { value: { type: valueType, nullable: true }, ...commonProps() },
    required: ["value", "confidence", "evidence_image_ids", "observation"],
  };
}

function listObject() {
  return {
    type: "object",
    properties: { value: { type: "array", items: { type: "string" } }, ...commonProps() },
    required: ["value", "confidence", "evidence_image_ids", "observation"],
  };
}

function typesObject() {
  return {
    type: "object",
    properties: { types: { type: "array", items: { type: "string" } }, ...commonProps() },
    required: ["types", "confidence", "evidence_image_ids", "observation"],
  };
}
