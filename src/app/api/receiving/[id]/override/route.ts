import { NextResponse } from "next/server";
import { z } from "zod";

import { authenticate, fail, isResponse } from "@/lib/server/api";
import { CHECK_KEYS } from "@/lib/types";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    check_key: z.enum(CHECK_KEYS).nullable(),
    new_verdict: z.string(),
    reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(1000),
  })
  .superRefine((v, ctx) => {
    const allowed = v.check_key ? ["PASS", "FAIL", "UNCERTAIN"] : ["PASS", "EXCEPTION", "UNCERTAIN"];
    if (!allowed.includes(v.new_verdict)) {
      ctx.addIssue({ code: "custom", message: `new_verdict must be one of ${allowed.join(", ")}.` });
    }
  });

/**
 * Appends an operator override. The agent's original verdict stays untouched in
 * inspection_checks / receiving_records; the override is a separate row.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;
  const { db, session } = auth;
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Request body must be JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422, "validation_failed");
  const { check_key, new_verdict, reason } = parsed.data;

  const { data: record } = await db.from("receiving_records").select("id, status, decision").eq("id", id).maybeSingle();
  if (!record) return fail("Receiving record not found in your organisation.", 404, "not_found");
  if (record.status !== "complete") return fail("Overrides apply to completed inspections only.", 409, "not_complete");

  let original: string | null = record.decision;
  if (check_key) {
    const { data: check } = await db
      .from("inspection_checks")
      .select("verdict")
      .eq("receiving_record_id", id)
      .eq("check_key", check_key)
      .maybeSingle();
    if (!check) return fail("That check was not part of this inspection.", 404, "not_found");
    original = check.verdict;
  }

  // The original verdict recorded is the latest effective one, so the history reads as a chain.
  const { data: previous } = await db
    .from("overrides")
    .select("new_verdict")
    .eq("receiving_record_id", id)
    .is("check_key", check_key)
    .order("created_at", { ascending: false })
    .limit(1);
  const effective = previous?.[0]?.new_verdict ?? original ?? "PENDING";
  if (effective === new_verdict) return fail("The verdict is already " + new_verdict + ".", 409, "no_change");

  const { data, error } = await db
    .from("overrides")
    .insert({
      organization_id: session.organizationId,
      receiving_record_id: id,
      check_key,
      original_verdict: effective,
      new_verdict,
      reason,
      operator_id: session.userId,
      operator_label: session.operatorLabel,
    })
    .select("*")
    .single();
  if (error) return fail(error.message, 500, "database_error");
  return NextResponse.json({ override: data }, { status: 201 });
}
