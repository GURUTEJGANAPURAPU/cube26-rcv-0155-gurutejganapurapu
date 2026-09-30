import { NextResponse } from "next/server";

import { authenticate, fail, isResponse } from "@/lib/server/api";
import { validateRows } from "@/lib/po/import";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;
  const { db } = auth;

  const { data, error } = await db
    .from("purchase_orders")
    .select(
      "id, po_number, supplier, ordered_at, is_demo, created_at, purchase_order_lines(id, po_line, sku, product_title, qty_ordered, cartons_ordered, units_per_carton_ordered, unit_id)",
    )
    .order("created_at", { ascending: false });

  if (error) return fail(error.message, 500, "database_error");
  return NextResponse.json({ purchase_orders: data ?? [] });
}

export async function POST(request: Request) {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;
  const { db, session } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Request body must be JSON.");
  }

  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { lines?: unknown }).lines)
      ? (body as { lines: Record<string, unknown>[] }).lines
      : null;

  if (!rows || rows.length === 0) {
    return fail("Provide at least one purchase-order line in `lines`.");
  }

  const { lines, issues } = validateRows(rows as Record<string, unknown>[]);
  if (lines.length === 0) {
    return NextResponse.json(
      { error: "validation_failed", message: "No valid purchase-order lines were found.", issues },
      { status: 422 },
    );
  }

  const isDemo = Boolean((body as { is_demo?: boolean }).is_demo);
  let createdOrders = 0;
  let createdLines = 0;

  // Group by PO number + supplier so one import can carry several POs.
  const groups = new Map<string, typeof lines>();
  for (const line of lines) {
    const key = `${line.po_number}::${line.supplier}`;
    const existing = groups.get(key);
    if (existing) existing.push(line);
    else groups.set(key, [line]);
  }

  for (const [, groupLines] of groups) {
    const head = groupLines[0];
    const { data: order, error: orderError } = await db
      .from("purchase_orders")
      .upsert(
        {
          organization_id: session.organizationId,
          po_number: head.po_number,
          supplier: head.supplier,
          is_demo: isDemo,
        },
        { onConflict: "organization_id,po_number,supplier" },
      )
      .select("id")
      .single();

    if (orderError || !order) return fail(orderError?.message ?? "Could not save the purchase order.", 500, "database_error");
    createdOrders += 1;

    const { error: lineError, count } = await db
      .from("purchase_order_lines")
      .upsert(
        groupLines.map((line) => ({
          organization_id: session.organizationId,
          purchase_order_id: order.id,
          po_line: line.po_line,
          unit_id: line.unit_id || null,
          source_record_id: line.record_id || null,
          sku: line.sku,
          asin: line.asin || null,
          product_title: line.product_title,
          spec_colour: line.spec_colour || null,
          spec_variant: line.spec_variant || null,
          spec_components: line.spec_components,
          cartons_ordered: line.cartons_ordered,
          units_per_carton_ordered: line.units_per_carton_ordered,
          qty_ordered: line.qty_ordered,
          is_demo: isDemo,
        })),
        { onConflict: "organization_id,purchase_order_id,po_line", count: "exact" },
      );

    if (lineError) return fail(lineError.message, 500, "database_error");
    createdLines += count ?? groupLines.length;
  }

  return NextResponse.json({ purchase_orders: createdOrders, lines: createdLines, issues }, { status: 201 });
}
