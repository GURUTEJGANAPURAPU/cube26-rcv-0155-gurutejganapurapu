import { z } from "zod";

/**
 * Purchase-order ingestion: manual entry, CSV import and JSON import all
 * validate through the same schema, so a bad row is reported the same way
 * wherever it came from.
 */

const intFromAny = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === "number" ? v : Number.parseInt(v.trim(), 10);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a whole number" });
    return z.NEVER;
  }
  return n;
});

export const poLineInputSchema = z.object({
  record_id: z.string().trim().optional().nullable(),
  unit_id: z.string().trim().optional().nullable(),
  po_number: z.string().trim().min(1, "po_number is required"),
  po_line: intFromAny.pipe(z.number().int().min(1, "po_line must be 1 or greater")),
  supplier: z.string().trim().min(1, "supplier is required"),
  sku: z.string().trim().min(1, "sku is required"),
  asin: z.string().trim().optional().nullable(),
  product_title: z.string().trim().min(1, "product_title is required"),
  spec_colour: z.string().trim().optional().nullable(),
  spec_variant: z.string().trim().optional().nullable(),
  spec_components: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (!v) return [] as string[];
      const list = Array.isArray(v) ? v : v.split(";");
      return list.map((s) => s.trim()).filter((s) => s.length > 0);
    }),
  cartons_ordered: intFromAny.pipe(z.number().int().min(1, "cartons_ordered must be 1 or greater")),
  units_per_carton_ordered: intFromAny.pipe(
    z.number().int().min(1, "units_per_carton_ordered must be 1 or greater"),
  ),
  qty_ordered: intFromAny.pipe(z.number().int().min(1, "qty_ordered must be 1 or greater")),
});

export type PoLineInput = z.infer<typeof poLineInputSchema>;

export interface ImportIssue {
  row: number;
  field: string;
  message: string;
}

export interface ImportResult {
  lines: PoLineInput[];
  issues: ImportIssue[];
}

/** Minimal RFC4180-ish CSV parser: quoted fields, embedded commas, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

export function importFromCsv(text: string): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { lines: [], issues: [{ row: 0, field: "file", message: "The file has no data rows." }] };
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const objects = rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((key, idx) => {
      obj[key] = (cells[idx] ?? "").trim();
    });
    return obj;
  });
  return validateRows(objects);
}

export function importFromJson(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { lines: [], issues: [{ row: 0, field: "file", message: "The file is not valid JSON." }] };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { lines?: unknown }).lines)
      ? (parsed as { lines: unknown[] }).lines
      : null;
  if (!list) {
    return {
      lines: [],
      issues: [{ row: 0, field: "file", message: "Expected a JSON array of PO lines, or an object with a `lines` array." }],
    };
  }
  return validateRows(list as Record<string, unknown>[]);
}

export function validateRows(rows: Record<string, unknown>[]): ImportResult {
  const lines: PoLineInput[] = [];
  const issues: ImportIssue[] = [];

  rows.forEach((raw, index) => {
    const candidate = {
      ...raw,
      spec_components: raw.spec_components ?? raw["spec_components"] ?? "",
    };
    const result = poLineInputSchema.safeParse(candidate);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          row: index + 2,
          field: issue.path.join(".") || "row",
          message: issue.message,
        });
      }
      return;
    }

    const line = result.data;
    const derived = line.cartons_ordered * line.units_per_carton_ordered;
    if (derived !== line.qty_ordered) {
      issues.push({
        row: index + 2,
        field: "qty_ordered",
        message: `qty_ordered (${line.qty_ordered}) does not equal cartons_ordered × units_per_carton_ordered (${derived}). Imported as given — recorded as a finding, not silently corrected.`,
      });
    }
    lines.push(line);
  });

  return { lines, issues };
}
