import { NextResponse } from "next/server";

import { authenticate, fail, isResponse } from "@/lib/server/api";
import { loadEvidenceRecord } from "@/lib/server/receiving";
import { verifyContentHash } from "@/lib/evidence/record";

export const dynamic = "force-dynamic";

/** Full evidence record, including checks, images and override history. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;
  const { id } = await context.params;

  const record = await loadEvidenceRecord(auth.db, id, auth.session);
  if (!record) return fail("Receiving record not found in your organisation.", 404, "not_found");

  return NextResponse.json({ ...record, content_hash_verified: await verifyContentHash(record) });
}
