import { NextResponse } from "next/server";

import { createServerSupabase, getSessionContext, type SessionContext } from "@/lib/supabase/server";

export type Authed = {
  session: SessionContext;
  db: Awaited<ReturnType<typeof createServerSupabase>>;
};

/** Resolves the caller. Every API route starts here; there are no public routes. */
export async function authenticate(): Promise<Authed | NextResponse> {
  const session = await getSessionContext();
  if (!session) {
    return NextResponse.json(
      { error: "unauthorized", message: "Sign in to use the Receiving Manager API." },
      { status: 401 },
    );
  }
  const db = await createServerSupabase();
  return { session, db };
}

export function isResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}

export function fail(message: string, status = 400, code = "bad_request") {
  return NextResponse.json({ error: code, message }, { status });
}
