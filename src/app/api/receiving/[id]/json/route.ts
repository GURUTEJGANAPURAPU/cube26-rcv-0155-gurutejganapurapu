import { NextResponse } from "next/server";

import { authenticate, fail, isResponse } from "@/lib/server/api";
import { loadEvidenceRecord } from "@/lib/server/receiving";

export const dynamic = "force-dynamic";

/** Same payload as /evidence, served as a download for hand-off. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;
  const { id } = await context.params;

  const record = await loadEvidenceRecord(auth.db, id, auth.session);
  if (!record) return fail("Receiving record not found in your organisation.", 404, "not_found");

  return new NextResponse(JSON.stringify(record, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="receiving-${record.record_id}.json"`,
    },
  });
}
