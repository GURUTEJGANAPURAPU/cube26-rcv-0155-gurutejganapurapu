import { NextResponse } from "next/server";
import { z } from "zod";

import { authenticate, fail, isResponse } from "@/lib/server/api";
import { loadExpectation } from "@/lib/server/receiving";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  po_line_id: z.string().uuid("po_line_id must be a valid id"),
  captured_at: z.string().datetime().optional(),
});

export async function GET(request: Request) {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;

  const url = new URL(request.url);
  const decision = url.searchParams.get("decision");
  const search = url.searchParams.get("q");

  let query = auth.db
    .from("receiving_records")
    .select("id, unit_id, po_number, po_line, supplier, sku, status, decision, captured_at, created_at, is_demo, recommended_action, content_hash")
    .order("created_at", { ascending: false })
    .limit(200);

  if (decision && decision !== "ALL") query = query.eq("decision", decision);
  if (search) {
    const term = `%${search}%`;
    query = query.or(
      `po_number.ilike.${term},sku.ilike.${term},unit_id.ilike.${term},supplier.ilike.${term}`,
    );
  }

  const { data, error } = await query;
  if (error) return fail(error.message, 500, "database_error");
  return NextResponse.json({ records: data ?? [] });
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

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422, "validation_failed");

  const expectation = await loadExpectation(db, parsed.data.po_line_id);
  if (!expectation) return fail("That purchase-order line is not available in your organisation.", 404, "not_found");

  const { data, error } = await db
    .from("receiving_records")
    .insert({
      organization_id: session.organizationId,
      po_line_id: parsed.data.po_line_id,
      unit_id: expectation.unit_id,
      po_number: expectation.po_number,
      po_line: expectation.po_line,
      supplier: expectation.supplier,
      sku: expectation.sku,
      status: "draft",
      captured_at: parsed.data.captured_at ?? new Date().toISOString(),
      operator_id: session.userId,
      operator_label: session.operatorLabel,
    })
    .select("id")
    .single();

  if (error || !data) return fail(error?.message ?? "Could not create the receiving record.", 500, "database_error");
  return NextResponse.json({ id: data.id }, { status: 201 });
}
