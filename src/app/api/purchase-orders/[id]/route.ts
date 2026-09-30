import { NextResponse } from "next/server";

import { authenticate, fail, isResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;
  const { id } = await context.params;

  const { data, error } = await auth.db
    .from("purchase_orders")
    .select("*, purchase_order_lines(*)")
    .eq("id", id)
    .maybeSingle();

  if (error) return fail(error.message, 500, "database_error");
  if (!data) return fail("Purchase order not found in your organisation.", 404, "not_found");
  return NextResponse.json({ purchase_order: data });
}
