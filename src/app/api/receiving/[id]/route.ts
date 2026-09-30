import { NextResponse } from "next/server";

import { authenticate, fail, isResponse } from "@/lib/server/api";
import { loadEvidenceRecord } from "@/lib/server/receiving";

export const dynamic = "force-dynamic";

/** Stable, UI-independent read for downstream pods. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;
  const { id } = await context.params;

  const record = await loadEvidenceRecord(auth.db, id, auth.session);
  if (!record) return fail("Receiving record not found in your organisation.", 404, "not_found");

  return NextResponse.json({
    record_id: record.record_id,
    schema_version: record.schema_version,
    subject: record.subject,
    status: record.status,
    outcome: record.outcome,
    captured_at: record.captured_at,
    agent: record.agent,
    content_hash: record.content_hash,
    is_demo: record.is_demo,
  });
}
