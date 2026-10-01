"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";

import { ArrivexMark, ArrivexWordmark } from "@/components/brand";
import { INTRO_FLAG } from "@/components/intro";
import { ErrorNote } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

function SignInForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function useDemoAccount(
    demoEmail: string,
    demoPassword: string
  ) {
    setEmail(demoEmail);
    setPassword(demoPassword);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient().auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setBusy(false);
      return setError(error.message);
    }

    const next = params.get("next");
    const target =
      next && next.startsWith("/") && !next.startsWith("//")
        ? next
        : "/receiving";

    sessionStorage.setItem(INTRO_FLAG, "1");

    window.location.assign(target);
  }

  return (
    <form
      onSubmit={submit}
      className="card ax-fade w-full max-w-sm space-y-4 p-6 shadow-sm"
      aria-busy={busy}
    >
      <div>
        <h1 className="text-lg font-semibold">Welcome to Arrivex</h1>
        <p className="mt-1 text-sm text-muted">
          Sign in to your receiving workspace.
        </p>
      </div>

      {error && (
        <div role="alert">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <label className="block space-y-1">
        <span className="label">Email</span>
        <input
          className="input"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>

      <label className="block space-y-1">
        <span className="label">Password</span>
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>

      {/* Demo Accounts */}
      <div className="rounded-md border border-line bg-sunken p-3">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
          Demo access
        </div>

        <div className="space-y-3 text-xs">
          {/* Operator Alpha */}
          <div className="rounded-md border border-line/60 bg-surface p-3">
            <div className="mb-2 font-semibold">Operator Alpha</div>

            <div className="space-y-1">
              <div>
                <span className="text-muted">Email:</span>{" "}
                <span className="font-mono">
                  operator.alpha@demo.invalid
                </span>
              </div>

              <div>
                <span className="text-muted">Password:</span>{" "}
                <span className="font-mono">
                  ReceivingDemo2026!
                </span>
              </div>
            </div>

            <button
              type="button"
              className="btn mt-3 w-full"
              onClick={() =>
                useDemoAccount(
                  "operator.alpha@demo.invalid",
                  "ReceivingDemo2026!"
                )
              }
            >
              Use Operator Alpha
            </button>
          </div>

          {/* Operator Bravo */}
          <div className="rounded-md border border-line/60 bg-surface p-3">
            <div className="mb-2 font-semibold">Operator Bravo</div>

            <div className="space-y-1">
              <div>
                <span className="text-muted">Email:</span>{" "}
                <span className="font-mono">
                  operator.bravo@demo.invalid
                </span>
              </div>

              <div>
                <span className="text-muted">Password:</span>{" "}
                <span className="font-mono">
                  ReceivingDemo2026!
                </span>
              </div>
            </div>

            <button
              type="button"
              className="btn mt-3 w-full"
              onClick={() =>
                useDemoAccount(
                  "operator.bravo@demo.invalid",
                  "ReceivingDemo2026!"
                )
              }
            >
              Use Operator Bravo
            </button>
          </div>
        </div>
      </div>

      <button className="btn btn-primary w-full" disabled={busy}>
        {busy && <Loader2 size={14} className="animate-spin" />}
        {busy ? "Signing in…" : "Sign in"}
      </button>

      <p className="text-xs text-muted">
        Accounts are created by an administrator. There is no public
        sign-up. Demo workspaces are labelled DEMO after sign-in.
      </p>
    </form>
  );
}

export default function SignInPage() {
  return (
    <div className="grid min-h-screen md:grid-cols-[1.1fr_1fr]">
      <section className="relative flex flex-col justify-between overflow-hidden bg-ink p-8 text-accent-ink md:p-12">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        />

        <div className="relative flex items-center gap-3">
          <ArrivexMark size={44} />
          <ArrivexWordmark className="text-xl" />
        </div>

        <div className="relative my-10 max-w-md md:my-0">
          <h2 className="text-3xl font-semibold leading-tight md:text-4xl">
            Inspect every arrival.
          </h2>

          <p className="mt-4 text-sm leading-relaxed opacity-75">
            Photograph each delivery in guided views. Arrivex reports what
            is visible, compares it with the purchase-order line, and
            records a PASS, EXCEPTION or UNCERTAIN decision with the
            evidence behind it.
          </p>

          <ol className="mt-6 grid grid-cols-3 gap-2 font-mono text-[11px] uppercase tracking-wide opacity-80">
            {["Expected", "Observed", "Decision"].map((s, i) => (
              <li
                key={s}
                className="border-t border-current/30 pt-2"
              >
                <span className="opacity-50">0{i + 1}</span> {s}
              </li>
            ))}
          </ol>
        </div>

        <p className="relative flex items-center gap-2 text-xs opacity-70">
          <ShieldCheck size={14} /> Visual inspection backed by evidence.
        </p>
      </section>

      <section className="flex items-center justify-center px-4 py-10">
        <Suspense>
          <SignInForm />
        </Suspense>
      </section>
    </div>
  );
}