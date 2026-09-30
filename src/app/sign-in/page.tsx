"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

import { ErrorNote } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

function SignInForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await createClient().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setError(error.message);
    const next = params.get("next");
    const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/receiving";
    // A full navigation, not router.replace(): the middleware must see the
    // freshly written session cookie on a real request, otherwise it bounces
    // the operator straight back to this page after a successful sign-in.
    window.location.assign(target);
  }

  return (
    <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Receiving Manager</h1>
        <p className="mt-1 text-sm text-muted">Sign in with your warehouse account.</p>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <label className="block space-y-1">
        <span className="label">Email</span>
        <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="label">Password</span>
        <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      <p className="text-xs text-muted">Accounts are created by an administrator. There is no public sign-up.</p>
    </form>
  );
}

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Suspense>
        <SignInForm />
      </Suspense>
    </div>
  );
}
