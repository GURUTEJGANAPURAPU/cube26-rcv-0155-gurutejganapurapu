import { NextResponse } from "next/server";

import { authenticate, fail, isResponse } from "@/lib/server/api";
import { performInspection } from "@/lib/server/receiving";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/** Runs the single multimodal inspection for this receiving unit. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;
  const { id } = await context.params;

  const { data: record } = await auth.db.from("receiving_records").select("id, status").eq("id", id).maybeSingle();
  if (!record) return fail("Receiving record not found in your organisation.", 404, "not_found");
  if (record.status === "processing") return fail("An inspection is already running for this unit.", 409, "conflict");
  if (record.status === "complete") {
    return fail("This unit already has a decision. Use an override or explicit retry instead.", 409, "already_complete");
  }

  const result = await performInspection(auth.db, auth.session, id);
  return NextResponse.json(result, { status: result.http_status });
}
