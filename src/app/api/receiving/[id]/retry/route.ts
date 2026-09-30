import { NextResponse } from "next/server";

import { authenticate, fail, isResponse } from "@/lib/server/api";
import { performInspection } from "@/lib/server/receiving";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/**
 * Retries a pending inspection. The attempt limit and daily quota are enforced
 * inside performInspection; the previously saved capture is reused unchanged.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;
  const { id } = await context.params;

  const { data: record } = await auth.db.from("receiving_records").select("id, status").eq("id", id).maybeSingle();
  if (!record) return fail("Receiving record not found in your organisation.", 404, "not_found");
  if (record.status !== "pending" && record.status !== "draft") {
    return fail("Only pending or unsubmitted units can be retried.", 409, "not_retryable");
  }

  const result = await performInspection(auth.db, auth.session, id);
  return NextResponse.json(result, { status: result.http_status });
}
